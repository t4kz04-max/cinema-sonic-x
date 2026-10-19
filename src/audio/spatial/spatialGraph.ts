import { createAlignDelay } from '../alignDelay'
import type { DynamicsMeter } from '../dynamicsTypes'
import motionWorkletUrl from '../worklets/motion.worklet.ts?worker&url'
import { distanceDelaySeconds, SPEAKER_AZIMUTHS, SPEAKER_COUNT, type Envelope } from './motion'
import { MOTION_FFT_SIZE, type MotionMessage, type MotionReport, type MotionTransport, type MotionWorkletOptions } from './motionTypes'
import { dynamicsSettingsFor } from '../processingGraph'
import { synthesizeHallIR } from './hallImpulse'
import { BUTTERWORTH_Q_DB, dbToGain, fadeGate, holdAt, linearRampAt, MODE_FADE_SECONDS, monoGain, rampLinear, setParam, stereoGain } from './nodeUtils'
import { ReverbBus } from './reverbBus'
import { createTail, type TailChain } from './tailEngine'
import type { TailReport } from './tailTypes'
import {
  CINEMA_REFLECTIONS,
  CINEMA_TIMBRE_EQ,
  cinemaSettings,
  HALL_ER_TAPS_MS,
  HALL_SEND_HIGHPASS_HZ,
  HALL_SEND_LOWPASS_HZ,
  hallSettings,
  isMotionActive,
  isTailActive,
  motionControl,
  motionLayout,
  motionSupported,
  tailSupported,
  WIDE_AMBIENCE_HIGHPASS_HZ,
  WIDE_SHELF_HZ,
  wideSettings,
  WIDE_MAX_SIDE_GAIN_DB,
  type ActiveSpatialMode,
  type SpatialParams,
} from './spatialSpec'

const BYPASS_FADE_SECONDS = 0.04
const IR_FADE_SECONDS = 0.15
/** 出力段のリミッター（重低音エンジンのワークレットを低域入力なしで使う）の低域しきい値。到達しない値 */
const LIMITER_ONLY_BASS_THRESHOLD_DB = 100
const deg = (d: number) => (d * Math.PI) / 180

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
  /** HALL のみ: 既存の後期残響の ON/OFF（Spatial Tail ON 時は Tail が後期残響を担当する） */
  setLateEnabled?(on: boolean, smooth: boolean, start?: number): void
  /** HALL のみ: チェーン入力に時刻 at までに入った音の後期残響を消す（プリディレイ分はチェーン内で足す） */
  resetLate?(at: number, fadeSeconds: number): void
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

/**
 * 複数の出力を 2 入力ずつの木で足し合わせる。1 つの入力に 3 つ以上を接続すると、ブラウザが足す順序が
 * レンダリングごとに変わり（浮動小数点の丸めの違いで）同じ設定でも出力がわずかに変わる（12 個の HRTF の和で
 * −135 dB、Motion の後段で −110 dB を実測）。2 つの和は順序によらないため、木にすると毎回同じ値になる
 */
function sumTree(ctx: BaseAudioContext, nodes: AudioNode[]): AudioNode {
  let level = nodes
  while (level.length > 1) {
    const next: AudioNode[] = []
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i])
        continue
      }
      const g = stereoGain(ctx)
      level[i].connect(g)
      level[i + 1].connect(g)
      next.push(g)
    }
    level = next
  }
  return level[0]
}

interface SwitchedDelay {
  output: AudioNode
  setDelay(seconds: number, smooth: boolean): void
}

/**
 * 遅延時間を変えられる遅延（ステレオ）。DelayNode の delayTime を自動化すると、Chrome では固定の遅延から
 * 自動化に切り替わる瞬間に出力が飛ぶ（Phase 05 のプリセット切替で実測）。固定の遅延を 2 つ持ち、
 * 無音側に新しい遅延を設定してからゲインをクロスフェードで入れ替える（createHrtfVoice と同じ方式）
 */
