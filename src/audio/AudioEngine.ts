import type { DspMeters, DspStatus, PlaybackStatus } from '../types/audio'
import { analyzeSource, bassThresholdFor, buildAnalysisExcerpt, planProcessing, type SourceAnalysis } from './analysis'
import { DEFAULT_BASS_PARAMS, type BassParams } from './bassSpec'
import { eqCapScale } from './biquadMath'
import { linearToDb } from './loudness'
import {
  createProcessingGraph,
  dynamicsSettingsFor,
  loadDynamicsWorklet,
  measureCompressorMakeup,
  type ProcessingGraph,
} from './processingGraph'

export class AudioContextUnavailableError extends Error {
  constructor(cause: unknown) {
    super('AudioContext を初期化できませんでした', { cause })
    this.name = 'AudioContextUnavailableError'
  }
}

/** 音量変更時のクリック防止用の時定数（秒） */
const GAIN_SMOOTHING = 0.015
/** メーター（ワークレットからの GR 通知）の送信間隔 */
const METER_INTERVAL_MS = 50

const INITIAL_DSP_STATUS: DspStatus = {
  analysis: 'idle',
  dynamicsEngine: null,
  trimDb: 0,
  trimReason: 'none',
  capScale: 1,
  safetyScale: 1,
  bassThresholdDb: null,
  loudnessDeltaLu: null,
  outputPeakDb: null,
  predictedLimiterGrDb: null,
  spectra: null,
  makeupCancelDb: null,
}

/**
 * 再生グラフ:
 *   AudioBufferSourceNode → ProcessingGraph（BYPASS / 低音EQ / 低域コンプ / トリム / リミッター）
 *     → GainNode(モニター音量) → destination
 *
 * モニター音量は常に最終段で、Phase 04 の書き出し音声には含めない。
 * AudioBufferSourceNode は一度しか start できないため、再生・シークのたびに作り直す。
 */
export class AudioEngine {
  private ctx: AudioContext | null = null
  private ready: Promise<AudioContext> | null = null
  private monitorGain: GainNode | null = null
  private graph: ProcessingGraph | null = null
  private useWorklet = false
  private makeupCancel = 1
  private buffer: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null
  /** 再生開始時の ctx.currentTime からバッファ上の位置を逆算するための基準 */
  private startedAt = 0
  /** 停止・一時停止中の再生位置（秒） */
  private offset = 0
  private volume: number
  private status: PlaybackStatus = 'stopped'
  private statusListener: ((status: PlaybackStatus) => void) | null = null

  private params: BassParams = { ...DEFAULT_BASS_PARAMS }
  private bypass = false
  private dsp: DspStatus = { ...INITIAL_DSP_STATUS }
  private dspListener: ((status: DspStatus) => void) | null = null
  private meters: DspMeters = { bassGrDb: 0, limiterGrDb: 0 }
  private excerpt: AudioBuffer | null = null
  private sourceAnalysis: SourceAnalysis | null = null
  /** 直近の計画で決まった安全倍率（新しい計画が出るまで維持する） */
  private safetyScale = 1
  /** 音源が変わるたびに増やし、古い計測結果を捨てる */
  private analysisToken = 0
  private planning = false
  private planDirty = false

  constructor(initialVolume: number) {
    this.volume = initialVolume
  }

  onStatusChange(listener: ((status: PlaybackStatus) => void) | null): void {
    this.statusListener = listener
  }

  onDspStatusChange(listener: ((status: DspStatus) => void) | null): void {
    this.dspListener = listener
  }

  private ensureReady(): Promise<AudioContext> {
    if (this.ready && this.ctx && this.ctx.state !== 'closed') return this.ready
    this.ready = this.setupContext()
    return this.ready
  }

