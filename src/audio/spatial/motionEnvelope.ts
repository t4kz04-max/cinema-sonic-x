// PULSE 用のエネルギー包絡（純粋関数）。
// 曲全体から事前に計算するため、どの位置から再生・シークしても同じ値になる（決定的）。

import type { Envelope } from './motion'

export const ENVELOPE_RATE = 100 // 10 ms ごと

/**
 * モノラル和の RMS（dB）→ アタック/リリースで平滑化 → 10〜95 パーセンタイルで 0〜1 に正規化。
 * MOTION SPEED が速いほどリリースを短くして変化に素早く追従させる。
 */
export function computeEnvelope(channels: Float32Array[], sampleRate: number, speed: number): Envelope {
  const hop = Math.round(sampleRate / ENVELOPE_RATE)
  const n = channels[0]?.length ?? 0
  const frames = Math.max(1, Math.ceil(n / hop))
  const db = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    const end = Math.min(n, (f + 1) * hop)
    for (let i = f * hop; i < end; i++) {
      let v = 0
      for (const ch of channels) v += ch[i]
      v /= channels.length
      sum += v * v
    }
    db[f] = 10 * Math.log10(sum / Math.max(1, end - f * hop) + 1e-12)
  }
  const s = Math.min(Math.max(speed, 0), 1)
  const attack = Math.exp(-1 / (0.08 * ENVELOPE_RATE))
  const release = Math.exp(-1 / (0.8 * Math.pow(0.15 / 0.8, s) * ENVELOPE_RATE))
  const smooth = new Float32Array(frames)
  let y = db[0]
  for (let f = 0; f < frames; f++) {
    const c = db[f] > y ? attack : release
    y = db[f] + (y - db[f]) * c
    smooth[f] = y
  }
  const sorted = Float32Array.from(smooth).sort()
  const lo = sorted[Math.floor(0.1 * (frames - 1))]
  const hi = sorted[Math.floor(0.95 * (frames - 1))]
  const range = Math.max(hi - lo, 3)
  return { rate: ENVELOPE_RATE, data: Float32Array.from(smooth, (v) => Math.min(Math.max((v - lo) / range, 0), 1)) }
}
