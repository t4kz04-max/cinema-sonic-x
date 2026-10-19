// 空間グラフ共通の AudioParam・ノード補助（クリックを出さない平滑化と、チャンネル数を固定した GainNode）

export const PARAM_TC = 0.03
export const MODE_FADE_SECONDS = 0.08
/** lowpass/highpass の Q は dB 指定。Butterworth 相当 */
export const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2)

export const dbToGain = (db: number) => Math.pow(10, db / 20)

export function holdAt(param: AudioParam, time: number): void {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(time)
  } else {
    const v = param.value
    param.cancelScheduledValues(time)
    param.setValueAtTime(v, time)
  }
}

/** linearRampAt で予約した直近のランプ（時刻 at での値を求めるため） */
interface Ramp {
  t0: number
  v0: number
  t1: number
  v1: number
}
const ramps = new WeakMap<AudioParam, Ramp>()
const rampValue = (r: Ramp, t: number) => (t <= r.t0 ? r.v0 : t >= r.t1 ? r.v1 : r.v0 + ((r.v1 - r.v0) * (t - r.t0)) / (r.t1 - r.t0))

/**
 * 時刻 at（現在または未来）から end まで、at の時点の値 → target の線形ランプを予約する。
 * linearRampToValueAtTime は「直前のイベント」から始まるため、前のランプが過去に終わっているとき
 * cancelAndHoldAtTime だけでは開始点が入らず、ランプが過去から始まって値が飛ぶ（Chrome で実測）。
 * そのため開始時刻に値を明示する。at の時点の値は、このヘルパーで予約したランプから計算する
 */
export function linearRampAt(param: AudioParam, at: number, target: number, end: number): void {
  const r = ramps.get(param)
  const v = r ? rampValue(r, at) : param.value
  holdAt(param, at)
  param.setValueAtTime(v, at)
  param.linearRampToValueAtTime(target, end)
  ramps.set(param, { t0: at, v0: v, t1: end, v1: target })
}

/** linearRampAt の記録を消す（.value を直接設定したとき） */
export function clearRamp(param: AudioParam): void {
  ramps.delete(param)
}

/** at に値を即座に設定する（linearRampAt の記録も更新） */
export function setValueAt(param: AudioParam, at: number, value: number): void {
  holdAt(param, at)
  param.setValueAtTime(value, at)
  ramps.set(param, { t0: at, v0: value, t1: at, v1: value })
}

export function setParam(ctx: BaseAudioContext, param: AudioParam, value: number, smooth: boolean, tc = PARAM_TC): void {
  ramps.delete(param)
  if (!smooth) {
    param.cancelScheduledValues(0)
    param.value = value
    return
  }
  const t = ctx.currentTime
  holdAt(param, t)
  param.setTargetAtTime(value, t, tc)
}

export function rampLinear(ctx: BaseAudioContext, param: AudioParam, value: number, seconds: number): void {
  const t = ctx.currentTime
  linearRampAt(param, t, value, t + seconds)
}

/** start 秒後から MODE_FADE_SECONDS の線形フェード（smooth=false なら即時） */
export function fadeGate(ctx: BaseAudioContext, param: AudioParam, target: number, smooth: boolean, start = 0): void {
  if (!smooth) {
    setParam(ctx, param, target, false)
    return
  }
  const t0 = ctx.currentTime + start
  linearRampAt(param, t0, target, t0 + MODE_FADE_SECONDS)
}

export const stereoGain = (ctx: BaseAudioContext, gain = 1) =>
  new GainNode(ctx, { gain, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
export const monoGain = (ctx: BaseAudioContext, gain = 1) =>
  new GainNode(ctx, { gain, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
