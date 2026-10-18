import type { DynamicsMeter } from '../dynamicsTypes'
import { dynamicsSettingsFor } from '../processingGraph'
import { synthesizeHallIR } from './hallImpulse'
import {
  CINEMA_REFLECTIONS,
  CINEMA_TIMBRE_EQ,
  cinemaSettings,
  HALL_ER_TAPS_MS,
  HALL_SEND_HIGHPASS_HZ,
  HALL_SEND_LOWPASS_HZ,
  hallSettings,
  WIDE_AMBIENCE_HIGHPASS_HZ,
  WIDE_SHELF_HZ,
  wideSettings,
  WIDE_MAX_SIDE_GAIN_DB,
  type ActiveSpatialMode,
  type SpatialParams,
} from './spatialSpec'

const PARAM_TC = 0.03
const MODE_FADE_SECONDS = 0.08
const BYPASS_FADE_SECONDS = 0.04
const IR_FADE_SECONDS = 0.15
/** lowpass/highpass の Q は dB 指定。Butterworth 相当 */
const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2)
/** 出力段のリミッター（重低音エンジンのワークレットを低域入力なしで使う）の低域しきい値。到達しない値 */
const LIMITER_ONLY_BASS_THRESHOLD_DB = 100

const dbToGain = (db: number) => Math.pow(10, db / 20)
const deg = (d: number) => (d * Math.PI) / 180

function holdAt(param: AudioParam, time: number): void {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(time)
  } else {
    const v = param.value
    param.cancelScheduledValues(time)
    param.setValueAtTime(v, time)
  }
}

function setParam(ctx: BaseAudioContext, param: AudioParam, value: number, smooth: boolean, tc = PARAM_TC): void {
  if (!smooth) {
    param.cancelScheduledValues(0)
    param.value = value
    return
  }
  const t = ctx.currentTime
  holdAt(param, t)
  param.setTargetAtTime(value, t, tc)
}

function rampLinear(ctx: BaseAudioContext, param: AudioParam, value: number, seconds: number): void {
  const t = ctx.currentTime
  holdAt(param, t)
  param.linearRampToValueAtTime(value, t + seconds)
}

