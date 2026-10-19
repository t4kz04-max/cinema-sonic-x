import type { DynamicsMeter } from '../dynamicsTypes'
import motionWorkletUrl from '../worklets/motion.worklet.ts?worker&url'
import { SPEAKER_AZIMUTHS, SPEAKER_COUNT, type Envelope } from './motion'
import { MOTION_FFT_SIZE, type MotionMessage, type MotionReport, type MotionTransport, type MotionWorkletOptions } from './motionTypes'
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
  isMotionActive,
  motionControl,
  motionLayout,
  motionSupported,
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

/** start 秒後から MODE_FADE_SECONDS の線形フェード（smooth=false なら即時） */
function fadeGate(ctx: BaseAudioContext, param: AudioParam, target: number, smooth: boolean, start = 0): void {
  if (!smooth) {
    setParam(ctx, param, target, false)
    return
  }
  const t0 = ctx.currentTime + start
  holdAt(param, ctx.currentTime)
  param.setValueAtTime(param.value, t0)
  param.linearRampToValueAtTime(target, t0 + MODE_FADE_SECONDS)
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
  /** CINEMA / HALL のみ: 直接音の ON/OFF（Motion ON 時は Motion が直接音を担当する）。start 秒後から切り替える */
  setDirectEnabled?(on: boolean, smooth: boolean, start?: number): void
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
    direct: { air: BiquadFilterNode; gain: GainNode; gate: GainNode; panner: PannerNode }
    refl: { delay: DelayNode; gain: GainNode; panner: PannerNode }[]
  }
  const sides: SideNodes[] = [0, 1].map((c) => {
    const sign = c === 0 ? -1 : 1
    const src = monoGain(ctx)
    split.connect(src, c)
    const air = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: s.airLowpassHz, Q: BUTTERWORTH_Q_DB })
    const gain = monoGain(ctx, s.directGain)
    // Motion ON 時に直接音だけを止めるゲート（通常は 1）
    const gate = monoGain(ctx, 1)
    const panner = createHrtfPanner(ctx, sign * s.speakerAngleDeg, 0)
    src.connect(air).connect(gain).connect(gate).connect(panner).connect(sum)
    const direct = { air, gain, gate, panner }
    const refl = CINEMA_REFLECTIONS.map((r) => {
      const delay = new DelayNode(ctx, { maxDelayTime: 0.1, delayTime: reflectionDelaySeconds(r.baseDelayMs, s.roomScale, s.itdgScale) })
      const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: r.lowpassHz, Q: BUTTERWORTH_Q_DB })
      const gain = monoGain(ctx, r.gain * s.reflectionLevel)
      const panner = createHrtfPanner(ctx, reflectionAzimuth(sign, s.speakerAngleDeg, r), r.elevationDeg)
      src.connect(delay).connect(lp).connect(gain).connect(panner).connect(sum)
      return { delay, gain, panner }
    })
    return { sign, direct, refl }
  })

  return {
    input,
    output: sum,
    latencySeconds: hrtfLatencySeconds,
    setDirectEnabled(on, smooth, start = 0) {
      for (const side of sides) fadeGate(ctx, side.direct.gate.gain, on ? 1 : 0, smooth, start)
    },
    update(np, smooth) {
      const n = cinemaSettings(np)
      for (const side of sides) {
        setParam(ctx, side.direct.air.frequency, n.airLowpassHz, smooth)
        setParam(ctx, side.direct.gain.gain, n.directGain, smooth)
        setPannerDirection(ctx, side.direct.panner, side.sign * n.speakerAngleDeg, 0, smooth)
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
  // Motion ON 時に直接音だけを止めるゲート（通常は 1）
  const directGate = stereoGain(ctx, 1)
  input.connect(directLp).connect(direct).connect(directGate).connect(out)

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
    setDirectEnabled(on, smooth, start = 0) {
      fadeGate(ctx, directGate.gain, on ? 1 : 0, smooth, start)
    },
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

// ---------------- MOTION: Dynamic Spatial Motion Engine ----------------

const motionLoads = new WeakMap<BaseAudioContext, Promise<boolean>>()

/** Motion Engine の AudioWorklet を読み込む。非対応なら false */
export function loadMotionWorklet(ctx: BaseAudioContext): Promise<boolean> {
  let p = motionLoads.get(ctx)
  if (!p) {
    p =
      typeof AudioWorkletNode === 'undefined' || !ctx.audioWorklet
        ? Promise.resolve(false)
        : ctx.audioWorklet.addModule(motionWorkletUrl).then(
            () => true,
            () => false,
          )
    motionLoads.set(ctx, p)
  }
  return p
}

export const DEFAULT_TRANSPORT: MotionTransport = { playing: true, startedAt: 0, pausedAt: 0 }

/** Motion ON への切替は、休止中のワークレットが STFT 遅延分の音をためてから始める */
const MOTION_WAKE_SECONDS = 0.06

interface MotionChain {
  input: AudioNode
  /** 12 方向の固定 HRTF で描画した直接音（バイノーラル） */
  ring: AudioNode
  /** 原音を STFT 遅延分遅らせた L/R（CINEMA の反射音の送り） */
  aligned: AudioNode
  /** さらに HRTF の遅延分遅らせた L/R（HRTF を通らない HALL の初期反射・残響の送り） */
  alignedHall: AudioNode
  latencySeconds: number
  post(message: MotionMessage): void
  onReport(listener: ((r: MotionReport) => void) | null): void
}

/**
 * Motion チェーン（直接音のみ）:
 *   input ─→ [csx-motion] ─ 出力0（12ch）→ 12 方向の固定 HRTF → 音色補正 EQ → ring
 *                        └ 出力1（遅延をそろえた原音 L/R）→ aligned / alignedHall
 * 反射音・残響は既存の CINEMA / HALL チェーンの部品を、入力を aligned に切り替えて再利用する（二重に持たない）。
 */
function createMotion(
  ctx: BaseAudioContext,
  p: SpatialParams,
  hrtfLatencySeconds: number,
  transport: MotionTransport,
  envelope: Envelope | null,
  reportIntervalMs: number,
): MotionChain {
  const input = stereoGain(ctx)
  const options: MotionWorkletOptions = {
    layout: motionLayout(p),
    control: motionControl(p),
    transport,
    envelope,
    reportIntervalMs,
  }
  const worklet = new AudioWorkletNode(ctx, 'csx-motion', {
    numberOfInputs: 1,
    numberOfOutputs: 2,
    outputChannelCount: [SPEAKER_COUNT, 2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: options,
  })
  input.connect(worklet)

  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: SPEAKER_COUNT })
  worklet.connect(split, 0)
  const ringSum = stereoGain(ctx)
  SPEAKER_AZIMUTHS.forEach((az, i) => {
    const panner = createHrtfPanner(ctx, az, 0)
    split.connect(panner, i)
    panner.connect(ringSum)
  })
  const ring = CINEMA_TIMBRE_EQ.reduce<AudioNode>(
    (prev, b) => prev.connect(new BiquadFilterNode(ctx, { type: b.type, frequency: b.frequency, Q: b.q ?? 1, gain: b.gainDb })),
    ringSum,
  )

  const aligned = stereoGain(ctx)
  worklet.connect(aligned, 1)
  const alignedHall = new DelayNode(ctx, { maxDelayTime: 0.1, delayTime: hrtfLatencySeconds, channelCount: 2, channelCountMode: 'explicit' })
  aligned.connect(alignedHall)

  let reportListener: ((r: MotionReport) => void) | null = null
  worklet.port.onmessage = (e: MessageEvent<MotionReport>) => reportListener?.(e.data)

  return {
    input,
    ring,
    aligned,
    alignedHall,
    latencySeconds: MOTION_FFT_SIZE / ctx.sampleRate + hrtfLatencySeconds,
    post: (m) => worklet.port.postMessage(m),
    onReport(listener) {
      reportListener = listener
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
  /** Motion Engine が使えるか（AudioWorklet 読み込み済み） */
  motionAvailable: boolean
  /** 再生位置の基準（再生開始・一時停止・シーク時に送る） */
  setTransport(transport: MotionTransport): void
  /** PULSE 用のエネルギー包絡 */
  setEnvelope(envelope: Envelope | null): void
  /** Motion Engine が実際に使っている位置の通知 */
  onMotionReport(listener: ((r: MotionReport) => void) | null): void
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
  /** Motion Engine を構築する（事前に loadMotionWorklet が必要） */
  motion?: {
    transport?: MotionTransport
    envelope?: Envelope | null
    reportIntervalMs?: number
  }
}

interface ChainSlot {
  chain: ModeChain
  /** root → チェーン入力（Motion OFF 時） */
  gateIn: GainNode
  /** Motion の遅延をそろえた原音 → チェーン入力（Motion ON 時、CINEMA / HALL のみ） */
  alignGate: GainNode | null
  /** alignGate への入力元 */
  alignSource: AudioNode | null
  gateOut: GainNode
  /** 入力が接続されているか（使わないチェーンは切り離して CPU を使わせない） */
  inConnected: boolean
  alignConnected: boolean
  disconnectTimer: ReturnType<typeof setTimeout> | null
}

/** フェードアウト完了後、入力を切り離すまでの余裕（秒） */
const DISCONNECT_MARGIN_SECONDS = 0.1

/**
 * 空間処理グラフ:
 *
 *   input ─┬─ bypassDry ──────────────────────────────────────────────────────────────────┬─ output
 *          └─ ステレオ化 ─┬─ [WIDE | CINEMA | HALL]（選択中のみ）──────────────→ wet ┐       │
 *                        ├─ [MOTION] ─ 直接音（12 方向 HRTF）──────────────→ wet │       │
 *                        │           └ 遅延をそろえた原音 → CINEMA/HALL の入力   │       │
 *                        └─ 遅延補正 → dry ────────────────────────────────────────┴→ トリム → リミッター → bypassWet ┘
 *
 * Motion ON（CINEMA / HALL）: モードのチェーンの直接音を止め、入力を Motion の遅延をそろえた原音に切り替えて
 * 反射音・残響だけを使う。直接音は Motion の 12 方向 HRTF が担当する。
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
  const dryAlign = new DelayNode(ctx, { maxDelayTime: 0.2, channelCount: 2, channelCountMode: 'explicit' })
  const mixSum = stereoGain(ctx)
  root.connect(dryAlign).connect(mixDry).connect(mixSum)
  wetSum.connect(mixWet).connect(mixSum)

  const motion = opts.motion
    ? createMotion(
        ctx,
        opts.params,
        opts.hrtfLatencySeconds,
        opts.motion.transport ?? DEFAULT_TRANSPORT,
        opts.motion.envelope ?? null,
        opts.motion.reportIntervalMs ?? 0,
      )
    : null
  const motionOn = (p: SpatialParams) => !!motion && isMotionActive(p)

  const builders: Record<ActiveSpatialMode, () => ModeChain> = {
    wide: () => createWide(ctx, opts.params, opts.wideSideCapDb ?? WIDE_MAX_SIDE_GAIN_DB),
    cinema: () => createCinema(ctx, opts.params, opts.hrtfLatencySeconds),
    hall: () => createHall(ctx, opts.params),
  }
  const modes = opts.modes ?? (['wide', 'cinema', 'hall'] as ActiveSpatialMode[])
  const slots: Partial<Record<ActiveSpatialMode, ChainSlot>> = {}
  const initialMotion = motionOn(opts.params)
  // 使わないチェーンの入力は切り離しておく（ゲイン 0 で接続したままだと、無音でも畳み込み・HRTF の処理が続き CPU を使う）
  const setInputs = (slot: ChainSlot, wantIn: boolean, wantAlign: boolean) => {
    if (wantIn && !slot.inConnected) root.connect(slot.gateIn)
    if (!wantIn && slot.inConnected) root.disconnect(slot.gateIn)
    slot.inConnected = wantIn
    if (slot.alignGate && slot.alignSource) {
      if (wantAlign && !slot.alignConnected) slot.alignSource.connect(slot.alignGate)
      if (!wantAlign && slot.alignConnected) slot.alignSource.disconnect(slot.alignGate)
      slot.alignConnected = wantAlign
    }
  }
  for (const m of modes) {
    const chain = builders[m]()
    const active = opts.params.mode === m
    const useMotion = active && initialMotion
    const gateIn = stereoGain(ctx, active && !useMotion ? 1 : 0)
    const gateOut = stereoGain(ctx, active ? 1 : 0)
    gateIn.connect(chain.input)
    chain.output.connect(gateOut).connect(wetSum)
    let alignGate: GainNode | null = null
    let alignSource: AudioNode | null = null
    if (motion && motionSupported(m)) {
      alignGate = stereoGain(ctx, useMotion ? 1 : 0)
      alignSource = m === 'hall' ? motion.alignedHall : motion.aligned
      alignGate.connect(chain.input)
      chain.setDirectEnabled?.(!useMotion, false)
    }
    const slot: ChainSlot = { chain, gateIn, alignGate, alignSource, gateOut, inConnected: false, alignConnected: false, disconnectTimer: null }
    setInputs(slot, active && !useMotion, useMotion)
    slots[m] = slot
  }
  let ringGate: GainNode | null = null
  if (motion) {
    root.connect(motion.input)
    ringGate = stereoGain(ctx, initialMotion ? 1 : 0)
    motion.ring.connect(ringGate).connect(wetSum)
  }

  const latencyOf = (p: SpatialParams) =>
    p.mode === 'off' ? 0 : motionOn(p) ? motion!.latencySeconds : (slots[p.mode]?.chain.latencySeconds ?? 0)
  dryAlign.delayTime.value = latencyOf(opts.params)
  let current = { mode: opts.params.mode, motion: initialMotion }

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
      for (const m of modes) slots[m]?.chain.update(p, smooth)
      // Motion の位置・パラメーター（OFF ならワークレットはフェード後に休止する）
      motion?.post({ type: 'params', layout: motionLayout(p), control: motionControl(p) })

      const next = { mode: p.mode, motion: motionOn(p) }
      if (next.mode === current.mode && next.motion === current.motion) return
      // Motion を ON にする場合は、休止していたワークレットに音がたまるまで切替開始を遅らせる
      const start = next.motion && !current.motion ? MOTION_WAKE_SECONDS : 0
      for (const m of modes) {
        const slot = slots[m]
        if (!slot) continue
        const active = next.mode === m
        const useMotion = active && next.motion
        // フェードイン側は先に接続し、フェードアウト側はフェード完了後に切り離す
        const wantIn = active && !useMotion
        const wantAlign = useMotion
        if (slot.disconnectTimer) clearTimeout(slot.disconnectTimer)
        setInputs(slot, wantIn || slot.inConnected, wantAlign || slot.alignConnected)
        slot.disconnectTimer = setTimeout(
          () => {
            slot.disconnectTimer = null
            setInputs(slot, wantIn, wantAlign)
          },
          (start + MODE_FADE_SECONDS + DISCONNECT_MARGIN_SECONDS) * 1000 * (smooth ? 1 : 0),
        )
        fadeGate(ctx, slot.gateIn.gain, active && !useMotion ? 1 : 0, smooth, start)
        fadeGate(ctx, slot.gateOut.gain, active ? 1 : 0, smooth, start)
        if (slot.alignGate) fadeGate(ctx, slot.alignGate.gain, useMotion ? 1 : 0, smooth, start)
        if (motionSupported(m)) slot.chain.setDirectEnabled?.(!useMotion, smooth, start)
      }
      if (ringGate) fadeGate(ctx, ringGate.gain, next.motion ? 1 : 0, smooth, start)
      if (next.mode !== 'off') {
        const t0 = ctx.currentTime + start
        if (smooth) {
          holdAt(dryAlign.delayTime, ctx.currentTime)
          dryAlign.delayTime.setValueAtTime(dryAlign.delayTime.value, t0)
          dryAlign.delayTime.linearRampToValueAtTime(latencyOf(p), t0 + MODE_FADE_SECONDS)
        } else setParam(ctx, dryAlign.delayTime, latencyOf(p), false)
      }
      current = next
    },
    setTrimDb(db, smooth = true) {
      if (worklet) worklet.port.postMessage({ trimDb: db })
      else if (trim) setParam(ctx, trim.gain, dbToGain(Math.min(0, db)), smooth, 0.08)
    },
    setWideSideCap(capDb, smooth = true) {
      slots.wide?.chain.setSideCap?.(capDb, smooth)
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
    motionAvailable: !!motion,
    setTransport(transport) {
      motion?.post({ type: 'transport', transport })
    },
    setEnvelope(envelope) {
      motion?.post({ type: 'envelope', envelope })
    },
    onMotionReport(listener) {
      motion?.onReport(listener)
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

