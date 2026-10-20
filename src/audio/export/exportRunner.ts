// 書き出しの実行（親ウィンドウ側）。使い捨ての iframe（export-frame.html）でレンダリングし、終わったら iframe ごと削除する。
// キャンセルは iframe の削除（OfflineAudioContext には途中で止める API がないため、文書ごと破棄して止める）。
// 完了したときだけ結果（WAV の Blob）を返し、キャンセル・失敗時は結果を一切返さない。
//
// 監視（Phase 07 の安定化）: Edge でまれに書き出しが準備の段階で止まり、終わらないことがあった（原因はブラウザ側か
// 手順のどこかで、未特定。docs/SPATIAL.md）。フレームから届く段階の記録・進捗を見て、一定時間進まなければ打ち切る
// （iframe ごと破棄 = キャンセルと同じ後始末）。音源を送る前（準備の段階）で止まった場合だけ、新しい iframe で 1 回だけ自動で作り直す。

import { DEFAULT_EXPORT_WATCHDOG, renderSeconds, type ExportProgress, type ExportRequest, type ExportResult, type ExportStage, type ExportTrace, type ExportTraceStage, type ExportWatchdog } from './exportSpec'
import type { FrameMessage, ParentMessage, PrepareRequest } from './exportProtocol'
import { keepHrtfLoaded } from '../hrtfKeeper'

export class ExportCancelledError extends Error {
  constructor() {
    super('書き出しをキャンセルしました')
    this.name = 'ExportCancelledError'
  }
}

const STAGE_LABEL: Record<ExportStage, string> = { preparing: '準備（PREPARING）', rendering: 'レンダリング（RENDERING）', encoding: 'エンコード（ENCODING）' }

/** 監視で打ち切った（処理が一定時間進まなかった）。後始末は済んでいて、もう一度書き出せる */
export class ExportTimeoutError extends Error {
  readonly stage: ExportStage
  readonly stalledMs: number
  readonly attempts: number
  constructor(stage: ExportStage, stalledMs: number, attempts: number) {
    super(`書き出しが${STAGE_LABEL[stage]}の段階で ${Math.round(stalledMs / 1000)} 秒進まなかったため中止しました${attempts > 1 ? `（自動で ${attempts - 1} 回やり直しても同じでした）` : ''}。もう一度書き出してください。`)
    this.name = 'ExportTimeoutError'
    this.stage = stage
    this.stalledMs = stalledMs
    this.attempts = attempts
  }
}

export interface ExportJob {
  promise: Promise<ExportResult>
  cancel(): void
}

export interface ExportOptions {
  frameUrl?: string
  watchdog?: Partial<ExportWatchdog>
}

/** 現在フレームが存在するか（試験用: キャンセル・完了後に残っていないことの確認） */
export const exportFrameCount = () => document.querySelectorAll('iframe[data-csx-export]').length

/** 直近の書き出しの記録（音声の内容・ファイル名は含まない）。新しい順ではなく実行順、最大 MAX_TRACES 件 */
const MAX_TRACES = 30
const traces: ExportTrace[] = []
let traceSeq = 0
export const recentExportTraces = (): readonly ExportTrace[] => traces

function browserLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const edge = /Edg\/(\d+)/.exec(ua)
  if (edge) return `Edge ${edge[1]}`
  const chrome = /Chrome\/(\d+)/.exec(ua)
  if (chrome) return `Chrome ${chrome[1]}`
  return 'other'
}

/** 監視の判定の間隔（ms） */
const WATCH_INTERVAL_MS = 500

/**
 * 書き出しの後にブラウザがしばらく持ち続けるメモリの見積もり（Phase 07 で測定）。
 * ページ内に AudioWorklet を読み込んだ OfflineAudioContext（再生エンジンの解析）があると、書き出し 1 回ごとにレンダリングの出力 1 本分
 * （OfflineAudioContext の出力のバッファー。3 分で 約 68 MB）が、フレームを消した後も残る。書き出しをしていない時間が続くと戻り
 * （Chrome / Edge で約 20 秒、以前の測定で Edge 約 40 秒）、次の書き出しの間は戻らないため、続けて書き出すと積み上がる。
 * JS から解放する方法がないため、次の書き出しのメモリの見積もりに足して上限を超えないようにする（useAudioPlayer）
 */
