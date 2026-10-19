import type { LoadError, LoadedAudio } from '../types/audio'
import { inspectAudioHeader } from '../utils/audioHeader'
import { precheckFile } from '../utils/fileValidation'
import { AudioContextUnavailableError } from './AudioEngine'

export type LoadResult = { ok: true; audio: LoadedAudio } | { ok: false; error: LoadError }

function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}

function isMemoryError(e: unknown): boolean {
  // ArrayBuffer / AudioBuffer の確保失敗は Chrome では RangeError になる
  if (e instanceof RangeError) return true
  if (e instanceof DOMException && e.name === 'QuotaExceededError') return true
  const msg = e instanceof Error ? e.message : String(e)
  return /out of memory|allocation|memory/i.test(msg)
}

const MEMORY_ERROR: Omit<LoadError, 'detail'> = {
  kind: 'memory',
  message: 'メモリ不足のため音源を読み込めませんでした。',
}
const MEMORY_HINT = '他のタブを閉じるか、より短い音源で再度お試しください。'

export async function loadAudioFile(
  file: File,
  decode: (data: ArrayBuffer) => Promise<AudioBuffer>,
): Promise<LoadResult> {
  const pre = precheckFile(file)
  if (pre) return { ok: false, error: pre }

  let data: ArrayBuffer
  try {
    data = await file.arrayBuffer()
  } catch (e) {
    if (isMemoryError(e)) return { ok: false, error: { ...MEMORY_ERROR, detail: MEMORY_HINT } }
    return {
      ok: false,
      error: {
        kind: 'read',
        message: 'ファイルを読み込めませんでした。ファイルが移動・削除されていないか確認してください。',
        detail: errorText(e),
      },
    }
  }

  // decodeAudioData が data を detach する前にヘッダーを解析する
  const inspected = inspectAudioHeader(new Uint8Array(data))
  if (!inspected) {
    return {
      ok: false,
      error: {
        kind: 'unsupported',
        message: 'ファイルの中身を対応する音声形式（WAV / MP3 / FLAC / Ogg / M4A / WebM）として認識できませんでした。',
        detail: '拡張子だけが変更された別形式のファイルや、破損したファイルの可能性があります。',
      },
    }
  }

  let buffer: AudioBuffer
  try {
    buffer = await decode(data)
  } catch (e) {
    if (e instanceof AudioContextUnavailableError) {
      return {
        ok: false,
        error: {
          kind: 'context',
          message: 'このブラウザでは Web Audio API を初期化できませんでした。最新の Chrome / Edge をお使いください。',
          detail: errorText(e.cause),
        },
      }
    }
    if (isMemoryError(e)) return { ok: false, error: { ...MEMORY_ERROR, detail: MEMORY_HINT } }
    return {
      ok: false,
      error: {
        kind: 'decode',
        message: '音声データをデコードできませんでした。ファイルが破損しているか、ブラウザが対応していないコーデックです。',
        detail: errorText(e),
      },
    }
  }

  if (buffer.length === 0) {
    return {
      ok: false,
      error: { kind: 'decode', message: 'デコード結果に音声サンプルが含まれていません。' },
    }
  }

  return {
    ok: true,
    audio: {
      fileName: file.name,
      fileSizeBytes: file.size,
      format: inspected.format,
      header: inspected.header,
      buffer,
      file,
    },
  }
}