const stereoGain = (ctx: BaseAudioContext, gain = 1) =>
  new GainNode(ctx, { gain, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
const monoGain = (ctx: BaseAudioContext, gain = 1) =>
  new GainNode(ctx, { gain, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' })

interface ModeChain {
  input: AudioNode
  output: AudioNode
  /** 直接音経路の遅延（WET/DRY 混合時に原音側をそろえる） */
  latencySeconds: number
  update(p: SpatialParams, smooth: boolean): void
  /** WIDE のみ: Side ゲインの上限 */
  setSideCap?(capDb: number, smooth: boolean): void
}

// ---------------- WIDE: Mid/Side ----------------

function createWide(ctx: BaseAudioContext, p: SpatialParams, sideCapDb: number): ModeChain {
  let cap = sideCapDb
  let params = p
  const s = wideSettings(p, cap)
  const input = stereoGain(ctx)
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 })
  input.connect(split)
  const mid = monoGain(ctx, 0.5)
  const side = monoGain(ctx, 0.5)
  const invR = monoGain(ctx, -1)
  split.connect(mid, 0)
  split.connect(mid, 1)
  split.connect(side, 0)
  split.connect(invR, 1).connect(side)

  // Side にだけハイシェルフ（0 dB で恒等。低域の Side はほぼ変わらない）
  const sideShelf = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: WIDE_SHELF_HZ, gain: s.sideHighGainDb })
  const sideOut = monoGain(ctx)
  side.connect(sideShelf).connect(sideOut)

  // 擬似アンビエンス: Mid 高域の遅延 2 タップ（逆相）を Side にのみ加える → モノラル和で完全に消える
  const ambHp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: WIDE_AMBIENCE_HIGHPASS_HZ, Q: BUTTERWORTH_Q_DB })
  const d1 = new DelayNode(ctx, { maxDelayTime: 0.1, delayTime: s.ambienceDelaysMs[0] / 1000 })
  const d2 = new DelayNode(ctx, { maxDelayTime: 0.1, delayTime: s.ambienceDelaysMs[1] / 1000 })
  const a1 = monoGain(ctx, s.ambienceGain)
  const a2 = monoGain(ctx, -0.7 * s.ambienceGain)
  const ambLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 9000, Q: BUTTERWORTH_Q_DB })
  mid.connect(ambHp)
  ambHp.connect(d1).connect(a1).connect(ambLp)
  ambHp.connect(d2).connect(a2).connect(ambLp)
  ambLp.connect(sideOut)

  // L = M + S', R = M − S'
  const lOut = monoGain(ctx)
  const rOut = monoGain(ctx)
  mid.connect(lOut)
  sideOut.connect(lOut)
  mid.connect(rOut)
  sideOut.connect(monoGain(ctx, -1)).connect(rOut)
  const merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 })
  lOut.connect(merge, 0, 0)
  rOut.connect(merge, 0, 1)

  const apply = (smooth: boolean) => {
    const n = wideSettings(params, cap)
    setParam(ctx, sideShelf.gain, n.sideHighGainDb, smooth)
    setParam(ctx, d1.delayTime, n.ambienceDelaysMs[0] / 1000, smooth, 0.1)
    setParam(ctx, d2.delayTime, n.ambienceDelaysMs[1] / 1000, smooth, 0.1)
    setParam(ctx, a1.gain, n.ambienceGain, smooth)
    setParam(ctx, a2.gain, -0.7 * n.ambienceGain, smooth)
  }

  return {
    input,
    output: merge,
    latencySeconds: 0,
    setSideCap(capDb, smooth) {
      cap = capDb
      apply(smooth)
    },
    update(np, smooth) {
      params = np
      apply(smooth)
    },
  }
}

// ---------------- CINEMA: HRTF 仮想スピーカー ----------------

function createHrtfPanner(ctx: BaseAudioContext, azimuthDeg: number, elevationDeg: number): PannerNode {
  const [x, y, z] = direction(azimuthDeg, elevationDeg)
  return new PannerNode(ctx, {
    panningModel: 'HRTF',
    // 距離減衰は使わず（rolloff 0）、距離感は直接音レベル・空気吸収・反射の時間差で自前に制御する
    distanceModel: 'linear',
    rolloffFactor: 0,
    positionX: x,
    positionY: y,
    positionZ: z,
  })
}

/** 聴取者は原点で −Z 方向を向く。方位角は右が正 */
function direction(azimuthDeg: number, elevationDeg: number): [number, number, number] {
  const az = deg(azimuthDeg)
  const el = deg(elevationDeg)
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)]
}

function setPannerDirection(ctx: BaseAudioContext, p: PannerNode, azimuthDeg: number, elevationDeg: number, smooth: boolean) {
  const [x, y, z] = direction(azimuthDeg, elevationDeg)
  setParam(ctx, p.positionX, x, smooth, 0.05)
  setParam(ctx, p.positionY, y, smooth, 0.05)
  setParam(ctx, p.positionZ, z, smooth, 0.05)
}

function reflectionAzimuth(sign: number, speakerAngle: number, r: (typeof CINEMA_REFLECTIONS)[number]): number {
  return r.azimuthDeg === 0 ? sign * speakerAngle : sign * r.azSign * r.azimuthDeg
}

const reflectionDelaySeconds = (baseMs: number, roomScale: number, itdgScale: number) => (baseMs * roomScale * itdgScale) / 1000

