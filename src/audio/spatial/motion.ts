// Dynamic Spatial Motion Engine の位置計算（純粋関数）。
// 位置は「メディア時刻 t（秒）とパラメーター」だけで決まる。乱数・壁時計は使わないため、
// 再生・一時停止・シーク・オフラインレンダリングで同じ動きが再現される。
// AudioWorklet（motion.worklet.ts）・可視化・テストが同じ関数を使う。

export type MotionPreset = 'cinematic' | 'orbit' | 'sweep' | 'pulse'

/** 概念レイヤー（STFT 分解の出力順と一致） */
export const SOURCE_NAMES = ['CENTER', 'LEFT', 'RIGHT', 'AMB L', 'AMB R', 'BED L', 'BED R'] as const
export const SOURCE_COUNT = SOURCE_NAMES.length
export const SRC = { center: 0, left: 1, right: 2, ambL: 3, ambR: 4, bedL: 5, bedR: 6 } as const

/** 仮想スピーカーリング（水平面 30° 間隔、方位角は右が正。HRTF は固定で動かさない） */
export const SPEAKER_COUNT = 12
export const SPEAKER_SPACING_DEG = 360 / SPEAKER_COUNT
export const SPEAKER_AZIMUTHS = Array.from({ length: SPEAKER_COUNT }, (_, i) => {
  const a = i * SPEAKER_SPACING_DEG
  return a > 180 ? a - 360 : a
})

/** 距離の基準（この距離で直接音ゲイン 1） */
export const REFERENCE_DISTANCE_M = 1.5
export const MIN_DISTANCE_M = 1.0
export const MAX_DISTANCE_M = 10
const SPEED_OF_SOUND = 343

/** モードから決まる静止時の配置 */
export interface MotionLayout {
  /** LEFT/RIGHT（と BED）の基準方位（±deg） */
  lrAzimuth: number
  /** AMBIENCE の基準方位（±deg） */
  ambienceAzimuth: number
  /** 基準距離（m） */
  baseDistance: number
}

export interface MotionControl {
  enabled: boolean
  preset: MotionPreset
  /** 0〜1 */
  speed: number
  /** 0〜1（移動範囲） */
  depth: number
  /** 0〜1（中央成分の抽出強度） */
  centerLock: number
}

export interface SourcePosition {
  /** 方位角（deg、-180〜180、右が正） */
  azimuth: number
  distance: number
}

export interface Envelope {
  /** フレームレート（Hz） */
  rate: number
  /** 0〜1 に正規化した平滑化済みエネルギー */
  data: Float32Array
}

const TAU = Math.PI * 2
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** MOTION SPEED → 基本周期（秒）。0 で 40 秒、1 で 5 秒 */
export function motionPeriodSeconds(speed: number): number {
  return 40 * Math.pow(5 / 40, clamp(speed, 0, 1))
}

export function wrapAzimuth(az: number): number {
  const a = ((((az + 180) % 360) + 360) % 360) - 180
  return a === -180 ? 180 : a
}

/** 有機的だが決定的なゆらぎ（周期の比が無理数に近い 2 つの正弦波）。範囲 -1〜1 */
function drift(t: number, period: number, p1: number, p2: number): number {
  return 0.6 * Math.sin((TAU * t) / period + p1) + 0.4 * Math.sin((TAU * t) / (period * 1.618) + p2)
}

export function envelopeAt(env: Envelope | null, t: number): number {
  if (!env || env.data.length === 0) return 0.5
  const x = clamp(t * env.rate, 0, env.data.length - 1)
  const i = Math.floor(x)
  const f = x - i
  const a = env.data[i]
  const b = env.data[Math.min(i + 1, env.data.length - 1)]
  return a + (b - a) * f
}

/**
 * 時刻 t の各レイヤーの位置を out に書き込む。
 * CENTER と BED（低域）は常に固定（センター定位と低域の安定のため）。
 */
