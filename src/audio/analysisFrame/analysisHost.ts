// 解析用フレームの管理（親ウィンドウ側、Phase 09）。
// 再生エンジンの処理計画（重低音・空間のラウドネス合わせ）の解析を、ページではなく iframe（analysis-frame.html）で行う。
// Chrome は AudioWorklet を読み込んだ OfflineAudioContext を解放しないため、以前はページ内の解析の文脈が残り続けた
// （3 分の音源で 4 プリセットを一度ずつ選ぶと数百 MB。書き出しの後のメモリの一時的な保持（test:video グループ 88）の条件でもあった）。
// フレームは、しばらく使わない・文脈を多く作った・書き出しを始める・音源を読み替える、のいずれかで削除する（文書ごと解放される）。
//
// 監視: 1 回の呼び出しが上限の時間内に終わらなければフレームごと破棄し、新しいフレームで 1 回だけやり直す（無限に繰り返さない）。
// Edge で HRTF の OfflineAudioContext が止まる問題（Phase 07、原因は未確定）への備え。メインスレッドごと止まった場合は検出できない。

import type { PlanOptions, ProcessingPlan, SourceAnalysis } from '../analysis'
import { addAnalysisRenders } from '../analysisStats'
import type { BassParams } from '../bassSpec'
import { keepHrtfLoaded } from '../hrtfKeeper'
import type { SpatialPlan, SpatialPlanOptions } from '../spatial/spatialAnalysis'
import type { SpatialParams } from '../spatial/spatialSpec'
import type { StereoMetrics } from '../stereoMetrics'
import type { AnalysisCall, AnalysisFrameMessage, AnalysisParentMessage } from './analysisProtocol'

/** 最後の解析からこの時間使わなければフレームを削除する（ms）。スライダー操作・プリセットの切替の続く間は使い回す */
export const ANALYSIS_FRAME_IDLE_MS = 3000
/** フレームで作った解析用の文脈がこの数に達したら、次の呼び出しの前に作り直す（1 つのフレームに溜めすぎない） */
export const ANALYSIS_FRAME_MAX_CONTEXTS = 24
/** 1 回の呼び出しの上限（ms）= 基本 + 抜粋 1 秒あたり。通常は数百 ms〜数秒 */
const CALL_BASE_MS = 45000
const CALL_PER_SECOND_MS = 3000

export class AnalysisTimeoutError extends Error {
  constructor(kind: string, ms: number, attempts: number) {
    super(`解析（${kind}）が ${Math.round(ms / 1000)} 秒で終わらなかったため中止しました${attempts > 1 ? `（新しいフレームで ${attempts - 1} 回やり直しても同じでした）` : ''}。`)
    this.name = 'AnalysisTimeoutError'
  }
}

/** 解析用フレームの数（試験用） */
export const analysisFrameCount = () => document.querySelectorAll('iframe[data-csx-analysis]').length

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

export class AnalysisHost {
  private frame: HTMLIFrameElement | null = null
  private ready: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readonly frameUrl: string
  /** 抜粋の ID（AudioBuffer ごとに 1 つ） */
  private readonly ids = new WeakMap<AudioBuffer, string>()
  /** 今のフレームに送った抜粋 */
  private sent = new Set<string>()
  private pending = new Map<number, Pending>()
  private nextId = 1
  private active = 0
  private contexts = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private listening = false
  private readonly onMessage = (e: MessageEvent<AnalysisFrameMessage>) => {
    if (!this.frame || e.source !== this.frame.contentWindow || e.origin !== location.origin) return
    const m = e.data
    if (m.type === 'ready') {
      this.readyResolve?.()
      return
    }
    const p = this.pending.get(m.callId)
    if (!p) return
    this.pending.delete(m.callId)
    if (m.type === 'result') {
      this.contexts += m.renders
      addAnalysisRenders(m.renders, m.workletRenders)
      p.resolve(m.value)
    } else {
      const err = new Error(m.message)
      err.name = m.name
      p.reject(err)
    }
  }

  constructor(frameUrl = `${import.meta.env.BASE_URL}analysis-frame.html`) {
    this.frameUrl = frameUrl
  }

  analyzeSource(excerpt: AudioBuffer): Promise<SourceAnalysis> {
    return this.call(excerpt, (id) => ({ kind: 'analyzeSource', excerpt: id })) as Promise<SourceAnalysis>
  }

  planProcessing(excerpt: AudioBuffer, source: SourceAnalysis, params: BassParams, opts: PlanOptions): Promise<ProcessingPlan> {
    return this.call(excerpt, (id) => ({ kind: 'planProcessing', excerpt: id, source, params, opts })) as Promise<ProcessingPlan>
  }

  analyzeSpatialSource(excerpt: AudioBuffer): Promise<StereoMetrics> {
    return this.call(excerpt, (id) => ({ kind: 'analyzeSpatialSource', excerpt: id })) as Promise<StereoMetrics>
  }

