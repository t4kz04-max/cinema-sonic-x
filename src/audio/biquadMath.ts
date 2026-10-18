// Web Audio の BiquadFilterNode と同じ式（Audio EQ Cookbook / Web Audio 仕様）で振幅特性を計算する純粋関数。
// EQ 合成特性の上限チェックに使う（AudioContext 不要）。

import { MODE_SPECS, paramsToGains, type BassParams } from './bassSpec'

type Coeffs = [b0: number, b1: number, b2: number, a0: number, a1: number, a2: number]

const BUTTERWORTH_Q = Math.SQRT1_2

function peaking(f0: number, q: number, gainDb: number, fs: number): Coeffs {
  const A = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * f0) / fs
  const alpha = Math.sin(w0) / (2 * q)
  const c = Math.cos(w0)
  return [1 + alpha * A, -2 * c, 1 - alpha * A, 1 + alpha / A, -2 * c, 1 - alpha / A]
}

/** Web Audio の lowshelf は S=1 固定（Q は使われない） */
function lowShelf(f0: number, gainDb: number, fs: number): Coeffs {
  const A = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * f0) / fs
  const c = Math.cos(w0)
  const alpha = (Math.sin(w0) / 2) * Math.SQRT2
  const k = 2 * Math.sqrt(A) * alpha
  return [
    A * (A + 1 - (A - 1) * c + k),
    2 * A * (A - 1 - (A + 1) * c),
    A * (A + 1 - (A - 1) * c - k),
    A + 1 + (A - 1) * c + k,
    -2 * (A - 1 + (A + 1) * c),
    A + 1 + (A - 1) * c - k,
  ]
}

function highpass(f0: number, q: number, fs: number): Coeffs {
  const w0 = (2 * Math.PI * f0) / fs
  const c = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  return [(1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha]
}

function magnitudeDb([b0, b1, b2, a0, a1, a2]: Coeffs, f: number, fs: number): number {
  const w = (2 * Math.PI * f) / fs
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2)
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2)
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di))
}

/** 指定周波数での EQ 合成ゲイン（dB、サブソニック HPF 含む） */
export function eqGainDb(p: Pick<BassParams, 'bass' | 'sub' | 'mode'>, scale: number, f: number, fs = 48000): number {
  const spec = MODE_SPECS[p.mode]
  const g = paramsToGains(p, scale)
  const hp = highpass(spec.subsonicHz, BUTTERWORTH_Q, fs)
  return (
    2 * magnitudeDb(hp, f, fs) +
    magnitudeDb(lowShelf(spec.shelf.frequency, g.shelfDb, fs), f, fs) +
    magnitudeDb(peaking(spec.punch.frequency, spec.punch.q, g.punchDb, fs), f, fs) +
    magnitudeDb(peaking(spec.sub.frequency, spec.sub.q, g.subDb, fs), f, fs)
  )
}

/** 20〜200 Hz での EQ 合成特性の最大値 */
export function maxEqGainDb(p: Pick<BassParams, 'bass' | 'sub' | 'mode'>, scale = 1): number {
  let max = 0
  for (let f = 20; f <= 200; f *= 1.02) max = Math.max(max, eqGainDb(p, scale, f))
  return max
}

/** EQ 合成特性が eqCapDb を超えないための倍率（1 以下） */
export function eqCapScale(p: Pick<BassParams, 'bass' | 'sub' | 'mode'>): number {
  const cap = MODE_SPECS[p.mode].eqCapDb
  if (maxEqGainDb(p, 1) <= cap) return 1
  let lo = 0
  let hi = 1
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (maxEqGainDb(p, mid) <= cap) lo = mid
    else hi = mid
  }
  return lo
}
