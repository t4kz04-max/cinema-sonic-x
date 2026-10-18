import type { LoadError } from '../types/audio'
import { formatBytes } from './format'

/**
 * デコード後の PCM は 32bit float × チャンネル数 × サンプル数となり、
 * 圧縮音源では元ファイルの10倍以上になる。タブのメモリ不足を避けるため上限を設ける。
 */
export const MAX_FILE_BYTES = 300 * 1024 * 1024

export const ACCEPT_ATTR = '.mp3,.wav,audio/mpeg,audio/wav,audio/x-wav,audio/wave'

const SUPPORTED_EXTENSIONS = ['mp3', 'wav', 'wave']

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 読み込み前に判定できるエラー（拡張子・サイズ）を検査する */
export function precheckFile(file: File): LoadError | null {
  if (!SUPPORTED_EXTENSIONS.includes(extensionOf(file.name))) {
    return {
      kind: 'unsupported',
      message: '非対応のファイル形式です。MP3 または WAV ファイルを選択してください。',
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
