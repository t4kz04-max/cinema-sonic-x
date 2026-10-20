// 動画ファイルの判定（拡張子ではなく中身で: コンテナの形式・トラック・コーデック）。読み込みは必要な部分だけ（ファイル全体は読まない）。

import { ALL_FORMATS, BlobSource, Input, MATROSKA, MP4, QTFF, WEBM, type InputAudioTrack, type InputVideoTrack } from 'mediabunny'
import type { AudioTrackInfo, VideoContainer, VideoInfo, VideoTrackInfo } from './videoSpec'

export type VideoProbeErrorKind = 'not-video' | 'unsupported-container' | 'unsupported-codec' | 'read'

export class VideoProbeError extends Error {
  readonly kind: VideoProbeErrorKind
  readonly detail?: string
  constructor(message: string, kind: VideoProbeErrorKind, detail?: string) {
    super(message)
    this.name = 'VideoProbeError'
    this.kind = kind
    this.detail = detail
  }
}

/** 動画のコンテナとして読めるかだけを確認する（音声ファイルとの振り分け用）。映像トラックがあれば true */
export async function hasVideoTrack(file: Blob): Promise<boolean> {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF, WEBM, MATROSKA] })
  try {
    if (!(await input.canRead())) return false
    return (await input.getPrimaryVideoTrack()) !== null
  } catch {
    return false
  } finally {
    input.dispose()
  }
}

async function videoInfoOf(t: InputVideoTrack): Promise<VideoTrackInfo> {
  let fps: number | null = null
  try {
    const stats = await t.computePacketStats(120)
    fps = stats.averagePacketRate > 0 ? stats.averagePacketRate : null
  } catch {
    fps = null
  }
  return {
    codec: (await t.getCodec()) ?? 'unknown',
    codecString: await t.getCodecParameterString(),
    width: await t.getDisplayWidth(),
    height: await t.getDisplayHeight(),
    rotation: await t.getRotation(),
    fps,
    startTime: await t.getFirstTimestamp(),
    duration: await t.computeDuration(),
    canDecode: await t.canDecode(),
  }
}

async function audioInfoOf(t: InputAudioTrack): Promise<AudioTrackInfo> {
  return {
    id: t.id,
    codec: (await t.getCodec()) ?? 'unknown',
    sampleRate: await t.getSampleRate(),
    channels: await t.getNumberOfChannels(),
    startTime: await t.getFirstTimestamp(),
    duration: await t.computeDuration(),
    language: await t.getLanguageCode(),
    canDecode: await t.canDecode(),
  }
}

/** 動画ファイルの情報。動画でない・対応しないコンテナ・映像コーデックが不明な場合は VideoProbeError */
export async function probeVideo(file: File): Promise<VideoInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    let format
    try {
      if (!(await input.canRead())) throw new VideoProbeError('動画のコンテナを認識できませんでした。', 'unsupported-container', 'MP4 / MOV / WebM / MKV のファイルを選択してください。')
      format = await input.getFormat()
    } catch (e) {
      if (e instanceof VideoProbeError) throw e
      throw new VideoProbeError('動画ファイルを読み込めませんでした（壊れているか、対応していない形式です）。', 'read', e instanceof Error ? e.message : String(e))
    }
    const container: VideoContainer | null = format === MP4 ? 'mp4' : format === QTFF ? 'mov' : format === WEBM ? 'webm' : format === MATROSKA ? 'mkv' : null
    if (!container) throw new VideoProbeError(`対応していないコンテナです（${format.name}）。`, 'unsupported-container', 'MP4 / MOV / WebM / MKV に対応しています。')
    const v = await input.getPrimaryVideoTrack()
    if (!v) throw new VideoProbeError('映像トラックがありません。', 'not-video')
    const video = await videoInfoOf(v)
    if (video.codec === 'unknown') throw new VideoProbeError('映像のコーデックを判定できませんでした。', 'unsupported-codec', `内部のコーデック ID: ${String(await v.getInternalCodecId())}`)
    const audioTracks = await Promise.all((await input.getAudioTracks()).map(audioInfoOf))
    const primary = await input.getPrimaryAudioTrack()
    return {
      fileName: file.name,
      fileSizeBytes: file.size,
      container,
      formatName: format.name,
      mimeType: await input.getMimeType(),
      duration: await input.computeDuration(),
      video,
      audioTracks,
      primaryAudioId: primary ? primary.id : null,
    }
  } finally {
    input.dispose()
  }
}
