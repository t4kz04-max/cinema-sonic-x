import { CROSSOVER_HZ, FALLBACK_COMPRESSOR_SPEC, MODE_SPECS, paramsToGains, type BassParams } from './bassSpec'
import { createAlignDelay } from './alignDelay'
import { clearRamp, linearRampAt } from './spatial/nodeUtils'
import type { DynamicsMeter, DynamicsSettings } from './dynamicsTypes'
import workletUrl from './worklets/bassDynamics.worklet.ts?worker&url'

/** EQ・補正ゲイン変更時の平滑化時定数（秒）。ジッパーノイズ防止 */
const PARAM_TIME_CONSTANT = 0.03
const TRIM_TIME_CONSTANT = 0.08
/** BYPASS 切替のクロスフェード時間（秒）。クリックノイズ防止 */
export const BYPASS_FADE_SECONDS = 0.04

/** lowpass/highpass の Q は Web Audio では dB 指定。Butterworth（Q=1/√2）に相当 */
const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2)

function holdAt(param: AudioParam, time: number): void {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(time)
  } else {
    const v = param.value
    param.cancelScheduledValues(time)
    param.setValueAtTime(v, time)
  }
}

function setParam(ctx: BaseAudioContext, param: AudioParam, value: number, smooth: boolean, tc: number): void {
  if (!smooth) {
    param.cancelScheduledValues(0)
    param.value = value
    return
  }
  const t = ctx.currentTime
  holdAt(param, t)
  param.setTargetAtTime(value, t, tc)
}

const dbToGain = (db: number) => Math.pow(10, db / 20)

const workletLoads = new WeakMap<BaseAudioContext, Promise<boolean>>()

/** ダイナミクス用 AudioWorklet を読み込む。非対応（非セキュアコンテキスト等）なら false */
export function loadDynamicsWorklet(ctx: BaseAudioContext): Promise<boolean> {
  let p = workletLoads.get(ctx)
  if (!p) {
    p =
      typeof AudioWorkletNode === 'undefined' || !ctx.audioWorklet
        ? Promise.resolve(false)
        : ctx.audioWorklet.addModule(workletUrl).then(
            () => true,
            () => false,
          )
    workletLoads.set(ctx, p)
  }
  return p
}

export interface EqChain {
  input: AudioNode
  output: AudioNode
  subsonic: BiquadFilterNode[]
  shelf: BiquadFilterNode
  punch: BiquadFilterNode
  sub: BiquadFilterNode
  setParams(params: BassParams, scale: number, smooth: boolean): void
}

/**
 * 低音EQチェーン: SUBSONIC HPF（4 次）→ LOW SHELF → PEAK（パンチ）→ PEAK（サブ）
 * BiquadFilterNode はチャンネルごとに独立して処理するため、ステレオ像は変わらない。
 * モード切替は周波数・Q・ゲインの平滑変更で行い、ノードの再生成はしない（クリック防止）。
 */
export function createEqChain(ctx: BaseAudioContext, params: BassParams, scale = 1): EqChain {
  const spec = MODE_SPECS[params.mode]
  const g = paramsToGains(params, scale)
  const subsonic = [0, 1].map(
    () => new BiquadFilterNode(ctx, { type: 'highpass', frequency: spec.subsonicHz, Q: BUTTERWORTH_Q_DB }),
  )
  const shelf = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: spec.shelf.frequency, gain: g.shelfDb })
  const punch = new BiquadFilterNode(ctx, {
    type: 'peaking',
    frequency: spec.punch.frequency,
    Q: spec.punch.q,
    gain: g.punchDb,
  })
  const sub = new BiquadFilterNode(ctx, { type: 'peaking', frequency: spec.sub.frequency, Q: spec.sub.q, gain: g.subDb })
  subsonic[0].connect(subsonic[1]).connect(shelf).connect(punch).connect(sub)

  return {
    input: subsonic[0],
    output: sub,
    subsonic,
    shelf,
    punch,
    sub,
    setParams(p, s, smooth) {
      const m = MODE_SPECS[p.mode]
      const next = paramsToGains(p, s)
      for (const hp of subsonic) setParam(ctx, hp.frequency, m.subsonicHz, smooth, PARAM_TIME_CONSTANT)
      setParam(ctx, shelf.frequency, m.shelf.frequency, smooth, PARAM_TIME_CONSTANT)
      setParam(ctx, shelf.gain, next.shelfDb, smooth, PARAM_TIME_CONSTANT)
      setParam(ctx, punch.frequency, m.punch.frequency, smooth, PARAM_TIME_CONSTANT)
      setParam(ctx, punch.Q, m.punch.q, smooth, PARAM_TIME_CONSTANT)
      setParam(ctx, punch.gain, next.punchDb, smooth, PARAM_TIME_CONSTANT)
      setParam(ctx, sub.frequency, m.sub.frequency, smooth, PARAM_TIME_CONSTANT)
      setParam(ctx, sub.Q, m.sub.q, smooth, PARAM_TIME_CONSTANT)
      setParam(ctx, sub.gain, next.subDb, smooth, PARAM_TIME_CONSTANT)
    },
  }
}

