import type { SourceFormat, SourceHeaderInfo } from '../types/audio'

// decodeAudioData は AudioContext のレートへリサンプルしてしまうため、
// 元ファイルのサンプルレート等はヘッダーを直接読んで取得する。

const EMPTY_HEADER: SourceHeaderInfo = {
  sampleRate: null,
  channels: null,
  bitDepth: null,
  bitrateKbps: null,
  codec: null,
}

/** ID3 タグの後ろから MP3 フレームを探す範囲 */
const MP3_SCAN_LIMIT = 256 * 1024

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let s = ''
  for (let i = 0; i < length && offset + i < bytes.length; i++) {
    s += String.fromCharCode(bytes[offset + i])
  }
  return s
}

function wavCodecName(tag: number): string {
  switch (tag) {
    case 0x0001:
      return 'Linear PCM'
    case 0x0003:
      return 'IEEE Float'
    case 0x0002:
      return 'MS ADPCM'
    case 0x0006:
      return 'A-law'
    case 0x0007:
      return 'μ-law'
    default:
      return `形式コード 0x${tag.toString(16).padStart(4, '0')}`
  }
}

export function parseWavHeader(bytes: Uint8Array): SourceHeaderInfo | null {
  if (bytes.length < 12) return null
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = readAscii(bytes, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      let tag = view.getUint16(body, true)
      // WAVE_FORMAT_EXTENSIBLE は SubFormat GUID の先頭2バイトが実際の形式
      if (tag === 0xfffe && size >= 40 && body + 26 <= bytes.length) {
        tag = view.getUint16(body + 24, true)
      }
      return {
        sampleRate: view.getUint32(body + 4, true),
        channels: view.getUint16(body + 2, true),
        bitDepth: view.getUint16(body + 14, true),
        bitrateKbps: null,
        codec: wavCodecName(tag),
      }
    }
    // RIFF チャンクは偶数境界に揃えられる
    offset = body + size + (size % 2)
  }
  return { ...EMPTY_HEADER }
}

const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MPEG2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000]

interface Mp3Frame {
  sampleRate: number
  channels: number
  bitrateKbps: number
  length: number
  version: string
}

function readMp3Frame(b: Uint8Array, off: number): Mp3Frame | null {
  if (off + 4 > b.length) return null
  if (b[off] !== 0xff || (b[off + 1] & 0xe0) !== 0xe0) return null
  const versionBits = (b[off + 1] >> 3) & 0x3
  const layerBits = (b[off + 1] >> 1) & 0x3
  const bitrateIdx = b[off + 2] >> 4
  const rateIdx = (b[off + 2] >> 2) & 0x3
  // reserved 値・free format・Layer III 以外は対象外
  if (versionBits === 1 || layerBits !== 1) return null
  if (bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) return null

  const isMpeg1 = versionBits === 3
  const divisor = isMpeg1 ? 1 : versionBits === 2 ? 2 : 4
  const sampleRate = MPEG1_SAMPLE_RATES[rateIdx] / divisor
  const bitrateKbps = (isMpeg1 ? MPEG1_L3_KBPS : MPEG2_L3_KBPS)[bitrateIdx]
  const padding = (b[off + 2] >> 1) & 0x1
  const length = Math.floor(((isMpeg1 ? 144 : 72) * bitrateKbps * 1000) / sampleRate) + padding

  return {
    sampleRate,
    channels: b[off + 3] >> 6 === 3 ? 1 : 2,
    bitrateKbps,
    length,
    version: isMpeg1 ? 'MPEG-1' : versionBits === 2 ? 'MPEG-2' : 'MPEG-2.5',
  }
}

function id3v2End(bytes: Uint8Array): number {
  if (bytes.length < 10 || readAscii(bytes, 0, 3) !== 'ID3') return 0
  const size =
    ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)
  const hasFooter = (bytes[5] & 0x10) !== 0
  return 10 + size + (hasFooter ? 10 : 0)
}

export function parseMp3Header(bytes: Uint8Array): SourceHeaderInfo | null {
  const start = id3v2End(bytes)
  const end = Math.min(bytes.length - 4, start + MP3_SCAN_LIMIT)
  for (let off = start; off < end; off++) {
    const frame = readMp3Frame(bytes, off)
    if (!frame) continue
    // 次のフレームが連続して見つかる場合のみ本物とみなす（画像データ等の偽同期を除外）
    const next = readMp3Frame(bytes, off + frame.length)
    if (next && next.sampleRate === frame.sampleRate) {
      return {
        sampleRate: frame.sampleRate,
        channels: frame.channels,
        bitDepth: null,
        bitrateKbps: frame.bitrateKbps,
        codec: `${frame.version} Layer III`,
      }
    }
  }
  return null
}

/** ファイル先頭のバイト列から実際の形式を判定する。MP3/WAV でなければ null */
export function inspectAudioHeader(
  bytes: Uint8Array,
): { format: SourceFormat; header: SourceHeaderInfo } | null {
  const wav = parseWavHeader(bytes)
  if (wav) return { format: 'wav', header: wav }
  const mp3 = parseMp3Header(bytes)
  if (mp3) return { format: 'mp3', header: mp3 }
  // ID3 タグはあるがフレームを特定できない場合は、判定をデコーダーに委ねる
  if (id3v2End(bytes) > 0) return { format: 'mp3', header: { ...EMPTY_HEADER } }
  return null
}