export const RETAINED_RELEASE_IDLE_MS = 45000
let retainedBytes = 0
let lastExportEnd = -Infinity
let runningExports = 0
/** まだ戻っていないと見なすメモリ（バイト）。書き出しのない時間が RETAINED_RELEASE_IDLE_MS 続いたら 0 */
export function pendingRetainedBytes(now = performance.now()): number {
  return runningExports === 0 && now - lastExportEnd >= RETAINED_RELEASE_IDLE_MS ? 0 : retainedBytes
}
/** 戻ったと見なせるまでの残り時間（ms）。書き出し中は RETAINED_RELEASE_IDLE_MS */
export function retainedReleaseWaitMs(now = performance.now()): number {
  if (pendingRetainedBytes(now) === 0) return 0
  return runningExports > 0 ? RETAINED_RELEASE_IDLE_MS : Math.max(0, RETAINED_RELEASE_IDLE_MS - (now - lastExportEnd))
}

export function startExport(request: ExportRequest, onProgress: (p: ExportProgress) => void, opts: ExportOptions = {}): ExportJob {
  const frameUrl = opts.frameUrl ?? `${import.meta.env.BASE_URL}export-frame.html`
  const wd: ExportWatchdog = { ...DEFAULT_EXPORT_WATCHDOG, ...opts.watchdog }
  const id = `export-${++traceSeq}`
  const frames = request.channels[0]?.length ?? 0
  const seconds = frames / request.sampleRate
  const input: ExportTrace['input'] = {
    sampleRate: request.sampleRate,
    channels: request.channels.length,
    seconds: Math.round(seconds * 100) / 100,
    spatialMode: request.dsp.spatial.mode,
    motion: request.dsp.spatial.motionEnabled,
    bassEnabled: request.dsp.bassEnabled,
    returnFloat: !!request.returnFloat,
    encodeWav: request.encodeWav !== false,
  }
  // レンダリングの出力のバッファーの大きさ（ステレオ・float32）。書き出しの後に残るメモリの見積もりに使う
  const renderBytes = Math.ceil(renderSeconds(seconds, 0.1, request.dsp.spatial) * request.sampleRate) * 2 * 4
  const { channels, ...rest } = request
  const prepareRequest: PrepareRequest = { ...rest, frames, channelCount: channels.length }
  let cancelCurrent: () => void = () => {}
  let cancelled = false

  /** 1 回の試行。準備の段階で打ち切ったとき（音源を送る前）は 'retry' を返す */
  const attemptOnce = (attempt: number) =>
    new Promise<ExportResult | 'retry'>((resolve, reject) => {
      const t0 = performance.now()
      const trace: ExportTrace = { id, attempt, browser: browserLabel(), input, events: [], outcome: 'running' }
      traces.push(trace)
      if (traces.length > MAX_TRACES) traces.shift()
      const ev = (stage: ExportTraceStage, phase: 'start' | 'end' | 'fail', detail?: string) => {
        const e = { stage, phase, t: Math.round(performance.now() - t0), detail }
        trace.events.push(e)
        // 親側の段階も console.debug に出す（フレーム側と同じ形式。スレッドが止まっても止まる直前まで残る）
        console.debug('[CINEMA SONIC X] export-trace', JSON.stringify({ id, attempt, side: 'parent', ...e }))
      }

      const frame = document.createElement('iframe')
      let settled = false
      let stage: ExportStage = 'preparing'
      let lastBeat = performance.now()
      let encodeStart = 0
      let transferred = false
      const beat = () => {
        lastBeat = performance.now()
      }
      const cleanup = () => {
        settled = true
        window.removeEventListener('message', onMessage)
        clearInterval(watch)
        frame.remove()
      }
      const finish = (outcome: ExportTrace['outcome']) => {
        trace.outcome = outcome
        cleanup()
        // 文脈を作った試行は、出力のバッファーがしばらく残りうる（キャンセル・打ち切りでも）
        if (trace.events.some((x) => x.stage === 'context' && x.phase === 'end')) retainedBytes += renderBytes
      }
      const onMessage = (e: MessageEvent<FrameMessage>) => {
        if (settled || e.source !== frame.contentWindow || e.origin !== location.origin) return
        const m = e.data
        beat()
        if (m.type === 'ready') {
          ev('init', 'end')
          const msg: ParentMessage = { type: 'prepare', request: prepareRequest, id, attempt }
          frame.contentWindow!.postMessage(msg, location.origin)
        } else if (m.type === 'trace') {
          ev(m.stage, m.phase, m.detail)
          if (m.stage === 'encode' && m.phase === 'end') ev('return', 'start')
        } else if (m.type === 'prepared') {
          // 音源の PCM は転送する（呼び出し側はコピーを渡す）。転送した後は作り直せない（再試行しない）
          ev('transfer', 'start')
          transferred = true
          const msg: ParentMessage = { type: 'render', channels }
          frame.contentWindow!.postMessage(msg, location.origin, channels.map((c) => c.buffer))
        } else if (m.type === 'progress') {
          if (m.progress.stage === 'encoding' && stage !== 'encoding') encodeStart = performance.now()
          stage = m.progress.stage
          onProgress(m.progress)
        } else if (m.type === 'done') {
          ev('return', 'end')
          finish('done')
          resolve(m.result)
        } else if (m.type === 'error') {
          finish('error')
          const err = new Error(m.message)
          err.name = m.name
          reject(err)
        }
      }
      // 監視: 段階ごとの上限（準備・レンダリングは最後に進んでからの時間、エンコードは開始からの時間）
      const watch = setInterval(() => {
        if (settled) return
        const now = performance.now()
        const limit = stage === 'preparing' ? wd.prepareStallMs : stage === 'rendering' ? wd.renderStallMs : wd.encodeBaseMs + wd.encodeMsPerSecond * seconds
        const since = stage === 'encoding' ? now - encodeStart : now - lastBeat
        if (since <= limit) return
        trace.stalled = { stage, ms: Math.round(since) }
        finish('timeout')
        console.warn('[CINEMA SONIC X] 書き出しを監視で打ち切りました', JSON.stringify(trace))
        if (stage === 'preparing' && !transferred && attempt <= wd.prepareRetries) resolve('retry')
        else reject(new ExportTimeoutError(stage, since, attempt))
      }, WATCH_INTERVAL_MS)
      cancelCurrent = () => {
        if (settled) return
        finish('cancelled')
        reject(new ExportCancelledError())
      }

      ev('frame', 'start')
      frame.dataset.csxExport = ''
      frame.setAttribute('aria-hidden', 'true')
      frame.tabIndex = -1
      frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden'
      window.addEventListener('message', onMessage)
      frame.src = frameUrl
      document.body.appendChild(frame)
      ev('frame', 'end')
      ev('init', 'start')
    })

  // Edge でフレームの HRTF の測定が止まる問題の対策（hrtfKeeper.ts）
  keepHrtfLoaded(request.sampleRate)
  // 書き出しのない時間が続いていれば、前の分は戻ったと見なしてから数え始める
  if (pendingRetainedBytes() === 0) retainedBytes = 0
  runningExports++
  const promise = (async () => {
    try {
      for (let attempt = 1; ; attempt++) {
        if (cancelled) throw new ExportCancelledError()
        if (attempt > 1) onProgress({ stage: 'preparing' })
        const r = await attemptOnce(attempt)
        if (r !== 'retry') return r
      }
    } finally {
      runningExports--
      lastExportEnd = performance.now()
    }
  })()
  return {
    promise,
    cancel: () => {
      cancelled = true
      cancelCurrent()
    },
  }
}