function createCinema(ctx: BaseAudioContext, p: SpatialParams, hrtfLatencySeconds: number): ModeChain {
  const s = cinemaSettings(p)
  const input = stereoGain(ctx)
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 })
  // HRTF の音色補正 EQ（入力側に掛け、直接音・反射音の両方に効かせる）
  const eqOut = CINEMA_TIMBRE_EQ.reduce<AudioNode>(
    (prev, b) => prev.connect(new BiquadFilterNode(ctx, { type: b.type, frequency: b.frequency, Q: b.q ?? 1, gain: b.gainDb })),
    input,
  )
  eqOut.connect(split)
  const sum = stereoGain(ctx)

  interface SideNodes {
    sign: number
    air: BiquadFilterNode
    direct: GainNode
    directPanner: PannerNode
    refl: { delay: DelayNode; gain: GainNode; panner: PannerNode }[]
  }
  const sides: SideNodes[] = [0, 1].map((c) => {
    const sign = c === 0 ? -1 : 1
    const src = monoGain(ctx)
    split.connect(src, c)
    const air = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: s.airLowpassHz, Q: BUTTERWORTH_Q_DB })
    const direct = monoGain(ctx, s.directGain)
    const directPanner = createHrtfPanner(ctx, sign * s.speakerAngleDeg, 0)
    src.connect(air).connect(direct).connect(directPanner).connect(sum)
    const refl = CINEMA_REFLECTIONS.map((r) => {
      const delay = new DelayNode(ctx, { maxDelayTime: 0.1, delayTime: reflectionDelaySeconds(r.baseDelayMs, s.roomScale, s.itdgScale) })
      const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: r.lowpassHz, Q: BUTTERWORTH_Q_DB })
      const gain = monoGain(ctx, r.gain * s.reflectionLevel)
      const panner = createHrtfPanner(ctx, reflectionAzimuth(sign, s.speakerAngleDeg, r), r.elevationDeg)
      src.connect(delay).connect(lp).connect(gain).connect(panner).connect(sum)
      return { delay, gain, panner }
    })
    return { sign, air, direct, directPanner, refl }
  })

  return {
    input,
    output: sum,
    latencySeconds: hrtfLatencySeconds,
    update(np, smooth) {
      const n = cinemaSettings(np)
      for (const side of sides) {
        setParam(ctx, side.air.frequency, n.airLowpassHz, smooth)
        setParam(ctx, side.direct.gain, n.directGain, smooth)
        setPannerDirection(ctx, side.directPanner, side.sign * n.speakerAngleDeg, 0, smooth)
        side.refl.forEach((nodes, i) => {
          const r = CINEMA_REFLECTIONS[i]
          setParam(ctx, nodes.delay.delayTime, reflectionDelaySeconds(r.baseDelayMs, n.roomScale, n.itdgScale), smooth, 0.1)
          setParam(ctx, nodes.gain.gain, r.gain * n.reflectionLevel, smooth)
          setPannerDirection(ctx, nodes.panner, reflectionAzimuth(side.sign, n.speakerAngleDeg, r), r.elevationDeg, smooth)
        })
      }
    },
  }
}

// ---------------- HALL: 直接音 + 初期反射 + 後期残響 ----------------

function hallIrBuffer(ctx: BaseAudioContext, rt60: number): AudioBuffer {
  const [l, r] = synthesizeHallIR(rt60, ctx.sampleRate)
  const buf = new AudioBuffer({ length: l.length, numberOfChannels: 2, sampleRate: ctx.sampleRate })
  buf.copyToChannel(l as Float32Array<ArrayBuffer>, 0)
  buf.copyToChannel(r as Float32Array<ArrayBuffer>, 1)
  return buf
}

/** 初期反射タップ: 左右で遅延をずらし、出力チャンネルを交互にして無相関にする */
function erTaps(scale: number) {
  const taps: { inCh: number; outCh: number; delayMs: number; gain: number }[] = []
  let energy = 0
  for (let c = 0; c < 2; c++) {
    HALL_ER_TAPS_MS.forEach((ms, k) => {
      const g = Math.pow(0.78, k) * (k % 3 === 2 ? -1 : 1)
      taps.push({ inCh: c, outCh: (c + k) % 2, delayMs: ms * scale * (c === 1 ? 1.09 : 1), gain: g })
      energy += g * g
    })
  }
  // 片チャンネル入力あたりのエネルギーを 1 に正規化
  const norm = 1 / Math.sqrt(energy / 2)
  return taps.map((t) => ({ ...t, gain: t.gain * norm }))
}