  planSpatial(excerpt: AudioBuffer, before: StereoMetrics, params: SpatialParams, opts: SpatialPlanOptions): Promise<SpatialPlan> {
    // HRTF を使う解析の前に、そのサンプルレートの HRTF のデータを保持する（Edge で止まる問題の対策。書き出しと同じ）
    keepHrtfLoaded(excerpt.sampleRate)
    return this.call(excerpt, (id) => ({ kind: 'planSpatial', excerpt: id, before, params, opts })) as Promise<SpatialPlan>
  }

  /** フレームを今すぐ削除する（音源の読み替え・破棄）。実行中の呼び出しは中止（エラー）になる */
  release(): void {
    this.destroy(new Error('解析を中止しました'))
  }

  /** 実行中の呼び出しがなければ今すぐ削除する（書き出しの前。書き出しのメモリに解析の文脈を重ねない） */
  releaseIfIdle(): void {
    if (this.active === 0) this.destroy(null)
  }

  dispose(): void {
    this.release()
    if (this.listening) window.removeEventListener('message', this.onMessage)
    this.listening = false
  }

  private idOf(buffer: AudioBuffer): string {
    let id = this.ids.get(buffer)
    if (!id) {
      id = `x${this.nextId++}`
      this.ids.set(buffer, id)
    }
    return id
  }

  private async call(excerpt: AudioBuffer, make: (id: string) => AnalysisCall): Promise<unknown> {
    const id = this.idOf(excerpt)
    const call = make(id)
    const limit = CALL_BASE_MS + CALL_PER_SECOND_MS * excerpt.duration
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.active++
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.callOnce(excerpt, id, call, limit)
        } catch (e) {
          if (!(e instanceof AnalysisTimeoutError)) throw e
          console.warn('[CINEMA SONIC X] analysis-timeout', JSON.stringify({ kind: call.kind, attempt, limitMs: Math.round(limit), sampleRate: excerpt.sampleRate, seconds: +excerpt.duration.toFixed(2) }))
          // 止まったフレームは破棄する（同じフレームの他の呼び出しも中止）
          this.destroy(e)
          if (attempt >= 2) throw new AnalysisTimeoutError(call.kind, limit, attempt)
        }
      }
    } finally {
      this.active--
      this.scheduleRelease()
    }
  }

  private async callOnce(excerpt: AudioBuffer, id: string, call: AnalysisCall, limit: number): Promise<unknown> {
    // 文脈を多く作ったフレームは、新しい呼び出しの前に作り直す（他の呼び出しが実行中なら待たずにそのまま使う）
    if (this.frame && this.contexts >= ANALYSIS_FRAME_MAX_CONTEXTS && this.pending.size === 0) this.destroy(null)
    const frame = await this.ensureFrame()
    const win = frame.contentWindow
    if (!win) throw new Error('解析用フレームを開けませんでした')
    if (!this.sent.has(id)) {
      // 抜粋は複製して送る（ページの抜粋は計画のやり直し・フレームの作り直しで再び使う）
      const channels = Array.from({ length: excerpt.numberOfChannels }, (_, c) => excerpt.getChannelData(c).slice())
      const msg: AnalysisParentMessage = { type: 'excerpt', id, channels, sampleRate: excerpt.sampleRate }
      win.postMessage(msg, location.origin, channels.map((c) => c.buffer))
      this.sent.add(id)
    }
    const callId = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(callId)) return
        this.pending.delete(callId)
        reject(new AnalysisTimeoutError(call.kind, limit, 1))
      }, limit)
      this.pending.set(callId, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      const msg: AnalysisParentMessage = { type: 'call', callId, call }
      win.postMessage(msg, location.origin)
    })
  }

  private ensureFrame(): Promise<HTMLIFrameElement> {
    if (!this.listening) {
      window.addEventListener('message', this.onMessage)
      this.listening = true
    }
    if (this.frame && this.ready) {
      const f = this.frame
      return this.ready.then(() => f)
    }
    const frame = document.createElement('iframe')
    frame.dataset.csxAnalysis = ''
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden'
    this.frame = frame
    this.sent = new Set()
    this.contexts = 0
    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve
    })
    frame.src = this.frameUrl
    document.body.appendChild(frame)
    return this.ready.then(() => frame)
  }

  /** 使っていなければしばらく後に削除する */
  private scheduleRelease(): void {
    if (this.active > 0 || !this.frame) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.active === 0) this.destroy(null)
    }, ANALYSIS_FRAME_IDLE_MS)
  }

  private destroy(reason: unknown): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const pending = [...this.pending.values()]
    this.pending.clear()
    this.frame?.remove()
    this.frame = null
    this.ready = null
    this.readyResolve = null
    this.sent = new Set()
    this.contexts = 0
    if (reason) for (const p of pending) p.reject(reason)
    else for (const p of pending) p.reject(new Error('解析用フレームを作り直しました'))
  }
}