export function sourcePositions(t: number, layout: MotionLayout, ctl: MotionControl, env: Envelope | null, out: SourcePosition[]): void {
  const lr = layout.lrAzimuth
  const amb = layout.ambienceAzimuth
  const d0 = layout.baseDistance
  const set = (i: number, az: number, d: number) => {
    out[i].azimuth = wrapAzimuth(az)
    out[i].distance = clamp(d, MIN_DISTANCE_M, MAX_DISTANCE_M)
  }
  set(SRC.center, 0, d0)
  set(SRC.bedL, -lr, d0)
  set(SRC.bedR, lr, d0)

  if (!ctl.enabled) {
    set(SRC.left, -lr, d0)
    set(SRC.right, lr, d0)
    set(SRC.ambL, -amb, d0 * 1.3)
    set(SRC.ambR, amb, d0 * 1.3)
    return
  }
  const T = motionPeriodSeconds(ctl.speed)
  const m = clamp(ctl.depth, 0, 1)
  switch (ctl.preset) {
    case 'cinematic': {
      // 周辺だけがゆっくり漂う。LEFT/RIGHT は位相の異なる独立したゆらぎ
      set(SRC.left, -lr - 8 * m - 22 * m * drift(t, T, 0.31, 1.9), d0 * (1 + 0.35 * m * drift(t, T * 1.3, 1.7, 0.6)))
      set(SRC.right, lr + 8 * m + 22 * m * drift(t, T, 2.2, 0.8), d0 * (1 + 0.35 * m * drift(t, T * 1.3, 0.4, 2.9)))
      set(SRC.ambL, -amb + 35 * m * drift(t, T * 1.2, 1.1, 2.4), d0 * 1.3 * (1 + 0.3 * m * drift(t, T, 2.6, 0.2)))
      set(SRC.ambR, amb + 35 * m * drift(t, T * 1.2, 0.2, 1.3), d0 * 1.3 * (1 + 0.3 * m * drift(t, T, 1.4, 3.0)))
      break
    }
    case 'orbit': {
      // AMBIENCE が聴取者の周囲を一周（左右は 180° 反対側）。LEFT/RIGHT はそれぞれの側で前後に回り込む
      const orbit = (360 * t) / T
      const dOrbit = d0 * 1.3 * (1 + 0.25 * m * Math.sin((2 * TAU * t) / T))
      set(SRC.ambL, -90 + orbit, dOrbit)
      set(SRC.ambR, 90 + orbit, dOrbit)
      const swing = 40 + 50 * m
      set(SRC.left, -90 + swing * Math.sin((TAU * t) / (1.5 * T) + 0.5), d0 * (1 + 0.3 * m * Math.sin((TAU * t) / (1.1 * T))))
      set(SRC.right, 90 - swing * Math.sin((TAU * t) / (1.5 * T) + 2.0), d0 * (1 + 0.3 * m * Math.cos((TAU * t) / (1.1 * T))))
      break
    }
    case 'sweep': {
      // LEFT と RIGHT が左右を横断する（位相を 90° ずらして同時に中央で重ならない）
      const A = 40 + 50 * m
      set(SRC.left, -A * Math.cos((TAU * t) / T), d0)
      set(SRC.right, A * Math.cos((TAU * t) / T + Math.PI / 2), d0)
      set(SRC.ambL, -amb, d0 * 1.3)
      set(SRC.ambR, amb, d0 * 1.3)
      break
    }
    case 'pulse': {
      // 音楽が大きいほど広く・近く、小さいほど狭く・遠く（エネルギーは事前に平滑化済み）
      const e = envelopeAt(env, t)
      const width = lr * (1 - 0.4 * m) + 55 * m * e
      set(SRC.left, -width, d0 * (1 + 0.8 * m * (1 - e)))
      set(SRC.right, width, d0 * (1 + 0.8 * m * (1 - e)))
      const ambW = amb - 30 * m + 50 * m * e
      set(SRC.ambL, -ambW, d0 * 1.3 * (1 + 0.6 * m * (1 - e)))
      set(SRC.ambR, ambW, d0 * 1.3 * (1 + 0.6 * m * (1 - e)))
      break
    }
  }
}

export function createPositions(): SourcePosition[] {
  return Array.from({ length: SOURCE_COUNT }, () => ({ azimuth: 0, distance: REFERENCE_DISTANCE_M }))
}

/**
 * 等パワーのペアワイズ振幅パン（隣り合う 2 つの仮想スピーカーに cos/sin で配分）。
 * 返り値: [下側スピーカー番号, 上側スピーカー番号, 下側ゲイン, 上側ゲイン]
 */
export function panPair(azimuth: number): [number, number, number, number] {
  const a = (((azimuth % 360) + 360) % 360) / SPEAKER_SPACING_DEG
  const i = Math.floor(a) % SPEAKER_COUNT
  const f = a - Math.floor(a)
  return [i, (i + 1) % SPEAKER_COUNT, Math.cos((f * Math.PI) / 2), Math.sin((f * Math.PI) / 2)]
}

/** 距離 → 直接音ゲイン（逆距離則、基準 1.5 m で 1） */
export function distanceGain(d: number): number {
  return REFERENCE_DISTANCE_M / clamp(d, MIN_DISTANCE_M, MAX_DISTANCE_M)
}

/** 距離 → 空気吸収を模したローパス周波数（1.5 m で 20 kHz、7.5 m 以上で 6 kHz） */
export function distanceLowpassHz(d: number): number {
  const x = clamp((d - REFERENCE_DISTANCE_M) / 6, 0, 1)
  return 20000 * Math.pow(6000 / 20000, x)
}

/** 距離 → 伝搬遅延（秒）。最小距離を 0 とする（遠いほど直接音が遅れ、反射音との時間差が縮む） */
export function distanceDelaySeconds(d: number): number {
  return (clamp(d, MIN_DISTANCE_M, MAX_DISTANCE_M) - MIN_DISTANCE_M) / SPEED_OF_SOUND
}