function createHall(ctx: BaseAudioContext, p: SpatialParams): ModeChain {
  let s = hallSettings(p)
  const input = stereoGain(ctx)
  const out = stereoGain(ctx)

  const directLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: s.directLowpassHz, Q: BUTTERWORTH_Q_DB })
  const direct = stereoGain(ctx, dbToGain(s.directGainDb))
  input.connect(directLp).connect(direct).connect(out)

  const sendHp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: HALL_SEND_HIGHPASS_HZ, Q: BUTTERWORTH_Q_DB })
  const sendLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: HALL_SEND_LOWPASS_HZ, Q: BUTTERWORTH_Q_DB })
  input.connect(sendHp).connect(sendLp)

  // 初期反射
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 })
  const merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 })
  sendLp.connect(split)
  const erGain = stereoGain(ctx, s.erGain)
  const tapNodes = erTaps(s.erScale).map((t) => {
    const delay = new DelayNode(ctx, { maxDelayTime: 0.2, delayTime: t.delayMs / 1000 })
    const gain = monoGain(ctx, t.gain)
    split.connect(delay, t.inCh)
    delay.connect(gain).connect(merge, 0, t.outCh)
    return delay
  })
  merge.connect(erGain).connect(out)

  // 後期残響（モノラル送り × 左右無相関 IR = ステレオ残響）。IR 切替は 2 つのコンボルバーでクロスフェード
  const lateSend = monoGain(ctx)
  const preDelay = new DelayNode(ctx, { maxDelayTime: 0.2, delayTime: s.preDelayMs / 1000 })
  sendLp.connect(lateSend).connect(preDelay)
  const late = stereoGain(ctx, dbToGain(s.lateGainDb))
  const convs = [0, 1].map(() => {
    const conv = new ConvolverNode(ctx, { disableNormalization: true })
    const g = stereoGain(ctx, 0)
    preDelay.connect(conv).connect(g).connect(late)
    return { conv, g }
  })
  convs[0].conv.buffer = hallIrBuffer(ctx, s.rt60)
  convs[0].g.gain.value = 1
  let active = 0
  let activeRt60 = s.rt60
  late.connect(out)

  return {
    input,
    output: out,
    latencySeconds: 0,
    update(np, smooth) {
      s = hallSettings(np)
      setParam(ctx, directLp.frequency, s.directLowpassHz, smooth)
      setParam(ctx, direct.gain, dbToGain(s.directGainDb), smooth)
      setParam(ctx, erGain.gain, s.erGain, smooth)
      setParam(ctx, preDelay.delayTime, s.preDelayMs / 1000, smooth, 0.1)
      setParam(ctx, late.gain, dbToGain(s.lateGainDb), smooth)
      erTaps(s.erScale).forEach((t, i) => setParam(ctx, tapNodes[i].delayTime, t.delayMs / 1000, smooth, 0.1))
      if (Math.abs(s.rt60 - activeRt60) > 0.03) {
        const next = 1 - active
        convs[next].conv.buffer = hallIrBuffer(ctx, s.rt60)
        if (smooth) {
          rampLinear(ctx, convs[next].g.gain, 1, IR_FADE_SECONDS)
          rampLinear(ctx, convs[active].g.gain, 0, IR_FADE_SECONDS)
        } else {
          setParam(ctx, convs[next].g.gain, 1, false)
          setParam(ctx, convs[active].g.gain, 0, false)
        }
        active = next
        activeRt60 = s.rt60
      }
    },
  }
}

// ---------------- グラフ全体 ----------------

