import type { LoadError, LoadedAudio } from '../types/audio'
import { inspectAudioHeader } from '../utils/audioHeader'
import { isVideoExtension, MAX_FILE_BYTES, precheckFile } from '../utils/fileValidation'
import { formatBytes } from '../utils/format'

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

/**
 * 動画（映像トラックのある MP4 / MOV / WebM / MKV）: ファイル全体を読み込まず、コンテナ・トラックを判定し、
 * 音声トラックを元のサンプルレートで（開始時刻つきで）デコードする
 */
async function loadVideoFile(file: File): Promise<LoadResult> {
  const { probeVideo, VideoProbeError } = await import('../video/videoProbe')
  const { extractAudio } = await import('../video/videoAudio')
  let info
  try {
    info = await probeVideo(file)
  } catch (e) {
    if (e instanceof VideoProbeError) return { ok: false, error: { kind: e.kind === 'read' ? 'read' : 'unsupported', message: e.message, detail: e.detail } }
    return { ok: false, error: { kind: 'read', message: '動画ファイルを読み込めませんでした。', detail: errorText(e) } }
  }
  if (info.primaryAudioId === null) {
    return { ok: false, error: { kind: 'no-audio', message: 'この動画には音声トラックがありません。立体音響化する音声がないため処理できません。', detail: `${info.container.toUpperCase()} / 映像 ${info.video.codec} ${info.video.width}×${info.video.height}` } }
  }
  const track = info.audioTracks.find((t) => t.id === info.primaryAudioId)!
  if (!track.canDecode) {
    return { ok: false, error: { kind: 'decode', message: `このブラウザでは動画の音声コーデック（${track.codec}）をデコードできません。`, detail: 'AAC / Opus / MP3 / Vorbis / FLAC / PCM などブラウザが対応する音声コーデックの動画を選択してください。' } }
  }
  try {
    const audio = await extractAudio(file, { trackId: track.id })
    const buffer = new AudioBuffer({ length: audio.channels[0].length, numberOfChannels: audio.channels.length, sampleRate: audio.sampleRate })
    audio.channels.forEach((c, i) => buffer.copyToChannel(c as Float32Array<ArrayBuffer>, i))
    return {
      ok: true,
      audio: {
        fileName: file.name,
        fileSizeBytes: file.size,
        format: info.container,
        header: { sampleRate: track.sampleRate, channels: track.channels, bitDepth: null, bitrateKbps: null, codec: `${track.codec}（音声）/ ${info.video.codec}（映像）` },
        buffer,
        file,
        video: { info, audioStart: audio.startTime },
      },
    }
  } catch (e) {
    if (isMemoryError(e)) return { ok: false, error: { ...MEMORY_ERROR, detail: MEMORY_HINT } }
    return { ok: false, error: { kind: 'decode', message: '動画の音声をデコードできませんでした。', detail: errorText(e) } }
  }
}

export async function loadAudioFile(
  file: File,
  decode: (data: ArrayBuffer) => Promise<AudioBuffer>,
): Promise<LoadResult> {
  const pre = precheckFile(file)
  if (pre) return { ok: false, error: pre }
  // 動画の拡張子: 中身に映像トラックがあれば動画として読む（なければ音声ファイルとして読む）
  // 動画の処理（mediabunny）は動画を読み込むときだけ読み込む（音声だけの利用では配布サイズを増やさない）
  if (isVideoExtension(file.name) && (await (await import('../video/videoProbe')).hasVideoTrack(file))) return loadVideoFile(file)
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: { kind: 'too-large', message: `音声ファイルの上限 ${formatBytes(MAX_FILE_BYTES)} を超えています（映像トラックがないため音声として読み込もうとしました）。` } }
  }

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
        message: isVideoExtension(file.name)
          ? 'ファイルの中身を動画（MP4 / MOV / WebM / MKV の映像トラック）としても、音声としても認識できませんでした。'
          : 'ファイルの中身を対応する音声形式（WAV / MP3 / FLAC / Ogg / M4A / WebM）として認識できませんでした。',
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