  private async setupContext(): Promise<AudioContext> {
    let ctx: AudioContext
    try {
      ctx = new AudioContext({ latencyHint: 'playback' })
    } catch (e) {
      throw new AudioContextUnavailableError(e)
    }
    this.ctx = ctx
    this.useWorklet = await loadDynamicsWorklet(ctx)
    if (!this.useWorklet) {
      try {
        this.makeupCancel = 1 / (await measureCompressorMakeup())
        this.updateDsp({ makeupCancelDb: linearToDb(this.makeupCancel) })
      } catch {
        this.makeupCancel = 1
      }
    }
    const gain = new GainNode(ctx, { gain: this.volume })
    gain.connect(ctx.destination)
    const scale = eqCapScale(this.params) * this.safetyScale
    const graph = createProcessingGraph(ctx, {
      params: this.params,
      scale,
      bypass: this.bypass,
      dynamics: dynamicsSettingsFor(this.params.mode, bassThresholdFor(this.params, this.sourceAnalysis), this.dsp.trimDb, {
        reportIntervalMs: METER_INTERVAL_MS,
      }),
      useWorklet: this.useWorklet,
    })
    graph.setMakeupCancel(this.makeupCancel, false)
    graph.onMeter((m) => {
      this.meters = { bassGrDb: m.bassGrDb, limiterGrDb: m.limiterGrDb }
    })
    graph.output.connect(gain)
    this.monitorGain = gain
    this.graph = graph
    this.updateDsp({ dynamicsEngine: graph.engine })
    return ctx
  }

