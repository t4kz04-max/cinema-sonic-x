// ステレオ解析（位相相関・ステレオ幅・モノラル和）。Web Audio 非依存の純粋関数。
// Welch 法で L/R の自己・相互スペクトルを求め、帯域ごとの指標を計算する。

import { integratedLoudness, linearToDb, samplePeak } from './loudness'
import { THIRD_OCTAVE_CENTERS } from './spectrum'

/** in-place 基数2 FFT */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

interface CrossSpectrum {
  binHz: number
  /** L/R の自己パワーと相互スペクトル実部（ビンごと、フレーム平均） */
  pll: Float64Array
  prr: Float64Array
  plr: Float64Array
}

function crossSpectrum(L: Float32Array, R: Float32Array, fs: number, fftSize = 8192): CrossSpectrum {
  const half = fftSize / 2
  const pll = new Float64Array(half + 1)
  const prr = new Float64Array(half + 1)
  const plr = new Float64Array(half + 1)
  const win = Float64Array.from({ length: fftSize }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1)))
  const lr = new Float64Array(fftSize)
  const li = new Float64Array(fftSize)
  const rr = new Float64Array(fftSize)
  const ri = new Float64Array(fftSize)
  let frames = 0
  const n = L.length
  for (let start = 0; start === 0 || start + fftSize <= n; start += half) {
    for (let i = 0; i < fftSize; i++) {
      const j = start + i
      lr[i] = j < n ? L[j] * win[i] : 0
      rr[i] = j < n ? R[j] * win[i] : 0
      li[i] = 0
      ri[i] = 0
    }
    fft(lr, li)
    fft(rr, ri)
    for (let k = 0; k <= half; k++) {
      pll[k] += lr[k] * lr[k] + li[k] * li[k]
      prr[k] += rr[k] * rr[k] + ri[k] * ri[k]
      plr[k] += lr[k] * rr[k] + li[k] * ri[k]
    }
    frames++
    if (start + fftSize >= n) break
  }
  for (let k = 0; k <= half; k++) {
    pll[k] /= frames
    prr[k] /= frames
    plr[k] /= frames
  }
  return { binHz: fs / fftSize, pll, prr, plr }
}

function bandSums(cs: CrossSpectrum, lo: number, hi: number) {
  const k0 = Math.max(1, Math.ceil(lo / cs.binHz))
  const k1 = Math.min(cs.pll.length - 1, Math.floor(hi / cs.binHz))
  let ll = 0
  let rr = 0
  let lr = 0
  for (let k = k0; k <= k1; k++) {
    ll += cs.pll[k]
    rr += cs.prr[k]
    lr += cs.plr[k]
  }
  return { ll, rr, lr }
}

export const STEREO_BANDS = [
  { id: 'low', label: '低域 20–200 Hz', lo: 20, hi: 200 },
  { id: 'mid', label: '中域 200 Hz–2 kHz', lo: 200, hi: 2000 },
  { id: 'high', label: '高域 2–16 kHz', lo: 2000, hi: 16000 },
] as const

export type StereoBandId = (typeof STEREO_BANDS)[number]['id']

export interface StereoMetrics {
  loudnessLufs: number
  peakDb: number
  /** 位相相関係数（+1 = 完全同相・モノラル、0 = 無相関、−1 = 逆相）。全帯域と帯域別 */
  correlation: number
  bandCorrelation: Record<StereoBandId, number>
  /** ステレオ幅 = Side/Mid のエネルギー比（dB）。大きいほど広い */
  bandWidthDb: Record<StereoBandId, number>
  /** モノラル和 (L+R)/2 の 1/3 オクターブレベル（dB） */
  monoThirdOctaveDb: number[]
  /** 左右のパワー平均 (L²+R²)/2 の 1/3 オクターブレベル（dB）。ヘッドホンで各耳に届く音色の指標 */
  powerThirdOctaveDb: number[]
  monoLoudnessLufs: number
}

const powDb = (p: number) => (p > 1e-20 ? 10 * Math.log10(p) : -200)

export function stereoMetrics(channels: Float32Array[], fs: number): StereoMetrics {
  const L = channels[0]
  const R = channels[1] ?? channels[0]
  const cs = crossSpectrum(L, R, fs)
  const corr = (s: { ll: number; rr: number; lr: number }) => (s.ll > 1e-20 && s.rr > 1e-20 ? s.lr / Math.sqrt(s.ll * s.rr) : 1)
  // Mid/Side のパワー: M=(L+R)/2, S=(L−R)/2
  const width = (s: { ll: number; rr: number; lr: number }) => {
    const m = (s.ll + s.rr + 2 * s.lr) / 4
    const sd = (s.ll + s.rr - 2 * s.lr) / 4
    return powDb(sd) - powDb(m)
  }
  const all = bandSums(cs, 20, fs / 2)
  const bandCorrelation = {} as Record<StereoBandId, number>
  const bandWidthDb = {} as Record<StereoBandId, number>
  for (const b of STEREO_BANDS) {
    const s = bandSums(cs, b.lo, Math.min(b.hi, fs / 2))
    bandCorrelation[b.id] = corr(s)
    bandWidthDb[b.id] = width(s)
  }
  const k = Math.pow(2, 1 / 6)
  const monoThirdOctaveDb = THIRD_OCTAVE_CENTERS.map((fc) => {
    const s = bandSums(cs, fc / k, fc * k)
    return powDb((s.ll + s.rr + 2 * s.lr) / 4)
  })
  const powerThirdOctaveDb = THIRD_OCTAVE_CENTERS.map((fc) => {
    const s = bandSums(cs, fc / k, fc * k)
    return powDb((s.ll + s.rr) / 2)
  })
  const mono = Float32Array.from(L, (v, i) => (v + R[i]) / 2)
  return {
    loudnessLufs: integratedLoudness(channels.length > 1 ? [L, R] : [L], fs),
    peakDb: linearToDb(samplePeak(channels)),
    correlation: corr(all),
    bandCorrelation,
    bandWidthDb,
    monoThirdOctaveDb,
    powerThirdOctaveDb,
    monoLoudnessLufs: integratedLoudness([mono], fs),
  }
}

/**
 * モノラル和の音色変化（コムフィルター等）の指標:
 * 125 Hz〜8 kHz の 1/3 オクターブで (処理後 − 処理前) から全体のレベル差（中央値）を除いた偏差の最大値。
 */
export function monoColorationDb(before: StereoMetrics, after: StereoMetrics): number {
  return colorationDb(before.monoThirdOctaveDb, after.monoThirdOctaveDb)
}

/** 左右のパワー平均（各耳で聞く音色）の変化。定義は monoColorationDb と同じ */
export function stereoColorationDb(before: StereoMetrics, after: StereoMetrics): number {
  return colorationDb(before.powerThirdOctaveDb, after.powerThirdOctaveDb)
}

function colorationDb(before: number[], after: number[]): number {
  const idx = THIRD_OCTAVE_CENTERS.map((f, i) => [f, i] as const)
    .filter(([f]) => f >= 125 && f <= 8000)
    .map(([, i]) => i)
  const diffs = idx.map((i) => after[i] - before[i])
  const sorted = [...diffs].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  return Math.max(...diffs.map((d) => Math.abs(d - median)))
}
