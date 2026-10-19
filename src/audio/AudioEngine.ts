import type { DspMeters, DspStatus, PlaybackStatus } from '../types/audio'
import { analyzeSource, bassThresholdFor, buildAnalysisExcerpt, planProcessing, type SourceAnalysis } from './analysis'
import { DEFAULT_BASS_PARAMS, type BassParams } from './bassSpec'
import { eqCapScale } from './biquadMath'
import { linearToDb } from './loudness'
import { analyzeSpatialSource, buildSpatialExcerpt, planSpatial, wideCapFor } from './spatial/spatialAnalysis'
import type { Envelope } from './spatial/motion'
import { computeEnvelope } from './spatial/motionEnvelope'
import { transportTime, type MotionReport, type MotionTransport } from './spatial/motionTypes'
import { linearRampAt } from './spatial/nodeUtils'
import {
  fadeOutSource,
  nextLoopBoundary,
  NORMAL_LOOP_RESET_FADE_SECONDS,
  restoreOutput,
  SEEK_FADE_SECONDS,
  silenceOutput,
  SILENCE_FADE_SECONDS,
  STOP_FADE_SECONDS,
} from './transportOps'
import { loadTailWorklet } from './spatial/tailEngine'
import type { TailReport } from './spatial/tailTypes'
import { loopBounds, musicRegion, type LoopRegion, type LoopType } from './loopRegion'
import { createSpatialGraph, loadMotionWorklet, measureHrtfLatency, type SpatialGraph } from './spatial/spatialGraph'
import { DEFAULT_SPATIAL_PARAMS, type SpatialParams } from './spatial/spatialSpec'
import type { StereoMetrics } from './stereoMetrics'
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
  spatial: {
    analysis: 'idle',
    trimDb: 0,
    wideSideCapDb: null,
    before: null,
    after: null,
    monoColorationDb: null,
    stereoColorationDb: null,
    predictedLimiterGrDb: null,
    hrtfLatencyMs: null,
    motionAvailable: false,
    tailEngine: null,
  },
}

/** Motion の位置レポート間隔（可視化用） */
const MOTION_REPORT_MS = 33

/**
 * 解析（OfflineAudioContext でのレンダリング）を始めるまでの待ち時間。スライダー操作中に何度も解析しない。
 * Chrome は AudioWorklet を読み込んだ OfflineAudioContext を解放しないため、解析 1 回ごとにレンダリング結果
 * （数 MB）がメモリに残る（ブラウザの挙動。回数を減らして影響を抑える）
 */
const PLAN_DEBOUNCE_MS = 250
/** ループ境界の何秒前に残響の消去を予約するか */
const LOOP_ARM_AHEAD_SECONDS = 0.4
/** 1 周がこれより短いループでは境界の残響消去をしない */
const LOOP_RESET_MIN_PERIOD_SECONDS = 1

/** ベクトルスコープ用 AnalyserNode のサイズ */
const SCOPE_FFT_SIZE = 2048

/**
 * 再生グラフ:
 *   AudioBufferSourceNode → ProcessingGraph（重低音: EQ / 低域コンプ / トリム / リミッター）
 *     → SpatialGraph（WIDE / CINEMA / HALL / Motion / Spatial Tail / トリム / リミッター）
 *     → GainNode(出力ゲート: PAUSE / CUT) → GainNode(モニター音量) → destination
 *
 * 停止系: STOP = 直接音だけフェードアウト（余韻は残す）、PAUSE = 位置を保持して出力をすぐ止め残響を消す、
 * CUT = 直接音・残響とも止めて先頭へ。ループは AudioBufferSourceNode のネイティブループ（サンプル単位で正確）
 *
 * ORIGINAL/PROCESSED（setBypass）は両方の段を同時に BYPASS する。各段の BYPASS 経路はゲイン 1 のみで、
 * 2 段直列でも原音とビット一致する。重低音エンジンは setBassEnabled で個別に ON/OFF できる。
 *
 * モニター音量は常に最終段で、Phase 04 の書き出し音声には含めない。
 * AudioBufferSourceNode は一度しか start できないため、再生・シークのたびに作り直す。
 */