export interface SpatialGraph {
  input: AudioNode
  output: AudioNode
  engine: 'worklet' | 'fallback'
  setParams(p: SpatialParams, smooth: boolean): void
  setTrimDb(db: number, smooth?: boolean): void
  /** WIDE の Side ゲイン上限（原音の幅から決まる） */
  setWideSideCap(capDb: number, smooth?: boolean): void
  setBypass(bypass: boolean, smooth: boolean): void
  onMeter(listener: ((m: DynamicsMeter) => void) | null): void
}

export interface SpatialGraphOptions {
  params: SpatialParams
  bypass: boolean
  trimDb: number
  useWorklet: boolean
  hrtfLatencySeconds: number
  /** WIDE の Side ゲイン上限（dB）。省略時は最大 */
  wideSideCapDb?: number
  /** 構築するモード（オフライン解析では使用中のモードだけ作って計算量を減らす） */
  modes?: ActiveSpatialMode[]
  limiterEnabled?: boolean
  reportIntervalMs?: number
}

/**
 * 空間処理グラフ:
 *
 *   input ─┬─ bypassDry ──────────────────────────────────────────────────────────────┬─ output
 *          └─ ステレオ化 ─┬─ [WIDE | CINEMA | HALL]（選択中のみ有効）→ wet ┐            │
 *                        └─ 遅延補正（HRTF 遅延）→ dry ─────────────────────┴→ トリム → リミッター → bypassWet ┘
 *
 * bypassDry 経路はゲイン 1 のみで原音とビット一致する。
 */
