// WAV（RIFF / WAVE / PCM、リトルエンディアン）のエンコード（純粋関数・React 非依存）。
// 16-bit は TPDF ディザ（±1 LSB の三角分布、シード付きの決定的な乱数）で量子化し、24-bit はディザなし（量子化雑音 −144 dBFS）。
// 大きなファイルで 1 つの巨大な ArrayBuffer を確保しないよう、データ部は一定サイズの塊に分けて Blob にする。

export type WavBitDepth = 16 | 24

export interface WavOptions {
  sampleRate: number
  bitDepth: WavBitDepth
  /** 16-bit の TPDF ディザ（既定 true）。24-bit では使わない */
  dither?: boolean
  /** ディザの乱数のシード（同じシード・同じ入力なら同じバイト列になる） */
  seed?: number
}

export interface WavStats {
  /** 量子化で ±1.0 を超えて飽和したサンプル数（出力段のリミッターがあるので通常 0） */
  clippedSamples: number
  /** データ部のバイト数 */
  dataBytes: number
}

/** RIFF のサイズ欄は 32 bit。データ部 + ヘッダーがこれを超える WAV は作れない */
export const WAV_MAX_DATA_BYTES = 0xffffffff - 36
const HEADER_BYTES = 44
/** データ部を分割する塊のフレーム数 */
const CHUNK_FRAMES = 1 << 16

export function wavDataBytes(frames: number, channels: number, bitDepth: WavBitDepth): number {
  return frames * channels * (bitDepth / 8)
}

/** 書き出せるか（RIFF の 4 GiB 制限）。超える場合は理由を返す */
export function wavSizeError(frames: number, channels: number, bitDepth: WavBitDepth): string | null {
  const bytes = wavDataBytes(frames, channels, bitDepth)
  if (bytes > WAV_MAX_DATA_BYTES) return `WAV の上限（4 GiB）を超えます（${(bytes / 2 ** 30).toFixed(2)} GiB）。短い音源で書き出してください。`
  return null
}

/** 44 バイトの PCM WAV ヘッダー */
export function wavHeader(frames: number, channels: number, sampleRate: number, bitDepth: WavBitDepth): ArrayBuffer {
  const dataBytes = wavDataBytes(frames, channels, bitDepth)
  const blockAlign = channels * (bitDepth / 8)
  const buf = new ArrayBuffer(HEADER_BYTES)
  const v = new DataView(buf)
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true) // fmt チャンクの長さ
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, channels, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * blockAlign, true)
  v.setUint16(32, blockAlign, true)
  v.setUint16(34, bitDepth, true)
  ascii(36, 'data')
  v.setUint32(40, dataBytes, true)
  return buf
}

/** xorshift32（ディザ用の決定的な乱数、0〜1） */
function rng(seed: number) {
  let s = seed >>> 0 || 0x9e3779b9
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

/**
 * 浮動小数点 PCM（−1〜1）を整数に量子化する。
 * 16-bit: 値 × 32767 に TPDF ディザ（2 つの一様乱数の差、±1 LSB）を加えて四捨五入。厳密に 0 のサンプル（デジタル無音）には
 * ディザを加えない（無音の入力・ファイル末尾が雑音にならないように）。24-bit: 値 × 8388607 を四捨五入。
 */
export function encodeWavParts(channels: Float32Array[], o: WavOptions): { parts: ArrayBuffer[]; stats: WavStats } {
  const nch = channels.length
  const frames = channels[0]?.length ?? 0
  const err = wavSizeError(frames, nch, o.bitDepth)
  if (err) throw new RangeError(err)
  const bytesPer = o.bitDepth / 8
  const full = o.bitDepth === 16 ? 32767 : 8388607
  const lo = -full - 1
  const dither = o.bitDepth === 16 && (o.dither ?? true)
  const rand = rng(o.seed ?? 1)
  let clipped = 0
  const parts: ArrayBuffer[] = [wavHeader(frames, nch, o.sampleRate, o.bitDepth)]
  for (let f0 = 0; f0 < frames; f0 += CHUNK_FRAMES) {
    const n = Math.min(CHUNK_FRAMES, frames - f0)
    const buf = new ArrayBuffer(n * nch * bytesPer)
    const v = new DataView(buf)
    let off = 0
    for (let i = f0; i < f0 + n; i++) {
      for (let c = 0; c < nch; c++) {
        const x = channels[c][i]
        let q = x === 0 ? 0 : Math.round(x * full + (dither ? rand() - rand() : 0))
        if (q > full) {
          q = full
          clipped++
        } else if (q < lo) {
          q = lo
          clipped++
        }
        if (bytesPer === 2) v.setInt16(off, q, true)
        else {
          v.setUint8(off, q & 0xff)
          v.setUint8(off + 1, (q >> 8) & 0xff)
          v.setUint8(off + 2, (q >> 16) & 0xff)
        }
        off += bytesPer
      }
    }
    parts.push(buf)
  }
  return { parts, stats: { clippedSamples: clipped, dataBytes: wavDataBytes(frames, nch, o.bitDepth) } }
}

export function encodeWav(channels: Float32Array[], o: WavOptions): { blob: Blob; stats: WavStats } {
  const { parts, stats } = encodeWavParts(channels, o)
  return { blob: new Blob(parts, { type: 'audio/wav' }), stats }
}