function createSwitchedDelay(ctx: BaseAudioContext, input: AudioNode, seconds: number, maxSeconds: number): SwitchedDelay {
  const output = stereoGain(ctx)
  const slots = [1, 0].map((g) => {
    const delay = new DelayNode(ctx, { maxDelayTime: maxSeconds, delayTime: seconds, channelCount: 2, channelCountMode: 'explicit' })
    const gain = stereoGain(ctx, g)
    input.connect(delay).connect(gain).connect(output)
    return { delay, gain, value: seconds }
  })
  let active = 0
  let busyUntil = 0
  let pendingStart = -1
  const place = (slot: (typeof slots)[number], v: number, at: number | null) => {
    if (at === null) setParam(ctx, slot.delay.delayTime, v, false)
    else {
      slot.delay.delayTime.cancelScheduledValues(at)
      slot.delay.delayTime.setValueAtTime(v, at)
    }
    slot.value = v
  }
  return {
    output,
    setDelay(v, smooth) {
      const now = ctx.currentTime
      if (!smooth) {
        for (const slot of slots) place(slot, v, null)
        return
      }
      if (pendingStart > now) {
        place(slots[active], v, pendingStart)
        return
      }
      const cur = slots[active]
      if (cur.value === v) return
      const start = Math.max(now, busyUntil)
      const next = slots[1 - active]
      place(next, v, start)
      linearRampAt(next.gain.gain, start, 1, start + HRTF_SWAP_SECONDS)
      linearRampAt(cur.gain.gain, start, 0, start + HRTF_SWAP_SECONDS)
      active = 1 - active
      busyUntil = start + HRTF_SWAP_SECONDS
      pendingStart = start
    },
  }
}

/** HRTF の方向を変えるときのクロスフェード（秒） */
const HRTF_SWAP_SECONDS = 0.06

interface HrtfVoice {
  input: AudioNode
  output: AudioNode
  setDirection(azimuthDeg: number, elevationDeg: number, smooth: boolean): void
}

/**
 * 方向を変えられる HRTF 音源。PannerNode の位置は自動化しない（HRTF の位置を連続的に動かすと、
 * ブラウザ内部の HRIR の切替が繰り返されてクリックが出る。Phase 05 のプリセット切替で実測）。
 * 固定方向のパンナーを 2 つ持ち、無音側に新しい方向を設定してからゲインをクロスフェードで入れ替える。
 * 無音側のパンナーは入力が無音なので、ブラウザが処理を省略する
 */