export function createSpatialGraph(ctx: BaseAudioContext, opts: SpatialGraphOptions): SpatialGraph {
  const input = new GainNode(ctx)
  const output = new GainNode(ctx)
  const bypassDry = new GainNode(ctx, { gain: opts.bypass ? 1 : 0 })
  const bypassWet = new GainNode(ctx, { gain: opts.bypass ? 0 : 1 })
  input.connect(bypassDry).connect(output)

  const root = stereoGain(ctx)
  input.connect(root)
  const w = Math.min(Math.max(opts.params.wetDry / 100, 0), 1)
  const wetSum = stereoGain(ctx)
  const mixWet = stereoGain(ctx, w)
  const mixDry = stereoGain(ctx, 1 - w)
  const dryAlign = new DelayNode(ctx, { maxDelayTime: 0.1, channelCount: 2, channelCountMode: 'explicit' })
  const mixSum = stereoGain(ctx)
  root.connect(dryAlign).connect(mixDry).connect(mixSum)
  wetSum.connect(mixWet).connect(mixSum)

  const builders: Record<ActiveSpatialMode, () => ModeChain> = {
    wide: () => createWide(ctx, opts.params, opts.wideSideCapDb ?? WIDE_MAX_SIDE_GAIN_DB),
    cinema: () => createCinema(ctx, opts.params, opts.hrtfLatencySeconds),
    hall: () => createHall(ctx, opts.params),
  }
  const modes = opts.modes ?? (['wide', 'cinema', 'hall'] as ActiveSpatialMode[])
  const chains: Partial<Record<ActiveSpatialMode, { chain: ModeChain; gateIn: GainNode; gateOut: GainNode }>> = {}
  for (const m of modes) {
    const chain = builders[m]()
    const on = opts.params.mode === m ? 1 : 0
    const gateIn = stereoGain(ctx, on)
    const gateOut = stereoGain(ctx, on)
    root.connect(gateIn).connect(chain.input)
    chain.output.connect(gateOut).connect(wetSum)
    chains[m] = { chain, gateIn, gateOut }
  }
  let currentMode = opts.params.mode
  if (currentMode !== 'off') dryAlign.delayTime.value = chains[currentMode]?.chain.latencySeconds ?? 0

  let worklet: AudioWorkletNode | null = null
  let trim: GainNode | null = null
  let meterListener: ((m: DynamicsMeter) => void) | null = null
  if (opts.useWorklet) {
    worklet = new AudioWorkletNode(ctx, 'csx-bass-dynamics', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'clamped-max',
      channelInterpretation: 'speakers',
      processorOptions: dynamicsSettingsFor('normal', LIMITER_ONLY_BASS_THRESHOLD_DB, opts.trimDb, {
        limiterEnabled: opts.limiterEnabled ?? true,
        reportIntervalMs: opts.reportIntervalMs ?? 0,
      }),
    })
    // 低域入力（0）は接続しない。入力 1 に全帯域を入れ、トリム＋サンプルピークリミッターだけを使う
    mixSum.connect(worklet, 0, 1)
    worklet.connect(bypassWet).connect(output)
    worklet.port.onmessage = (e: MessageEvent<DynamicsMeter>) => meterListener?.(e.data)
  } else {
    trim = stereoGain(ctx, dbToGain(Math.min(0, opts.trimDb)))
    mixSum.connect(trim).connect(bypassWet).connect(output)
  }

  return {
    input,
    output,
    engine: worklet ? 'worklet' : 'fallback',
    setParams(p, smooth) {
      const nw = Math.min(Math.max(p.wetDry / 100, 0), 1)
      setParam(ctx, mixWet.gain, nw, smooth)
      setParam(ctx, mixDry.gain, 1 - nw, smooth)
      for (const m of modes) chains[m]?.chain.update(p, smooth)
      if (p.mode !== currentMode) {
        for (const m of modes) {
          const c = chains[m]
          if (!c) continue
          const on = p.mode === m ? 1 : 0
          if (smooth) {
            rampLinear(ctx, c.gateIn.gain, on, MODE_FADE_SECONDS)
            rampLinear(ctx, c.gateOut.gain, on, MODE_FADE_SECONDS)
          } else {
            setParam(ctx, c.gateIn.gain, on, false)
            setParam(ctx, c.gateOut.gain, on, false)
          }
        }
        if (p.mode !== 'off') setParam(ctx, dryAlign.delayTime, chains[p.mode]?.chain.latencySeconds ?? 0, smooth)
        currentMode = p.mode
      }
    },
    setTrimDb(db, smooth = true) {
      if (worklet) worklet.port.postMessage({ trimDb: db })
      else if (trim) setParam(ctx, trim.gain, dbToGain(Math.min(0, db)), smooth, 0.08)
    },
    setWideSideCap(capDb, smooth = true) {
      chains.wide?.chain.setSideCap?.(capDb, smooth)
    },
    setBypass(b, smooth) {
      for (const [node, target] of [
        [bypassDry, b ? 1 : 0],
        [bypassWet, b ? 0 : 1],
      ] as const) {
        if (smooth) rampLinear(ctx, node.gain, target, BYPASS_FADE_SECONDS)
        else setParam(ctx, node.gain, target, false)
      }
    },
    onMeter(listener) {
      meterListener = listener
    },
  }
}

const hrtfLatencyCache = new Map<number, Promise<number>>()

/**
 * HRTF PannerNode の処理遅延を実測する（WET/DRY 混合時に原音側の遅延をそろえ、コムフィルターを防ぐため）。
 * 正面に置いたパンナーへインパルスを入れ、出力の最大値の位置を遅延とみなす。
 */
export function measureHrtfLatency(sampleRate: number): Promise<number> {
  let p = hrtfLatencyCache.get(sampleRate)
  if (!p) {
    p = (async () => {
      const len = Math.round(sampleRate * 0.1)
      const ctx = new OfflineAudioContext(2, len, sampleRate)
      const imp = new AudioBuffer({ length: len, numberOfChannels: 1, sampleRate })
      imp.getChannelData(0)[0] = 1
      const src = new AudioBufferSourceNode(ctx, { buffer: imp })
      src.connect(createHrtfPanner(ctx, 0, 0)).connect(ctx.destination)
      src.start()
      const out = (await ctx.startRendering()).getChannelData(0)
      let idx = 0
      for (let i = 1; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[idx])) idx = i
      return idx / sampleRate
    })()
    hrtfLatencyCache.set(sampleRate, p)
  }
  return p
}

