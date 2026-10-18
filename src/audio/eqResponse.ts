import type { BassParams } from './bassSpec'
import { createEqChain } from './processingGraph'

export interface EqResponse {
  freqs: Float32Array<ArrayBuffer>
  /** EQ 全体（SUBSONIC 含む） */
  totalDb: Float32Array
  /** BASS BOOST 分（シェルフ＋パンチのピーク） */
  bassDb: Float32Array
  /** SUB BASS 分（超低域ピーク） */
  subDb: Float32Array
}

const RESPONSE_SAMPLE_RATE = 48000
let responseCtx: OfflineAudioContext | null = null

/** 実際に使用する BiquadFilterNode と同じ設定のノードから周波数特性を取得する（表示用） */
export function computeEqResponse(params: BassParams, scale: number, freqs: Float32Array<ArrayBuffer>): EqResponse | null {
  try {
    responseCtx ??= new OfflineAudioContext(1, 1, RESPONSE_SAMPLE_RATE)
    const eq = createEqChain(responseCtx, params, scale)
    const n = freqs.length
    const mag = new Float32Array(n)
    const phase = new Float32Array(n)
    const toDb = (node: BiquadFilterNode) => {
      node.getFrequencyResponse(freqs, mag, phase)
      return Float32Array.from(mag, (m) => 20 * Math.log10(Math.max(m, 1e-6)))
    }
    const hp = toDb(eq.subsonic[0])
    const subsonic = Float32Array.from(hp, (v) => 2 * v)
    const shelf = toDb(eq.shelf)
    const punch = toDb(eq.punch)
    const sub = toDb(eq.sub)
    const bassDb = Float32Array.from(shelf, (v, i) => v + punch[i])
    return {
      freqs,
      bassDb,
      subDb: sub,
      totalDb: Float32Array.from(bassDb, (v, i) => v + sub[i] + subsonic[i]),
    }
  } catch {
    return null
  }
}

export function logFrequencies(points: number, min = 20, max = 20000): Float32Array<ArrayBuffer> {
  const ratio = Math.log(max / min)
  return Float32Array.from({ length: points }, (_, i) => min * Math.exp((ratio * i) / (points - 1)))
}