  /** 注意: data は decodeAudioData によって detach される */
  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = await this.ensureReady()
    return ctx.decodeAudioData(data)
  }

  setBuffer(buffer: AudioBuffer): void {
    this.teardownSource()
    this.buffer = buffer
    this.offset = 0
    this.setStatus('stopped')
    void this.startAnalysis(buffer)
  }

  async play(): Promise<void> {
    if (!this.buffer || this.status === 'playing') return
    const ctx = await this.ensureReady()
    // 自動再生ポリシーにより suspended で生成されることがあるため、ユーザー操作時に再開する
    if (ctx.state === 'suspended') await ctx.resume()
    if (this.offset >= this.buffer.duration) this.offset = 0
    this.startSource(this.offset)
    this.setStatus('playing')
  }

  pause(): void {
    if (this.status !== 'playing') return
    this.offset = this.getPosition()
    this.teardownSource()
    this.setStatus('paused')
  }

  stop(): void {
    this.teardownSource()
    this.offset = 0
    this.setStatus('stopped')
  }

  seek(seconds: number): void {
    if (!this.buffer) return
    const target = Math.min(Math.max(seconds, 0), this.buffer.duration)
    if (this.status === 'playing') {
      this.teardownSource()
      this.startSource(target)
    } else {
      this.offset = target
    }
  }

  getPosition(): number {
    if (!this.buffer) return 0
    if (this.status !== 'playing' || !this.ctx) return this.offset
    return Math.min(this.ctx.currentTime - this.startedAt, this.buffer.duration)
  }

  /** linear gain（0〜1） */
  setVolume(gain: number): void {
    this.volume = gain
    if (this.ctx && this.monitorGain) {
      this.monitorGain.gain.setTargetAtTime(gain, this.ctx.currentTime, GAIN_SMOOTHING)
    }
  }

  setBassParams(params: BassParams): void {
    const modeChanged = params.mode !== this.params.mode
    this.params = { ...params }
    if (modeChanged) this.safetyScale = 1
    // 計測結果を待たずに EQ とモード別ダイナミクスを反映する（その間のピークはリミッターが抑える）
    this.graph?.setParams(this.params, eqCapScale(this.params) * this.safetyScale, true)
    if (modeChanged) {
      this.graph?.setDynamics(
        dynamicsSettingsFor(this.params.mode, bassThresholdFor(this.params, this.sourceAnalysis), this.dsp.trimDb, {
          reportIntervalMs: METER_INTERVAL_MS,
        }),
      )
    }
    this.requestPlan()
  }

  setBypass(bypass: boolean): void {
    this.bypass = bypass
    this.graph?.setBypass(bypass, true)
  }

  /** ワークレットが報告する直近のゲインリダクション（dB, 正の値） */
  getMeters(): DspMeters {
    return this.meters
  }

  dispose(): void {
    this.teardownSource()
    this.analysisToken++
    this.statusListener = null
    this.dspListener = null
    this.graph?.onMeter(null)
    void this.ctx?.close()
    this.ctx = null
    this.ready = null
    this.monitorGain = null
    this.graph = null
    this.buffer = null
    this.excerpt = null
  }

  private async startAnalysis(buffer: AudioBuffer): Promise<void> {
    const token = ++this.analysisToken
    this.excerpt = null
    this.sourceAnalysis = null
    this.updateDsp({ analysis: 'measuring', spectra: null, loudnessDeltaLu: null, outputPeakDb: null, predictedLimiterGrDb: null })
    try {
      await this.ensureReady()
      const excerpt = buildAnalysisExcerpt(buffer)
      const source = await analyzeSource(excerpt)
      if (token !== this.analysisToken) return
      this.excerpt = excerpt
      this.sourceAnalysis = source
      this.requestPlan()
    } catch {
      if (token === this.analysisToken) this.updateDsp({ analysis: 'error' })
    }
  }

  /**
   * スライダー操作中は連続して呼ばれるため、計測中なら終了後にもう一度だけ計測する。
   * 全帯域トリム・安全制限・低域コンプしきい値は計測完了まで直前の値を保つ。
   */
  private requestPlan(): void {
    this.planDirty = true
    if (!this.planning) void this.runPlan()
  }

  private async runPlan(): Promise<void> {
    this.planning = true
    try {
      while (this.planDirty) {
        this.planDirty = false
        const token = this.analysisToken
        const excerpt = this.excerpt
        const source = this.sourceAnalysis
        if (!excerpt || !source) return
        this.updateDsp({ analysis: 'measuring' })
        const params = { ...this.params }
        let plan
        try {
          plan = await planProcessing(excerpt, source, params, {
            useWorklet: this.useWorklet,
            makeupCancel: this.makeupCancel,
          })
        } catch {
          if (token === this.analysisToken) this.updateDsp({ analysis: 'error' })
          continue
        }
        if (token !== this.analysisToken || this.planDirty) continue
        this.safetyScale = plan.safetyScale
        this.graph?.setParams(params, plan.scale, true)
        this.graph?.setDynamics({ ...plan.dynamics, reportIntervalMs: METER_INTERVAL_MS })
        this.updateDsp({
          analysis: plan.result ? 'ready' : 'silent',
          trimDb: plan.trim.trimDb,
          trimReason: plan.trim.reason,
          capScale: plan.capScale,
          safetyScale: plan.safetyScale,
          bassThresholdDb: source.silent ? null : plan.dynamics.bassThresholdDb,
          loudnessDeltaLu: plan.result?.loudnessDeltaLu ?? null,
          outputPeakDb: plan.result?.outputPeakDb ?? null,
          predictedLimiterGrDb: plan.result?.predictedLimiterGrDb ?? null,
          spectra: plan.result ? { before: source.spectrum, after: plan.result.spectrum } : null,
        })
      }
    } finally {
      this.planning = false
    }
  }

  private updateDsp(patch: Partial<DspStatus>): void {
    this.dsp = { ...this.dsp, ...patch }
    this.dspListener?.(this.dsp)
  }

  private startSource(offset: number): void {
    const ctx = this.ctx
    if (!ctx || !this.buffer || !this.graph) return
    const src = new AudioBufferSourceNode(ctx, { buffer: this.buffer })
    src.connect(this.graph.input)
    src.onended = () => {
      // 手動停止では teardownSource が onended を外すため、ここに来るのは自然終了のみ
      if (this.source !== src) return
      this.source = null
      this.offset = 0
      this.setStatus('stopped')
    }
    src.start(0, offset)
    this.source = src
    this.offset = offset
    this.startedAt = ctx.currentTime - offset
  }

  private teardownSource(): void {
    const src = this.source
    if (!src) return
    this.source = null
    src.onended = null
    try {
      src.stop()
    } catch {
      // 既に停止済み
    }
    src.disconnect()
  }

  private setStatus(status: PlaybackStatus): void {
    if (this.status === status) return
    this.status = status
    this.statusListener?.(status)
  }
}