export class AudioEngine {
  private ctx: AudioContext | null = null
  private ready: Promise<AudioContext> | null = null
  private monitorGain: GainNode | null = null
  private graph: ProcessingGraph | null = null
  private spatialGraph: SpatialGraph | null = null
  private scope: { left: AnalyserNode; right: AnalyserNode } | null = null
  private hrtfLatency = 0
  private useWorklet = false
  private makeupCancel = 1
  private buffer: AudioBuffer | null = null
  /** 再生中の音源と、そのフェード用ゲイン（定常時は 1 = 原音と同じ値） */
  private source: { node: AudioBufferSourceNode; gain: GainNode } | null = null
  /** PAUSE / CUT で出力を止めるゲート（定常時は 1） */
  private outputGate: GainNode | null = null
  /** PAUSE / CUT で出力を止めた時刻（ctx 時刻）。再開時に遅延線が空になるまで待つ */
  private silencedAt: number | null = null
  private loopEnabled = false
  private loopType: LoopType = 'normal'
  /** SPATIAL LOOP 用: 音楽が鳴っている区間 */
  private region: LoopRegion | null = null
  private loopTimer: ReturnType<typeof setTimeout> | null = null
  private tailReport: TailReport | null = null
  /** 再生開始時の ctx.currentTime からバッファ上の位置を逆算するための基準 */
  private startedAt = 0
  /** 停止・一時停止中の再生位置（秒） */
  private offset = 0
  private volume: number
  private status: PlaybackStatus = 'stopped'
  private statusListener: ((status: PlaybackStatus) => void) | null = null

