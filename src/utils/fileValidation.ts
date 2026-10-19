import type { LoadError } from '../types/audio'
import { formatBytes } from './format'

/**
 * デコード後の PCM は 32bit float × チャンネル数 × サンプル数となり、
 * 圧縮音源では元ファイルの10倍以上になる。タブのメモリ不足を避けるため上限を設ける。
 */
export const MAX_FILE_BYTES = 300 * 1024 * 1024

export const ACCEPT_ATTR = '.mp3,.wav,.wave,.flac,.ogg,.oga,.opus,.m4a,.aac,.mp4,.webm,audio/*'

/** 対応形式（自己診断・実アプリで確認） */
const SUPPORTED_EXTENSIONS = ['mp3', 'wav', 'wave']
/** ブラウザのデコーダーが対応していれば読み込める形式（ブラウザ・コーデックにより失敗する場合がある） */
const BROWSER_EXTENSIONS = ['flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'mp4', 'webm']

/** 形式ごとの対応状況（UI 表示用） */
export const FORMAT_SUPPORT: { formats: string; status: string }[] = [
  { formats: 'WAV（PCM 16/24/32-bit・float）', status: '対応' },
  { formats: 'MP3', status: '対応（ブラウザのデコーダー）' },
  { formats: 'FLAC / Ogg（Vorbis・Opus）/ M4A（AAC）/ WebM', status: 'ブラウザが対応していれば読み込み可（未検証の形式あり。失敗時はエラー表示）' },
]

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 読み込み前に判定できるエラー（拡張子・サイズ）を検査する */
export function precheckFile(file: File): LoadError | null {
  const ext = extensionOf(file.name)
  if (!SUPPORTED_EXTENSIONS.includes(ext) && !BROWSER_EXTENSIONS.includes(ext)) {
    return {
      kind: 'unsupported',
      message: '非対応のファイル形式です。WAV または MP3 ファイルを選択してください（FLAC・Ogg・M4A・WebM はブラウザが対応していれば読み込めます）。',
      detail: `選択されたファイル: ${file.name}`,
    }
  }
  if (file.size === 0) {
    return { kind: 'empty', message: 'ファイルが空です（0 バイト）。', detail: file.name }
  }
  if (file.size > MAX_FILE_BYTES) {
    return {
      kind: 'too-large',
      message: `ファイルサイズ（${formatBytes(file.size)}）が上限 ${formatBytes(MAX_FILE_BYTES)} を超えています。`,
      detail: 'デコード後の音声データはファイルより大きくなるため、メモリ不足を防ぐ目的で制限しています。',
    }
  }
  return null
}

/** デコード済み PCM のメモリ使用量（Float32） */
export function estimateDecodedBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * 4
}