/** Linkwitz-Riley 4 次クロスオーバー（Butterworth 2 段）。LP + HP の和は振幅特性が平坦 */
function createCrossover(ctx: BaseAudioContext) {
  const mk = (type: BiquadFilterType) => new BiquadFilterNode(ctx, { type, frequency: CROSSOVER_HZ, Q: BUTTERWORTH_Q_DB })
  const lp = [mk('lowpass'), mk('lowpass')]
  const hp = [mk('highpass'), mk('highpass')]
  lp[0].connect(lp[1])
  hp[0].connect(hp[1])
  return { lowIn: lp[0], lowOut: lp[1], highIn: hp[0], highOut: hp[1] }
}

/** モードの設定から AudioWorklet 用の設定を作る */
export function dynamicsSettingsFor(
  mode: BassParams['mode'],
  bassThresholdDb: number,
  trimDb: number,
  opts: { limiterEnabled?: boolean; reportIntervalMs?: number } = {},
): DynamicsSettings {
  const m = MODE_SPECS[mode]
  return {
    bassThresholdDb,
    bassRatio: m.bassComp.ratio,
    bassKneeDb: m.bassComp.kneeDb,
    bassAttackMs: m.bassComp.attackMs,
    bassReleaseMs: m.bassComp.releaseMs,
    trimDb,
    ceilingDb: m.limiter.ceilingDb,
    lookaheadMs: m.limiter.lookaheadMs,
    limiterReleaseMs: m.limiter.releaseMs,
    limiterEnabled: opts.limiterEnabled ?? true,
    reportIntervalMs: opts.reportIntervalMs ?? 0,
  }
}

export interface ProcessingGraph {
  input: AudioNode
  output: AudioNode
  eq: EqChain
  engine: 'worklet' | 'fallback'
  /** 処理経路の遅延（秒）。リミッターの先読み分 */
  latencySeconds: number
  setParams(params: BassParams, scale: number, smooth: boolean): void
  /** ワークレットの設定変更（トリムを含む）。フォールバック時はトリムのみ反映 */
  setDynamics(settings: Partial<DynamicsSettings>, smooth?: boolean): void
  setMakeupCancel(gain: number, smooth?: boolean): void
  setBypass(bypass: boolean, smooth: boolean): void
  onMeter(listener: ((m: DynamicsMeter) => void) | null): void
}

export interface GraphOptions {
  params: BassParams
  scale: number
  bypass: boolean
  dynamics: DynamicsSettings
  useWorklet: boolean
  /**
   * ORIGINAL/PROCESSED 比較の時刻合わせ: dry 経路をリミッターの先読み分だけ遅らせる（整数サンプル、原音とビット一致のまま）。
   * 事前に loadAlignWorklet が必要。省略時は遅らせない（dry = 入力と同時刻でビット一致）
   */
  alignBypass?: boolean
}

/**
 * 処理グラフ:
 *
 *   input ─┬─ [時刻合わせ] ─ dry ───────────────────────────────────────────────────┬─ output
 *          └─ EQ ─┬─ LR4 LP ─→ [worklet in0: 低域コンプ] ┐                            │
 *                 └─ LR4 HP ─→ [worklet in1]            ┴→ 合成 → トリム → リミッター → wet ┘
 *
 * フォールバック（AudioWorklet 非対応）: EQ → トリム → DynamicsCompressor → メイクアップ打消し → wet
 * BYPASS 時は dry=1 / wet=0。dry 経路はゲイン 1（と整数サンプルの遅延）のみなので原音とビット一致する。
 */