  private params: BassParams = { ...DEFAULT_BASS_PARAMS }
  private bypass = false
  /** 空間音響の評価を優先するため、重低音エンジンは既定で OFF */
  private bassEnabled = false
  private spatialParams: SpatialParams = { ...DEFAULT_SPATIAL_PARAMS }
  private spatialExcerpt: AudioBuffer | null = null
  private spatialBefore: StereoMetrics | null = null
  private spatialPlanning = false
  private spatialDirty = false
  /** PULSE 用のエネルギー包絡（曲全体から計算） */
  private envelope: Envelope | null = null
  private motionReport: MotionReport | null = null
  private dsp: DspStatus = { ...INITIAL_DSP_STATUS }
  private dspListener: ((status: DspStatus) => void) | null = null
  private meters: DspMeters = { bassGrDb: 0, limiterGrDb: 0, spatialLimiterGrDb: 0 }
  private excerpt: AudioBuffer | null = null
  private sourceAnalysis: SourceAnalysis | null = null
  /** 直近の計画で決まった安全倍率（新しい計画が出るまで維持する） */
  private safetyScale = 1
  /** 音源が変わるたびに増やし、古い計測結果を捨てる */
  private analysisToken = 0
  private planning = false
  private planDirty = false
  private planTimer: ReturnType<typeof setTimeout> | null = null
  private spatialPlanTimer: ReturnType<typeof setTimeout> | null = null

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
      bypass: this.bassBypassed(),
      dynamics: dynamicsSettingsFor(this.params.mode, bassThresholdFor(this.params, this.sourceAnalysis), this.dsp.trimDb, {
        reportIntervalMs: METER_INTERVAL_MS,
      }),
      useWorklet: this.useWorklet,
    })
    graph.setMakeupCancel(this.makeupCancel, false)
    graph.onMeter((m) => {
      this.meters = { ...this.meters, bassGrDb: m.bassGrDb, limiterGrDb: m.limiterGrDb }
    })

    this.hrtfLatency = await measureHrtfLatency(ctx.sampleRate)
    const motionOk = await loadMotionWorklet(ctx)
    if (this.useWorklet) await loadTailWorklet(ctx)
    const spatial = createSpatialGraph(ctx, {
      params: this.spatialParams,
      bypass: this.spatialBypassed(),
      trimDb: this.dsp.spatial.trimDb,
      useWorklet: this.useWorklet,
      hrtfLatencySeconds: this.hrtfLatency,
      wideSideCapDb: wideCapFor(this.spatialBefore),
      reportIntervalMs: METER_INTERVAL_MS,
      motion: motionOk ? { transport: this.transport(), envelope: this.envelope, reportIntervalMs: MOTION_REPORT_MS } : undefined,
    })
    spatial.onMotionReport((r) => {
      this.motionReport = r
    })
    spatial.onMeter((m) => {
      this.meters = { ...this.meters, spatialLimiterGrDb: m.limiterGrDb }
    })
    spatial.onTailReport((r) => {
      this.tailReport = r
    })
    graph.output.connect(spatial.input)
    const outputGate = new GainNode(ctx, { gain: 1 })
    spatial.output.connect(outputGate).connect(gain)
    this.outputGate = outputGate

    // ベクトルスコープ（モニター音量の前で取り出す）
    const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 })
    const scopeIn = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    const left = new AnalyserNode(ctx, { fftSize: SCOPE_FFT_SIZE })
    const right = new AnalyserNode(ctx, { fftSize: SCOPE_FFT_SIZE })
    spatial.output.connect(scopeIn).connect(split)
    split.connect(left, 0)
    split.connect(right, 1)

    this.monitorGain = gain
    this.graph = graph
    this.spatialGraph = spatial
    this.scope = { left, right }
    this.updateDsp({
      dynamicsEngine: graph.engine,
      spatial: {
        ...this.dsp.spatial,
        hrtfLatencyMs: this.hrtfLatency * 1000,
        motionAvailable: spatial.motionAvailable,
        tailEngine: spatial.tailEngine,
      },
    })
    return ctx
  }

  /** 注意: data は decodeAudioData によって detach される */
  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = await this.ensureReady()
    return ctx.decodeAudioData(data)
  }

  setBuffer(buffer: AudioBuffer): void {
    // 前の曲の直接音・余韻は残さない（CUT と同じ）
    if (this.status === 'playing') this.silenceOutput()
    this.teardownSource(this.status === 'playing' ? SILENCE_FADE_SECONDS : 0)
    this.buffer = buffer
    this.region = musicRegion(
      Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
      buffer.sampleRate,
    )
    this.offset = 0
    this.setStatus('stopped')
    this.updateEnvelope()
    this.sendTransport()
    void this.startAnalysis(buffer)
  }

  async play(): Promise<void> {
    if (!this.buffer || this.status === 'playing') return
    const ctx = await this.ensureReady()
    // 自動再生ポリシーにより suspended で生成されることがあるため、ユーザー操作時に再開する
    if (ctx.state === 'suspended') await ctx.resume()
    if (this.offset >= this.buffer.duration) this.offset = 0
    const now = ctx.currentTime
    let when = now
    if (this.silencedAt !== null && this.outputGate) {
      // PAUSE / CUT で止めた出力を戻す。直後の再開なら遅延線が空になるまで待ってから始める
      when = restoreOutput(ctx, this.outputGate, this.silencedAt)
      this.silencedAt = null
    }
    this.startSource(this.offset, when, 0)
    this.setStatus('playing')
  }

  /** PAUSE: 再生位置を保持し、出力（直接音・余韻とも）を速やかに止める。再開時は同じ位置・同じ Motion の時刻から */
  pause(): void {
    if (this.status !== 'playing') return
    this.offset = this.getPosition()
    this.silenceOutput()
    this.teardownSource(SILENCE_FADE_SECONDS)
    this.setStatus('paused')
    this.sendTransport()
  }

  /** STOP: 直接音を速やかに止めて先頭へ。反射音・残響（HALL・Spatial Tail）の余韻は自然に消えるまで残す */
  stop(): void {
    this.teardownSource(this.status === 'playing' ? STOP_FADE_SECONDS : 0)
    this.offset = 0
    this.setStatus('stopped')
    this.sendTransport()
  }

  /** CUT: 直接音と余韻の両方を速やかに止めて先頭へ（停止後に鳴っている余韻も止める） */
  cut(): void {
    if (this.ctx) this.silenceOutput()
    this.teardownSource(this.status === 'playing' ? SILENCE_FADE_SECONDS : 0)
    this.offset = 0
    this.setStatus('stopped')
    this.sendTransport()
  }

  /** ループ再生の設定。再生中に切り替えても位置と Motion の時刻は連続する */
  setLoop(enabled: boolean, type: LoopType): void {
    this.loopEnabled = enabled
    this.loopType = type
    const src = this.source?.node
    if (!src || !this.ctx || this.status !== 'playing') return
    const position = this.getPosition()
    const b = this.loopBounds()
    src.loop = !!b
    if (b) {
      src.loopStart = b.start
      src.loopEnd = b.end
    }
    // ループ区間が変わってもメディア時刻が連続するよう、現在位置で基準を取り直す
    this.startedAt = this.ctx.currentTime - position
    this.sendTransport()
    this.armLoopBoundary()
  }

  /** 現在のループ区間（ループ OFF なら null） */
  loopRegion(): LoopRegion | null {
    return this.loopBounds()
  }

  /** SPATIAL LOOP で使う、音楽が鳴っている区間（無音のみ・短すぎる音源なら null） */
  getMusicRegion(): LoopRegion | null {
    return this.region
  }

  getTailReport(): TailReport | null {
    return this.tailReport
  }

  /** テスト用: 後期残響の畳み込みの組の数（ループで増え続けないことの確認） */
  debugReverbSlots(): number {
    return this.spatialGraph?.debug.reverbSlots() ?? 0
  }

  seek(seconds: number): void {
    if (!this.buffer) return
    const target = Math.min(Math.max(seconds, 0), this.buffer.duration)
    if (this.status === 'playing' && this.ctx) {
      // 新旧の音源を短くクロスフェード（余韻は残す）
      this.teardownSource(SEEK_FADE_SECONDS)
      this.startSource(target, this.ctx.currentTime, SEEK_FADE_SECONDS)
    } else {
      this.offset = target
      this.sendTransport()
    }
  }

  getPosition(): number {
    if (!this.buffer) return 0
    if (this.status !== 'playing' || !this.ctx) return this.offset
    return Math.min(Math.max(transportTime(this.transport(), this.ctx.currentTime), 0), this.buffer.duration)
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

  /** ORIGINAL（true）/ PROCESSED（false）。重低音・空間の両段を同時に切り替える */
  setBypass(bypass: boolean): void {
    this.bypass = bypass
    this.applyBypass()
  }

  setBassEnabled(enabled: boolean): void {
    this.bassEnabled = enabled
    this.applyBypass()
  }

  setSpatialParams(params: SpatialParams): void {
    const modeChanged = params.mode !== this.spatialParams.mode
    const speedChanged = params.motionSpeed !== this.spatialParams.motionSpeed
    this.spatialParams = { ...params }
    // PULSE の包絡は SPEED（追従速度）に依存するため、変わったら曲全体から再計算する
    if (speedChanged) this.updateEnvelope()
    this.spatialGraph?.setParams(this.spatialParams, true)
    if (modeChanged) this.applyBypass()
    this.requestSpatialPlan()
  }

  /** Motion Engine が実際に使っている位置（直近のレポート）。Motion OFF・未初期化なら null */
  getMotionReport(): MotionReport | null {
    return this.motionReport
  }

  /** 再生位置の基準。位置はメディア時刻の関数なので、これを送れば再生・一時停止・シークで同じ位置が再現される */
  private transport(): MotionTransport {
    return this.status === 'playing' || this.source ? this.playingTransport() : { playing: false, startedAt: 0, pausedAt: this.offset }
  }

  private playingTransport(): MotionTransport {
    const b = this.loopBounds()
    return { playing: true, startedAt: this.startedAt, pausedAt: this.offset, loopStart: b?.start ?? 0, loopEnd: b?.end ?? 0 }
  }

  private loopBounds(): LoopRegion | null {
    if (!this.loopEnabled || !this.buffer) return null
    return loopBounds(this.loopType, this.region, this.buffer.duration)
  }

  /** 出力ゲートを短くフェードアウトし、その時点までの残響を消す（PAUSE / CUT） */
  private silenceOutput(): void {
    if (!this.ctx || !this.outputGate) return
    this.silencedAt = silenceOutput(this.ctx, this.outputGate, this.spatialGraph)
  }

  private clearLoopTimer(): void {
    if (this.loopTimer) clearTimeout(this.loopTimer)
    this.loopTimer = null
  }

  /**
   * NORMAL LOOP: 次の境界の少し前に「境界の時刻で前回の残響を消す」予約をする（AudioParam の予約なのでサンプル単位で正確）。
   * SPATIAL LOOP は消さない（前回の余韻と次の冒頭が重なる）
   */
  private armLoopBoundary(): void {
    this.clearLoopTimer()
    const ctx = this.ctx
    const b = this.loopBounds()
    const src = this.source?.node
    if (!ctx || !b || !src || this.loopType !== 'normal') return
    if (b.end - b.start < LOOP_RESET_MIN_PERIOD_SECONDS) return
    const boundary = nextLoopBoundary(ctx.currentTime, this.startedAt, b)
    this.loopTimer = setTimeout(
      () => {
        this.loopTimer = null
        if (this.source?.node !== src || !this.ctx) return
        this.spatialGraph?.resetReverb(boundary, NORMAL_LOOP_RESET_FADE_SECONDS)
        this.loopTimer = setTimeout(() => this.armLoopBoundary(), Math.max(0, boundary - this.ctx.currentTime + 0.05) * 1000)
      },
      Math.max(0, boundary - ctx.currentTime - LOOP_ARM_AHEAD_SECONDS) * 1000,
    )
  }

  private sendTransport(): void {
    this.spatialGraph?.setTransport(this.transport())
  }

  private updateEnvelope(): void {
    if (!this.buffer) return
    const channels = Array.from({ length: this.buffer.numberOfChannels }, (_, c) => this.buffer!.getChannelData(c))
    this.envelope = computeEnvelope(channels, this.buffer.sampleRate, this.spatialParams.motionSpeed / 100)
    this.spatialGraph?.setEnvelope(this.envelope)
  }

  /** ベクトルスコープ用の直近の L/R 波形（長さ SCOPE_FFT_SIZE）。未初期化なら false */
  readScope(left: Float32Array<ArrayBuffer>, right: Float32Array<ArrayBuffer>): boolean {
    if (!this.scope) return false
    this.scope.left.getFloatTimeDomainData(left)
    this.scope.right.getFloatTimeDomainData(right)
    return true
  }

  private bassBypassed(): boolean {
    return this.bypass || !this.bassEnabled
  }

  private spatialBypassed(): boolean {
    return this.bypass || this.spatialParams.mode === 'off'
  }

  private applyBypass(): void {
    this.graph?.setBypass(this.bassBypassed(), true)
    this.spatialGraph?.setBypass(this.spatialBypassed(), true)
  }

  /** ワークレットが報告する直近のゲインリダクション（dB, 正の値） */
  getMeters(): DspMeters {
    return this.meters
  }

  dispose(): void {
    this.teardownSource()
    this.clearLoopTimer()
    if (this.planTimer) clearTimeout(this.planTimer)
    if (this.spatialPlanTimer) clearTimeout(this.spatialPlanTimer)
    this.analysisToken++
    this.statusListener = null
    this.dspListener = null
    this.graph?.onMeter(null)
    this.spatialGraph?.onMeter(null)
    this.spatialGraph = null
    this.scope = null
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
    this.spatialExcerpt = null
    this.spatialBefore = null
    void this.startSpatialAnalysis(buffer, token)
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
    if (this.planTimer) clearTimeout(this.planTimer)
    this.planTimer = setTimeout(() => {
      this.planTimer = null
      if (!this.planning) void this.runPlan()
    }, PLAN_DEBOUNCE_MS)
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

  private async startSpatialAnalysis(buffer: AudioBuffer, token: number): Promise<void> {
    this.updateSpatial({ analysis: 'measuring', before: null, after: null, monoColorationDb: null, stereoColorationDb: null })
    try {
      await this.ensureReady()
      const excerpt = buildSpatialExcerpt(buffer)
      const before = await analyzeSpatialSource(excerpt)
      if (token !== this.analysisToken) return
      this.spatialExcerpt = excerpt
      this.spatialBefore = before
      const cap = wideCapFor(before)
      this.spatialGraph?.setWideSideCap(cap)
      this.updateSpatial({ before, wideSideCapDb: cap })
      this.requestSpatialPlan()
    } catch {
      if (token === this.analysisToken) this.updateSpatial({ analysis: 'error' })
    }
  }

  private requestSpatialPlan(): void {
    this.spatialDirty = true
    if (this.spatialPlanTimer) clearTimeout(this.spatialPlanTimer)
    this.spatialPlanTimer = setTimeout(() => {
      this.spatialPlanTimer = null
      if (!this.spatialPlanning) void this.runSpatialPlan()
    }, PLAN_DEBOUNCE_MS)
  }

  private async runSpatialPlan(): Promise<void> {
    this.spatialPlanning = true
    try {
      while (this.spatialDirty) {
        this.spatialDirty = false
        const token = this.analysisToken
        const excerpt = this.spatialExcerpt
        const before = this.spatialBefore
        if (!excerpt || !before) return
        const params = { ...this.spatialParams }
        if (params.mode === 'off') {
          this.updateSpatial({ analysis: 'ready', after: null, monoColorationDb: null, stereoColorationDb: null, predictedLimiterGrDb: null })
          continue
        }
        this.updateSpatial({ analysis: 'measuring' })
        let plan
        try {
          plan = await planSpatial(excerpt, before, params, {
            useWorklet: this.useWorklet,
            hrtfLatencySeconds: this.hrtfLatency,
            envelope: this.envelope,
          })
        } catch {
          if (token === this.analysisToken) this.updateSpatial({ analysis: 'error' })
          continue
        }
        if (token !== this.analysisToken || this.spatialDirty) continue
        this.spatialGraph?.setTrimDb(plan.trimDb)
        this.updateSpatial({
          analysis: plan.after ? 'ready' : 'silent',
          trimDb: plan.trimDb,
          wideSideCapDb: plan.wideSideCapDb,
          after: plan.after,
          monoColorationDb: plan.monoColorationDb,
          stereoColorationDb: plan.stereoColorationDb,
          predictedLimiterGrDb: plan.predictedLimiterGrDb,
        })
      }
    } finally {
      this.spatialPlanning = false
    }
  }

  private updateSpatial(patch: Partial<DspStatus['spatial']>): void {
    this.updateDsp({ spatial: { ...this.dsp.spatial, ...patch } })
  }

  private updateDsp(patch: Partial<DspStatus>): void {
    this.dsp = { ...this.dsp, ...patch }
    this.dspListener?.(this.dsp)
  }

  /** when（ctx 時刻）から offset の位置で再生を始める。fadeIn > 0 ならフェードイン（SEEK のクロスフェード） */
  private startSource(offset: number, when: number, fadeIn: number): void {
    const ctx = this.ctx
    if (!ctx || !this.buffer || !this.graph) return
    const b = this.loopBounds()
    // SPATIAL LOOP で末尾の無音にいる場合は、ループ区間の先頭から
    if (b && offset >= b.end) offset = b.start
    const node = new AudioBufferSourceNode(ctx, { buffer: this.buffer, loop: !!b, loopStart: b?.start ?? 0, loopEnd: b?.end ?? 0 })
    const gain = new GainNode(ctx, { gain: fadeIn > 0 ? 0 : 1 })
    if (fadeIn > 0) linearRampAt(gain.gain, when, 1, when + fadeIn)
    node.connect(gain).connect(this.graph.input)
    node.onended = () => {
      // 手動停止では teardownSource が onended を差し替えるため、ここに来るのは自然終了のみ（ループ中は終了しない）
      if (this.source?.node !== node) return
      this.source = null
      node.disconnect()
      gain.disconnect()
      this.clearLoopTimer()
      this.offset = 0
      this.setStatus('stopped')
      this.sendTransport()
    }
    node.start(when, offset)
    this.source = { node, gain }
    this.offset = offset
    this.startedAt = when - offset
    this.spatialGraph?.setTransport(this.playingTransport())
    this.armLoopBoundary()
  }

  /** 音源を止める。fade > 0 なら直接音を短くフェードアウトしてから止める（クリック防止） */
  private teardownSource(fade = 0): void {
    const s = this.source
    if (!s) return
    this.source = null
    this.clearLoopTimer()
    const release = () => {
      s.node.disconnect()
      s.gain.disconnect()
    }
    if (fade > 0 && this.ctx) {
      fadeOutSource(this.ctx, s.node, s.gain, fade, release)
      return
    }
    s.node.onended = null
    try {
      s.node.stop()
    } catch {
      // 既に停止済み
    }
    release()
  }

  private setStatus(status: PlaybackStatus): void {
    if (this.status === status) return
    this.status = status
    this.statusListener?.(status)
  }
}
