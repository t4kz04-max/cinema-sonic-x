// ITU-R BS.1770 に基づく K 特性・ゲーティング付き統合ラウドネスと、出力ゲイン補正の計算。
// Web Audio に依存しない純粋関数（Node でも単体テスト可能）。

type Coeffs = { b0: number; b1: number; b2: number; a1: number; a2: number }

/** 任意サンプルレートの K 特性係数（libebur128 と同じ導出） */
function kWeightingCoeffs(fs: number): [Coeffs, Coeffs] {
  // Stage 1: 頭部の音響効果を模したハイシェルフ
  let f0 = 1681.974450955533
  const G = 3.999843853973347
  let Q = 0.7071752369554196
  let K = Math.tan((Math.PI * f0) / fs)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  let a0 = 1 + K / Q + K * K
  const shelf: Coeffs = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
  // Stage 2: RLB ハイパス
  f0 = 38.13547087602444
  Q = 0.5003270373238773
  K = Math.tan((Math.PI * f0) / fs)
  a0 = 1 + K / Q + K * K
  const highpass: Coeffs = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
  return [shelf, highpass]
}

/**
 * 統合ラウドネス（LUFS）。無音などでゲートを通るブロックがない場合は -Infinity。
 * 全チャンネルの重みは 1（L/R 用。サラウンドの重み付けは行わない）。
 */
export function integratedLoudness(channels: Float32Array[], fs: number): number {
  if (channels.length === 0 || channels[0].length === 0) return -Infinity
  const [s, h] = kWeightingCoeffs(fs)
  const n = channels[0].length
  const stepLen = Math.max(1, Math.round(0.1 * fs))
  const nSteps = Math.floor(n / stepLen)
  // 100 ms ごとの二乗和（全チャンネル合計）。400 ms ブロック = 連続 4 ステップ（75% オーバーラップ）
  const stepEnergy = new Float64Array(Math.max(nSteps, 1))
  let totalEnergy = 0

  for (const x of channels) {
    let sx1 = 0, sx2 = 0, sy1 = 0, sy2 = 0
    let hy1 = 0, hy2 = 0
    for (let i = 0; i < n; i++) {
      const xi = x[i]
      const y = s.b0 * xi + s.b1 * sx1 + s.b2 * sx2 - s.a1 * sy1 - s.a2 * sy2
      const z = h.b0 * y + h.b1 * sy1 + h.b2 * sy2 - h.a1 * hy1 - h.a2 * hy2
      sx2 = sx1; sx1 = xi
      sy2 = sy1; sy1 = y
      hy2 = hy1; hy1 = z
      const e = z * z
      totalEnergy += e
      const step = Math.floor(i / stepLen)
      if (step < nSteps) stepEnergy[step] += e
    }
  }

  const blocks: number[] = []
  if (nSteps < 4) {
    blocks.push(totalEnergy / n)
  } else {
    for (let i = 0; i + 4 <= nSteps; i++) {
      blocks.push((stepEnergy[i] + stepEnergy[i + 1] + stepEnergy[i + 2] + stepEnergy[i + 3]) / (4 * stepLen))
    }
  }

  const lk = (z: number) => (z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity)
  const mean = (a: number[]) => a.reduce((sum, v) => sum + v, 0) / a.length
  const absGated = blocks.filter((z) => lk(z) > -70)
  if (absGated.length === 0) return -Infinity
  const relThreshold = lk(mean(absGated)) - 10
  const relGated = absGated.filter((z) => lk(z) > relThreshold)
  return lk(mean(relGated))
}

export function samplePeak(channels: Float32Array[]): number {
  let peak = 0
  for (const x of channels) {
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i])
      if (a > peak) peak = a
    }
  }
  return peak
}

export function linearToDb(v: number): number {
  return v > 0 ? 20 * Math.log10(v) : -Infinity
}

/** ブロック（既定 20 ms）ごとのピークの上位パーセンタイル（dB）。突発的な 1 サンプルに左右されない低域レベル指標 */
export function blockPeakPercentileDb(channels: Float32Array[], fs: number, percentile = 0.99, blockMs = 20): number {
  if (channels.length === 0) return -Infinity
  const n = channels[0].length
  const block = Math.max(1, Math.round((blockMs / 1000) * fs))
  const peaks: number[] = []
  for (let start = 0; start < n; start += block) {
    let p = 0
    for (const x of channels) {
      for (let i = start; i < Math.min(n, start + block); i++) {
        const a = Math.abs(x[i])
        if (a > p) p = a
      }
    }
    peaks.push(p)
  }
  peaks.sort((x, y) => x - y)
  return linearToDb(peaks[Math.min(peaks.length - 1, Math.floor(percentile * peaks.length))])
}

export type CompensationMode = 'mid-anchor' | 'loudness-match'

export interface TrimInputs {
  compensation: CompensationMode
  /** トリム 0 dB・リミッターなしで処理したときの統合ラウドネス増加量 */
  loudnessDeltaLu: number
  /** トリム 0 dB・リミッター前のサンプルピーク */
  preLimiterPeakDb: number
  ceilingDb: number
  maxLimiterGrDb: number
  trimFloorDb: number
  maxLoudnessIncreaseLu: number
}

export interface TrimResult {
  /** 処理経路に掛ける全帯域トリム（常に 0 以下） */
  trimDb: number
  /** 下限で打ち切ったために満たせなかった量（> 0 なら EQ を安全制限する） */
  unmetDb: number
  reason: 'none' | 'peak' | 'loudness'
}

/** loudness-match（Phase 02 方式）時のトリム下限 */
export const LOUDNESS_MATCH_FLOOR_DB = -15

/**
 * 全帯域トリム量を決める。
 * - mid-anchor    : ラウドネス増加が上限を超えた分と、リミッター GR 予算を超えるピーク分だけ下げる。
 *                   低域の増加はできるだけ残し、中高域は原音レベルに近いまま保つ。
 * - loudness-match: 統合ラウドネスを原音に揃える（Phase 02 方式。A/B の公平比較用）。
 * どちらも正方向（持ち上げ）の補正はしない。
 */
export function computeTrim(i: TrimInputs): TrimResult {
  const trimLoud =
    i.compensation === 'loudness-match'
      ? -Math.max(0, i.loudnessDeltaLu)
      : Math.min(0, i.maxLoudnessIncreaseLu - i.loudnessDeltaLu)
  const trimPeak = Math.min(0, i.ceilingDb + i.maxLimiterGrDb - i.preLimiterPeakDb)
  const raw = Math.min(trimLoud, trimPeak)
  const floor = i.compensation === 'loudness-match' ? LOUDNESS_MATCH_FLOOR_DB : i.trimFloorDb
  return {
    trimDb: Math.max(raw, floor),
    unmetDb: Math.max(0, floor - raw),
    // 0.05 dB 未満は表示上も「補正なし」とみなす
    reason: raw > -0.05 ? 'none' : trimPeak <= trimLoud ? 'peak' : 'loudness',
  }
}