function createHrtfVoice(ctx: BaseAudioContext, azimuthDeg: number, elevationDeg: number): HrtfVoice {
  const input = monoGain(ctx)
  const output = stereoGain(ctx)
  const slots = [1, 0].map((g) => {
    const gain = monoGain(ctx, g)
    const panner = createHrtfPanner(ctx, azimuthDeg, elevationDeg)
    input.connect(gain).connect(panner).connect(output)
    return { gain, panner, az: azimuthDeg, el: elevationDeg }
  })
  let active = 0
  let busyUntil = 0
  /** 最後に予約した入れ替えの開始時刻 */
  let pendingStart = -1
  const place = (slot: (typeof slots)[number], az: number, el: number, at: number | null) => {
    const v = direction(az, el)
    ;[slot.panner.positionX, slot.panner.positionY, slot.panner.positionZ].forEach((p, i) => {
      if (at === null) setParam(ctx, p, v[i], false)
      else {
        p.cancelScheduledValues(at)
        p.setValueAtTime(v[i], at)
      }
    })
    slot.az = az
    slot.el = el
  }
  return {
    input,
    output,
    setDirection(az, el, smooth) {
      const now = ctx.currentTime
      if (!smooth) {
        for (const slot of slots) place(slot, az, el, null)
        return
      }
      // 予約済みの入れ替えがまだ始まっていなければ、その方向を差し替える（スライダー操作で入れ替えが溜まらない）
      if (pendingStart > now) {
        place(slots[active], az, el, pendingStart)
        return
      }
      const cur = slots[active]
      if (cur.az === az && cur.el === el) return
      // 前の入れ替えが終わってから（無音になった側だけに新しい方向を設定する）
      const start = Math.max(now, busyUntil)
      const next = slots[1 - active]
      place(next, az, el, start)
      linearRampAt(next.gain.gain, start, 1, start + HRTF_SWAP_SECONDS)
      linearRampAt(cur.gain.gain, start, 0, start + HRTF_SWAP_SECONDS)
      active = 1 - active
      busyUntil = start + HRTF_SWAP_SECONDS
      pendingStart = start
    },
  }
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
    direct: { air: BiquadFilterNode; gain: GainNode; gate: GainNode; voice: HrtfVoice }
    refl: { delay: DelayNode; gain: GainNode; voice: HrtfVoice }[]
  }
  const sides: SideNodes[] = [0, 1].map((c) => {
    const sign = c === 0 ? -1 : 1
    const src = monoGain(ctx)
    split.connect(src, c)
    const air = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: s.airLowpassHz, Q: BUTTERWORTH_Q_DB })
    const gain = monoGain(ctx, s.directGain)
    // Motion ON 時に直接音だけを止めるゲート（通常は 1）
    const gate = monoGain(ctx, 1)
    const voice = createHrtfVoice(ctx, sign * s.speakerAngleDeg, 0)
    src.connect(air).connect(gain).connect(gate).connect(voice.input)
    voice.output.connect(sum)
    const direct = { air, gain, gate, voice }
    const refl = CINEMA_REFLECTIONS.map((r) => {
      const delay = new DelayNode(ctx, { maxDelayTime: 0.1, delayTime: reflectionDelaySeconds(r.baseDelayMs, s.roomScale, s.itdgScale) })
      const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: r.lowpassHz, Q: BUTTERWORTH_Q_DB })
      const gain = monoGain(ctx, r.gain * s.reflectionLevel)
      const voice = createHrtfVoice(ctx, reflectionAzimuth(sign, s.speakerAngleDeg, r), r.elevationDeg)
      src.connect(delay).connect(lp).connect(gain).connect(voice.input)
      voice.output.connect(sum)
      return { delay, gain, voice }
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
        side.direct.voice.setDirection(side.sign * n.speakerAngleDeg, 0, smooth)
        side.refl.forEach((nodes, i) => {
          const r = CINEMA_REFLECTIONS[i]
          setParam(ctx, nodes.delay.delayTime, reflectionDelaySeconds(r.baseDelayMs, n.roomScale, n.itdgScale), smooth, 0.1)
          setParam(ctx, nodes.gain.gain, r.gain * n.reflectionLevel, smooth)
          nodes.voice.setDirection(reflectionAzimuth(side.sign, n.speakerAngleDeg, r), r.elevationDeg, smooth)
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
  // IR の切替（クロスフェード）と残響の消去は ReverbBus が受け持つ（定常時は畳み込み 1 つ・ゲイン 1 で従来と同じ値）
  const lateBus = new ReverbBus(ctx, preDelay, late, 1)
  lateBus.setBuffer(hallIrBuffer(ctx, s.rt60), 0)
  let activeRt60 = s.rt60
  // Spatial Tail ON 時に既存の後期残響を止めるゲート（通常は 1）。止めている間は送りを切り離して畳み込みを休ませる
  const lateGate = stereoGain(ctx, 1)
  late.connect(lateGate).connect(out)
  let lateConnected = true
  let lateTimer: ReturnType<typeof setTimeout> | null = null
  const setLateInput = (on: boolean) => {
    if (on && !lateConnected) sendLp.connect(lateSend)
    if (!on && lateConnected) sendLp.disconnect(lateSend)
    lateConnected = on
  }

  return {
    input,
    output: out,
    latencySeconds: 0,
    setDirectEnabled(on, smooth, start = 0) {
      fadeGate(ctx, directGate.gain, on ? 1 : 0, smooth, start)
    },
    setLateEnabled(on, smooth, start = 0) {
      if (lateTimer) clearTimeout(lateTimer)
      lateTimer = null
      if (on) setLateInput(true)
      fadeGate(ctx, lateGate.gain, on ? 1 : 0, smooth, start)
      if (!on) {
        if (smooth) lateTimer = setTimeout(() => setLateInput(false), (start + MODE_FADE_SECONDS + 0.1) * 1000)
        else setLateInput(false)
      }
    },
    resetLate(at, fadeSeconds) {
      lateBus.reset(at + preDelay.delayTime.value, fadeSeconds)
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
        lateBus.setBuffer(hallIrBuffer(ctx, s.rt60), smooth ? IR_FADE_SECONDS : 0)
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
  /** 原音を STFT 遅延 + CENTER の基準距離の伝搬遅延だけ遅らせた L/R（CINEMA の反射音の送り） */
  aligned: AudioNode
  /** さらに HRTF の遅延分遅らせた L/R（HRTF を通らない HALL の初期反射・残響の送り） */
  alignedHall: AudioNode
  latencySeconds: number
  /** CINEMA の反射音への送りの遅延（CENTER の基準距離の伝搬遅延、秒） */
  feedDelaySeconds(): number
  /** 基準距離が変わったときに送りの遅延を合わせる */
  setFeedDelay(seconds: number, smooth: boolean): void
  post(message: MotionMessage): void
  onReport(listener: ((r: MotionReport) => void) | null): void
}

/**
 * Motion チェーン（直接音のみ）:
 *   input ─→ [csx-motion] ─ 出力0（12ch）→ 12 方向の固定 HRTF → 音色補正 EQ → ring
 *                        └ 出力1（遅延をそろえた原音 L/R）→ aligned / alignedHall
 * 反射音・残響は既存の CINEMA / HALL チェーンの部品を、入力を aligned に切り替えて再利用する（二重に持たない）。
 * CINEMA の反射音への送りは CENTER の基準距離の伝搬遅延だけ遅らせる（直接音は距離に応じて遅れるため、遅らせないと
 * 2〜19 ms の反射音が直接音より先に届く。Phase 05 で修正）。HALL の初期反射（9 ms × 部屋の倍率〜）・後期残響の送り
 * （alignedHall）は従来どおり: 既定の設定では直接音より後に届き、変えると Phase 04 で調整した反射音の追従の性質が変わるため
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
  const panners = SPEAKER_AZIMUTHS.map((az, i) => {
    const panner = createHrtfPanner(ctx, az, 0)
    split.connect(panner, i)
    return panner
  })
  const ringSum = sumTree(ctx, panners)
  const ring = CINEMA_TIMBRE_EQ.reduce<AudioNode>(
    (prev, b) => prev.connect(new BiquadFilterNode(ctx, { type: b.type, frequency: b.frequency, Q: b.q ?? 1, gain: b.gainDb })),
    ringSum,
  )

  let feedDelay = distanceDelaySeconds(motionLayout(p).baseDistance)
  const aux = stereoGain(ctx)
  worklet.connect(aux, 1)
  const feed = createSwitchedDelay(ctx, aux, feedDelay, 0.05)
  const aligned = feed.output
  const alignedHall = new DelayNode(ctx, { maxDelayTime: 0.1, delayTime: hrtfLatencySeconds, channelCount: 2, channelCountMode: 'explicit' })
  aux.connect(alignedHall)

  let reportListener: ((r: MotionReport) => void) | null = null
  // 通知を使うときだけ受信する（onmessage を設定した MessagePort は閉じるまで GC されず、解析用の OfflineAudioContext ごと残るため）
  if (reportIntervalMs > 0) worklet.port.onmessage = (e: MessageEvent<MotionReport>) => reportListener?.(e.data)

  return {
    input,
    ring,
    aligned,
    alignedHall,
    latencySeconds: MOTION_FFT_SIZE / ctx.sampleRate + hrtfLatencySeconds,
    feedDelaySeconds: () => feedDelay,
    setFeedDelay(seconds, smooth) {
      if (seconds === feedDelay) return
      feedDelay = seconds
      feed.setDelay(seconds, smooth)
    },
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
  /** Spatial Tail を構築したか（CINEMA / HALL を含む場合）と、Dynamic Tail が使えるか */
  tailEngine: 'worklet' | 'fallback' | null
  /** グラフ入力に時刻 at までに入った音の後期残響（HALL・Spatial Tail）を消す。PAUSE・CUT・NORMAL LOOP の境界で使う */
  resetReverb(at: number, fadeSeconds: number): void
  /** Dynamic Tail・蓄積防止の状態の通知 */
  onTailReport(listener: ((r: TailReport) => void) | null): void
  /** ORIGINAL 経路の時刻合わせの遅延（秒）。時刻合わせなしなら null */
  bypassAlignSeconds(): number | null
  /** 処理経路で原音（中央の音）が出てくるまでの遅延（秒、現在の設定の目標値）。ORIGINAL の時刻合わせに使う */
  latencySeconds(): number
  /**
   * 処理経路で最も早く音が出てくるまでの遅延（秒）: モードの遅延（Motion の STFT・HRTF）+ 出力段リミッターの先読み。
   * Motion の CENTER の伝搬遅延は含めない（距離による意図した遅れ）。書き出しで先頭から切り捨てる長さ
   */
  processingLatencySeconds(): number
  /** テスト用: Dynamic Tail のゲイン（モノラル）と、畳み込みの組の数 */
  debug: { tailGain: AudioNode | null; reverbSlots(): number }
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
  /**
   * ORIGINAL/PROCESSED 比較の時刻合わせ: bypassDry 経路を処理経路と同じ遅延（整数サンプル）にする。
   * 事前に loadAlignWorklet が必要。省略時は遅らせない（bypassDry = 入力と同時刻でビット一致）
   */
  alignBypass?: boolean
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
 *   input ─┬─ [時刻合わせ] ─ bypassDry ─────────────────────────────────────────────────────┬─ output
 *          └─ ステレオ化 ─┬─ [WIDE | CINEMA | HALL]（選択中のみ）──────────────→ wet ┐       │
 *                        ├─ [MOTION] ─ 直接音（12 方向 HRTF）──────────────→ wet │       │
 *                        │           └ 遅延をそろえた原音 → CINEMA/HALL の入力   │       │
 *                        └─ 遅延補正 → dry ────────────────────────────────────────┴→ トリム → リミッター → bypassWet ┘
 *
 * Motion ON（CINEMA / HALL）: モードのチェーンの直接音を止め、入力を Motion の遅延をそろえた原音に切り替えて
 * 反射音・残響だけを使う。直接音は Motion の 12 方向 HRTF が担当する。
 * bypassDry 経路はゲイン 1 のみで原音とビット一致する。
 * 時刻合わせ（alignBypass）: bypassDry を処理経路の遅延だけ整数サンプルで遅らせる（遅延した原音とビット一致）。
 * 遅延の変更は bypassDry が無音（PROCESSED を再生中）のときだけ行い、ORIGINAL 試聴中は変えない。
 */
export function createSpatialGraph(ctx: BaseAudioContext, opts: SpatialGraphOptions): SpatialGraph {
  const input = new GainNode(ctx)
  const output = new GainNode(ctx)
  const bypassDry = new GainNode(ctx, { gain: opts.bypass ? 1 : 0 })
  const bypassWet = new GainNode(ctx, { gain: opts.bypass ? 0 : 1 })
  bypassDry.connect(output)

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

  // Spatial Tail（CINEMA / HALL で 1 つを共有）。入力は Motion OFF なら原音（CINEMA は HRTF の遅延分だけ遅らせる）、
  // Motion ON なら Motion の遅延をそろえた原音。HALL では既存の後期残響と入れ替える
  const tail: TailChain | null = modes.some((m) => tailSupported(m))
    ? createTail(ctx, opts.params, opts.useWorklet, opts.reportIntervalMs ?? 0)
    : null
  const tailOn = (p: SpatialParams) => !!tail && isTailActive(p) && modes.includes(p.mode as ActiveSpatialMode)
  const tailRootDelayFor = (p: SpatialParams) => (p.mode === 'cinema' ? opts.hrtfLatencySeconds : 0)
  let tailFeed: {
    rootDelay: DelayNode
    rootGate: GainNode
    alignGate: GainNode | null
    rootOn: boolean
    alignOn: boolean
    timer: ReturnType<typeof setTimeout> | null
  } | null = null
  let tailGate: GainNode | null = null
  const setTailInputs = (wantRoot: boolean, wantAlign: boolean) => {
    if (!tailFeed) return
    if (wantRoot && !tailFeed.rootOn) root.connect(tailFeed.rootDelay)
    if (!wantRoot && tailFeed.rootOn) root.disconnect(tailFeed.rootDelay)
    tailFeed.rootOn = wantRoot
    if (motion && tailFeed.alignGate) {
      if (wantAlign && !tailFeed.alignOn) motion.alignedHall.connect(tailFeed.alignGate)
      if (!wantAlign && tailFeed.alignOn) motion.alignedHall.disconnect(tailFeed.alignGate)
      tailFeed.alignOn = wantAlign
    }
  }
  if (tail) {
    const on = tailOn(opts.params)
    const rootDelay = new DelayNode(ctx, { maxDelayTime: 0.1, delayTime: tailRootDelayFor(opts.params), channelCount: 2, channelCountMode: 'explicit' })
    const rootGate = stereoGain(ctx, on && !initialMotion ? 1 : 0)
    rootDelay.connect(rootGate).connect(tail.input)
    let alignGate: GainNode | null = null
    if (motion) {
      alignGate = stereoGain(ctx, on && initialMotion ? 1 : 0)
      alignGate.connect(tail.input)
    }
    tailFeed = { rootDelay, rootGate, alignGate, rootOn: false, alignOn: false, timer: null }
    setTailInputs(on && !initialMotion, on && initialMotion)
    tailGate = stereoGain(ctx, on ? 1 : 0)
    tail.output.connect(tailGate).connect(wetSum)
    if (on) slots.hall?.chain.setLateEnabled?.(false, false)
  }

  const latencyOf = (p: SpatialParams) =>
    p.mode === 'off' ? 0 : motionOn(p) ? motion!.latencySeconds : (slots[p.mode]?.chain.latencySeconds ?? 0)
  dryAlign.delayTime.value = latencyOf(opts.params)
  let current = { mode: opts.params.mode, motion: initialMotion, tail: tailOn(opts.params) }
  let currentParams = opts.params

  // ORIGINAL の時刻合わせの目標 = 処理経路で原音（中央の音）が出てくるまでの遅延:
  // モードの遅延（Motion の STFT・HRTF）+ 出力段リミッターの先読み + Motion の CENTER の伝搬遅延（基準距離の分、固定）
  const outputLatency = opts.useWorklet ? dynamicsSettingsFor('normal', LIMITER_ONLY_BASS_THRESHOLD_DB, 0).lookaheadMs / 1000 : 0
  const compareLatencyOf = (p: SpatialParams) =>
    p.mode === 'off' ? 0 : latencyOf(p) + outputLatency + (motionOn(p) ? distanceDelaySeconds(motionLayout(p).baseDistance) : 0)
  const bypassAlign = opts.alignBypass ? createAlignDelay(ctx, compareLatencyOf(opts.params)) : null
  if (bypassAlign) input.connect(bypassAlign.node).connect(bypassDry)
  else input.connect(bypassDry)
  let bypassed = opts.bypass
  /** bypassDry が 0 になり終わる ctx 時刻（PROCESSED へ切り替えたときのフェードの終点） */
  let dryFadeEnd = 0
  /** PROCESSED 再生中に、BYPASS 経路の遅延を処理経路に合わせる（bypassDry が無音になってから） */
  const syncBypassAlign = () => {
    if (!bypassAlign || bypassed) return
    bypassAlign.setDelay(compareLatencyOf(currentParams), Math.max(ctx.currentTime, dryFadeEnd))
  }

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
    if ((opts.reportIntervalMs ?? 0) > 0) worklet.port.onmessage = (e: MessageEvent<DynamicsMeter>) => meterListener?.(e.data)
  } else {
    trim = stereoGain(ctx, dbToGain(Math.min(0, opts.trimDb)))
    mixSum.connect(trim).connect(bypassWet).connect(output)
  }

  return {
    input,
    output,
    engine: worklet ? 'worklet' : 'fallback',
    setParams(p, smooth) {
      currentParams = p
      const nw = Math.min(Math.max(p.wetDry / 100, 0), 1)
      setParam(ctx, mixWet.gain, nw, smooth)
      setParam(ctx, mixDry.gain, 1 - nw, smooth)
      for (const m of modes) slots[m]?.chain.update(p, smooth)
      // Motion の位置・パラメーター（OFF ならワークレットはフェード後に休止する）
      motion?.post({ type: 'params', layout: motionLayout(p), control: motionControl(p) })
      motion?.setFeedDelay(distanceDelaySeconds(motionLayout(p).baseDistance), smooth)
      tail?.update(p, smooth)

      const next = { mode: p.mode, motion: motionOn(p), tail: tailOn(p) }
      if (next.mode === current.mode && next.motion === current.motion && next.tail === current.tail) return
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
      if (tail && tailFeed && tailGate) {
        const feed = tailFeed
        const wantRoot = next.tail && !next.motion
        const wantAlign = next.tail && next.motion
        if (feed.timer) clearTimeout(feed.timer)
        setTailInputs(wantRoot || feed.rootOn, wantAlign || feed.alignOn)
        feed.timer = setTimeout(
          () => {
            feed.timer = null
            setTailInputs(wantRoot, wantAlign)
          },
          (start + MODE_FADE_SECONDS + DISCONNECT_MARGIN_SECONDS) * 1000 * (smooth ? 1 : 0),
        )
        fadeGate(ctx, feed.rootGate.gain, wantRoot ? 1 : 0, smooth, start)
        if (feed.alignGate) fadeGate(ctx, feed.alignGate.gain, wantAlign ? 1 : 0, smooth, start)
        setParam(ctx, feed.rootDelay.delayTime, tailRootDelayFor(p), smooth, 0.05)
        fadeGate(ctx, tailGate.gain, next.tail ? 1 : 0, smooth, start)
        // HALL の既存の後期残響と Tail を同じフェードで入れ替える（NATURAL の既定値では同じ信号なので継ぎ目がない）
        slots.hall?.chain.setLateEnabled?.(!next.tail, smooth, start)
      }
      if (next.mode !== 'off') {
        const t0 = ctx.currentTime + start
        if (smooth) {
          holdAt(dryAlign.delayTime, ctx.currentTime)
          dryAlign.delayTime.setValueAtTime(dryAlign.delayTime.value, t0)
          dryAlign.delayTime.linearRampToValueAtTime(latencyOf(p), t0 + MODE_FADE_SECONDS)
        } else setParam(ctx, dryAlign.delayTime, latencyOf(p), false)
      }
      current = next
      syncBypassAlign()
    },
    setTrimDb(db, smooth = true) {
      if (worklet) worklet.port.postMessage({ trimDb: db })
      else if (trim) setParam(ctx, trim.gain, dbToGain(Math.min(0, db)), smooth, 0.08)
    },
    setWideSideCap(capDb, smooth = true) {
      slots.wide?.chain.setSideCap?.(capDb, smooth)
    },
    setBypass(b, smooth) {
      const now = ctx.currentTime
      if (bypassAlign) {
        // ORIGINAL へ: bypassDry が無音なら、鳴り始める前に処理経路と同じ遅延にする（フェードは 0 から始まる）。
        // まだフェードアウト中（PROCESSED へ切り替えた直後）なら、聞こえている遅延のまま戻す
        if (b && now >= dryFadeEnd) bypassAlign.setDelay(compareLatencyOf(currentParams), now)
        else if (b) bypassAlign.cancelPending()
      }
      bypassed = b
      if (!b) {
        dryFadeEnd = now + (smooth ? BYPASS_FADE_SECONDS : 0)
        syncBypassAlign()
      }
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
    tailEngine: tail ? tail.engine : null,
    resetReverb(at, fadeSeconds) {
      // at はグラフ入力の時刻。各チェーンの入力までの遅延（Motion の STFT・HRTF の遅延合わせ）を足して、
      // 「at 以降に入った音の残響」だけが新しい畳み込みに入るようにする
      // HALL の後期残響・Tail の送りは alignedHall（CENTER の伝搬遅延なし）
      const motionFeed = motion && motionOn(currentParams) ? motion.latencySeconds : null
      slots.hall?.chain.resetLate?.(at + (motionFeed ?? 0), fadeSeconds)
      tail?.reset(at + (motionFeed ?? tailRootDelayFor(currentParams)), fadeSeconds)
    },
    onTailReport(listener) {
      tail?.onReport(listener)
    },
    bypassAlignSeconds: () => (bypassAlign ? bypassAlign.frames / ctx.sampleRate : null),
    latencySeconds: () => compareLatencyOf(currentParams),
    processingLatencySeconds: () => (currentParams.mode === 'off' ? 0 : latencyOf(currentParams) + outputLatency),
    debug: {
      tailGain: tail?.gainProbe ?? null,
      reverbSlots: () => tail?.slotCount ?? 0,
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

