// Spatial Tail のインパルス応答の合成（純粋関数・決定的）。
// 余韻の「方向・広がり・距離・周波数ごとの消え方」の時間変化を IR そのものに書き込む。
// 畳み込み（線形時不変）なので、曲の途中の音にも停止後の余韻にも同じ性質が現れ、
// OfflineAudioContext（Phase 06 の書き出し）でも同じ結果になる。
//
//   NATURAL : 既存 HALL と同じ IR（左右無相関の指数減衰ノイズ＋時間とともに下がるローパス）
//   DISTANCE: 時間とともに 高域が早く失われ・左右の広がりが狭まる（遠ざかって一点に小さくなる）
//   RIPPLE  : 中央（左右で同じ成分）から始まり、側方のレイヤーへ順に広がって拡散して消える

import { synthesizeHallIR } from './hallImpulse'

export type TailMode = 'off' | 'natural' | 'distance' | 'ripple'
export type ActiveTailMode = Exclude<TailMode, 'off'>

/** Spatial Tail の IR の最大長（秒） */
export const TAIL_MAX_IR_SECONDS = 8
/** 残響のビルドアップ時間（HALL と同じ） */
const BUILD_UP_SECONDS = 0.012
const LN1000 = 6.907755

function prng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000 - 0.5
  }
}

/** 時間とともにカットオフが下がる 1 次ローパスを掛けたノイズ（fc(t) は 64 サンプルごとに更新） */
function dampedNoise(length: number, sampleRate: number, seed: number, cutoff: (t: number) => number): Float32Array {
  const rnd = prng(seed)
  const x = new Float32Array(length)
  let lp = 0
  let a = 0
  for (let i = 0; i < length; i++) {
    if ((i & 63) === 0) a = Math.exp((-2 * Math.PI * cutoff(i / sampleRate)) / sampleRate)
    lp = (1 - a) * rnd() + a * lp
    x[i] = lp
  }
  return x
}

const decayEnv = (t: number, rt60: number) => Math.exp((-LN1000 * t) / rt60) * (1 - Math.exp(-t / BUILD_UP_SECONDS))

/** 各チャンネルのエネルギーを 1 に正規化（HALL の IR と同じ基準。TAIL INTENSITY を同じ意味にする） */
function normalize(chs: Float32Array[]): void {
  for (const x of chs) {
    let e = 0
    for (let i = 0; i < x.length; i++) e += x[i] * x[i]
    const g = e > 0 ? 1 / Math.sqrt(e) : 0
    for (let i = 0; i < x.length; i++) x[i] *= g
  }
}

export const tailIrLength = (rt60: number, sampleRate: number) => Math.ceil(Math.min(rt60 * 1.3, TAIL_MAX_IR_SECONDS) * sampleRate)

/**
 * DISTANCE: 余韻が遠ざかる。
 * Mid/Side で合成し、Side の比率 w(t) を 1 → 0.2 に狭め（遠い音源は小さな角度にまとまる）、
 * 高域のカットオフを NATURAL より速く下げる（空気吸収・遠方の暗さ）。減衰の速さ（RT60）は同じ。
 */
function distanceIR(rt60: number, sampleRate: number): [Float32Array, Float32Array] {
  const length = tailIrLength(rt60, sampleRate)
  const fc = (t: number) => Math.max(700, 9000 * Math.exp(-t / (rt60 * 0.22)))
  const m = dampedNoise(length, sampleRate, 31337, fc)
  const s = dampedNoise(length, sampleRate, 271828, fc)
  const L = new Float32Array(length)
  const R = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    const w = 0.2 + 0.8 * Math.exp(-t / (rt60 * 0.3))
    const env = decayEnv(t, rt60)
    // M と S のエネルギー和を一定に保つ（幅だけを変え、レベルの時間変化は env だけにする）
    const k = env / Math.sqrt(1 + w * w)
    L[i] = (m[i] + w * s[i]) * k
    R[i] = (m[i] - w * s[i]) * k
  }
  normalize([L, R])
  return [L, R]
}

/** RIPPLE の波面が最外側のレイヤーに届くまでの時間（秒） */
export const rippleSpreadSeconds = (rt60: number) => Math.min(Math.max(rt60 * 0.35, 0.25), 1.6)

/** RIPPLE の空間レイヤー: パン位置 p（0 = 中央・左右で同じ成分、1 = 左右に分かれた無相関の成分） */
const RIPPLE_LAYERS = [0, 0.45, 0.8, 1]

/**
 * RIPPLE: 波紋のように広がる。
 * 波面 r(t) = t / 広がり時間 が中央から外側のレイヤーへ進み、各時刻のエネルギーを近いレイヤーに配分する
 * （配分の二乗和は常に 1 = 全体の減衰は NATURAL と同じ指数減衰）。
 * レイヤーは独立したノイズなので、レイヤー間で干渉（櫛形フィルター）しない。
 */
function rippleIR(rt60: number, sampleRate: number): [Float32Array, Float32Array] {
  const length = tailIrLength(rt60, sampleRate)
  const spread = rippleSpreadSeconds(rt60)
  const fc = (t: number) => Math.max(1200, 10000 * Math.exp(-t / (rt60 * 0.5)))
  const L = new Float32Array(length)
  const R = new Float32Array(length)
  const last = RIPPLE_LAYERS.length - 1
  const weights = new Float64Array(RIPPLE_LAYERS.length)
  const noises = RIPPLE_LAYERS.map((_, k) => [dampedNoise(length, sampleRate, 1009 + k * 7919, fc), dampedNoise(length, sampleRate, 2003 + k * 104729, fc)])
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    const r = Math.min(t / spread, 1)
    let sum = 0
    for (let k = 0; k <= last; k++) {
      const x = k / last
      // 波面との距離に応じた cos² の重み（最外側は波面が通過した後も残る = 拡散して消える）
      const d = k === last && r >= x ? 0 : Math.min(Math.abs(r - x) * last, 1)
      weights[k] = Math.cos((d * Math.PI) / 2) ** 2
      sum += weights[k] * weights[k]
    }
    const env = decayEnv(t, rt60) / Math.sqrt(sum || 1)
    let l = 0
    let rr = 0
    for (let k = 0; k <= last; k++) {
      const p = RIPPLE_LAYERS[k]
      const g = weights[k] * env
      if (g === 0) continue
      const [a, b] = noises[k]
      if (p === 0) {
        // 中央: 左右で同じ成分（位相差なし）
        l += g * a[i]
        rr += g * a[i]
      } else {
        // 左寄り・右寄りの独立な 2 成分。チャンネル間の相関は √(1 − p²)
        const ga = Math.sqrt((1 + p) / 2)
        const gb = Math.sqrt((1 - p) / 2)
        l += g * (ga * a[i] + gb * b[i])
        rr += g * (gb * a[i] + ga * b[i])
      }
    }
    L[i] = l
    R[i] = rr
  }
  normalize([L, R])
  return [L, R]
}

export function synthesizeTailIR(mode: ActiveTailMode, rt60: number, sampleRate: number): [Float32Array, Float32Array] {
  switch (mode) {
    case 'natural':
      return synthesizeHallIR(rt60, sampleRate, 1, TAIL_MAX_IR_SECONDS)
    case 'distance':
      return distanceIR(rt60, sampleRate)
    case 'ripple':
      return rippleIR(rt60, sampleRate)
  }
}
