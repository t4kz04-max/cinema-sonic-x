// 平均パワースペクトル（Welch 法）と帯域レベルの計算。Web Audio 非依存の純粋関数。

/** in-place 基数2 FFT（re/im は長さ 2^n） */
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

export interface Spectrum {
  sampleRate: number
  fftSize: number
  /** ビンごとの平均パワー（全チャンネル・全フレーム平均、Hann 窓、正弦波振幅 a → a²/2 に正規化） */
  power: Float64Array
}

/** Welch 法の平均スペクトル。fftSize は 2 の累乗、50% オーバーラップ */
export function averageSpectrum(channels: Float32Array[], sampleRate: number, fftSize = 16384): Spectrum {
  const half = fftSize / 2
  const power = new Float64Array(half + 1)
  const win = new Float64Array(fftSize)
  let winSum = 0
  for (let i = 0; i < fftSize; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1))
    winSum += win[i]
  }
  // 振幅 a の正弦波がそのビンで a²/2 になるよう正規化（コヒーレントゲイン補正）
  const norm = 2 / (winSum * winSum)
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)
  let frames = 0
  for (const x of channels) {
    if (x.length < fftSize) {
      // 短い信号は 0 埋めで 1 フレームだけ計算する
      re.fill(0)
      im.fill(0)
      for (let i = 0; i < x.length; i++) re[i] = x[i] * win[i]
      fft(re, im)
      for (let k = 0; k <= half; k++) power[k] += (re[k] * re[k] + im[k] * im[k]) * norm
      frames++
      continue
    }
    for (let start = 0; start + fftSize <= x.length; start += half) {
      for (let i = 0; i < fftSize; i++) {
        re[i] = x[start + i] * win[i]
        im[i] = 0
      }
      fft(re, im)
      for (let k = 0; k <= half; k++) power[k] += (re[k] * re[k] + im[k] * im[k]) * norm
      frames++
    }
  }
  if (frames > 0) for (let k = 0; k <= half; k++) power[k] /= frames
  return { sampleRate, fftSize, power }
}

const powerToDb = (p: number) => (p > 1e-20 ? 10 * Math.log10(p) : -200)

/** [lo, hi) Hz の帯域パワー合計（dB）。無音は -200 */
export function bandLevelDb(s: Spectrum, lo: number, hi: number): number {
  const binHz = s.sampleRate / s.fftSize
  const k0 = Math.max(1, Math.ceil(lo / binHz))
  const k1 = Math.min(s.power.length - 1, Math.floor(hi / binHz))
  let sum = 0
  for (let k = k0; k <= k1; k++) sum += s.power[k]
  return powerToDb(sum)
}

/** 1/3 オクターブ中心周波数（20 Hz〜10 kHz） */
export const THIRD_OCTAVE_CENTERS = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
  4000, 5000, 6300, 8000, 10000,
]

export function thirdOctaveLevelsDb(s: Spectrum, centers = THIRD_OCTAVE_CENTERS): number[] {
  const k = Math.pow(2, 1 / 6)
  return centers.map((fc) => bandLevelDb(s, fc / k, fc * k))
}

/** 表示用: 各周波数の ±1/(2·fraction) オクターブ平均パワー（dB） */
export function smoothedSpectrumDb(s: Spectrum, freqs: ArrayLike<number>, fraction = 12): Float32Array {
  const k = Math.pow(2, 1 / (2 * fraction))
  const binHz = s.sampleRate / s.fftSize
  const out = new Float32Array(freqs.length)
  for (let i = 0; i < freqs.length; i++) {
    const lo = Math.max(1, Math.floor((freqs[i] / k) / binHz))
    const hi = Math.min(s.power.length - 1, Math.max(lo, Math.ceil((freqs[i] * k) / binHz)))
    let sum = 0
    for (let b = lo; b <= hi; b++) sum += s.power[b]
    out[i] = powerToDb(sum / (hi - lo + 1))
  }
  return out
}

/** 解析対象の代表帯域 */
export const SUMMARY_BANDS = [
  { id: 'sub', label: 'SUB 20–60 Hz', lo: 20, hi: 60 },
  { id: 'bass', label: 'BASS 60–120 Hz', lo: 60, hi: 120 },
  { id: 'upperBass', label: '120–200 Hz', lo: 120, hi: 200 },
  { id: 'mid', label: '中域 200 Hz–2 kHz', lo: 200, hi: 2000 },
  { id: 'high', label: '高域 2–10 kHz', lo: 2000, hi: 10000 },
] as const