export function createProcessingGraph(ctx: BaseAudioContext, opts: GraphOptions): ProcessingGraph {
  const input = new GainNode(ctx)
  const output = new GainNode(ctx)
  const dry = new GainNode(ctx, { gain: opts.bypass ? 1 : 0 })
  const wet = new GainNode(ctx, { gain: opts.bypass ? 0 : 1 })
  const eq = createEqChain(ctx, opts.params, opts.scale)
  // 時刻合わせはワークレット経路（先読みの遅延が整数サンプル）のときだけ
  const align = opts.alignBypass && opts.useWorklet ? createAlignDelay(ctx, opts.dynamics.lookaheadMs / 1000) : null
  if (align) input.connect(align.node).connect(dry)
  else input.connect(dry)
  dry.connect(output)
  input.connect(eq.input)

  let worklet: AudioWorkletNode | null = null
  let trim: GainNode | null = null
  let makeupCancel: GainNode | null = null
  let meterListener: ((m: DynamicsMeter) => void) | null = null

  if (opts.useWorklet) {
    const xo = createCrossover(ctx)
    worklet = new AudioWorkletNode(ctx, 'csx-bass-dynamics', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'clamped-max',
      channelInterpretation: 'speakers',
      processorOptions: opts.dynamics,
    })
    eq.output.connect(xo.lowIn)
    eq.output.connect(xo.highIn)
    xo.lowOut.connect(worklet, 0, 0)
    xo.highOut.connect(worklet, 0, 1)
    worklet.connect(wet).connect(output)
    // 通知を使うときだけ受信する（onmessage を設定した MessagePort は閉じるまで GC されず、解析用の OfflineAudioContext ごと残るため）
    if ((opts.dynamics.reportIntervalMs ?? 0) > 0) worklet.port.onmessage = (e: MessageEvent<DynamicsMeter>) => meterListener?.(e.data)
  } else {
    trim = new GainNode(ctx, { gain: dbToGain(opts.dynamics.trimDb) })
    const comp = new DynamicsCompressorNode(ctx, { ...FALLBACK_COMPRESSOR_SPEC })
    makeupCancel = new GainNode(ctx)
    eq.output.connect(trim).connect(comp).connect(makeupCancel).connect(wet).connect(output)
  }

  return {
    input,
    output,
    eq,
    engine: worklet ? 'worklet' : 'fallback',
    latencySeconds: worklet ? opts.dynamics.lookaheadMs / 1000 : 0.006,
    setParams: (p, scale, smooth) => eq.setParams(p, scale, smooth),
    setDynamics(settings, smooth = true) {
      if (worklet) {
        worklet.port.postMessage(settings)
      } else if (trim && settings.trimDb !== undefined) {
        setParam(ctx, trim.gain, dbToGain(settings.trimDb), smooth, TRIM_TIME_CONSTANT)
      }
    },
    setMakeupCancel(gain, smooth = true) {
      if (makeupCancel) setParam(ctx, makeupCancel.gain, gain, smooth, PARAM_TIME_CONSTANT)
    },
    setBypass(b, smooth) {
      const targets: [GainNode, number][] = [
        [dry, b ? 1 : 0],
        [wet, b ? 0 : 1],
      ]
      for (const [node, target] of targets) {
        if (!smooth) {
          node.gain.cancelScheduledValues(0)
          node.gain.value = target
          clearRamp(node.gain)
          continue
        }
        // 線形クロスフェードで終点が厳密に 0 / 1 になる（setTargetAtTime は漸近のみ）。
        // 開始点を明示する（2 回目以降の切替でランプが前回の終点から始まり、値が飛ぶのを防ぐ）
        const t = ctx.currentTime
        linearRampAt(node.gain, t, target, t + BYPASS_FADE_SECONDS)
      }
    },
    onMeter(listener) {
      meterListener = listener
    },
  }
}

let makeupPromise: Promise<number> | null = null

/**
 * フォールバック用 DynamicsCompressorNode の自動メイクアップゲイン（仕様上 +1〜2 dB）を
 * しきい値より十分小さい正弦波で実測する。戻り値は linear。
 */
export function measureCompressorMakeup(): Promise<number> {
  makeupPromise ??= (async () => {
    const rate = 44100
    const ctx = new OfflineAudioContext(1, Math.round(rate * 0.5), rate)
    const osc = new OscillatorNode(ctx, { frequency: 1000 })
    const level = new GainNode(ctx, { gain: 0.01 }) // -40 dBFS
    const comp = new DynamicsCompressorNode(ctx, { ...FALLBACK_COMPRESSOR_SPEC })
    osc.connect(level).connect(comp).connect(ctx.destination)
    osc.start()
    const out = (await ctx.startRendering()).getChannelData(0)
    const from = Math.round(rate * 0.25)
    let sum = 0
    for (let i = from; i < out.length; i++) sum += out[i] * out[i]
    const rms = Math.sqrt(sum / (out.length - from))
    const makeup = rms / (0.01 * Math.SQRT1_2)
    if (!Number.isFinite(makeup) || makeup < 0.25 || makeup > 4) throw new Error(`想定外のメイクアップ実測値: ${makeup}`)
    return makeup
  })()
  makeupPromise.catch(() => {
    makeupPromise = null
  })
  return makeupPromise
}
