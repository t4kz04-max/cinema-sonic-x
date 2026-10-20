// Phase 07: 動画の扱いの仕様（型・上限・見積もり）。処理方式は docs/SPATIAL.md の「動画処理方式の比較」を参照。
// コンテナの読み書きは mediabunny（MP4 / MOV / WebM / MKV）、デコード・エンコードはブラウザの WebCodecs。

import { estimateExportBytes } from '../audio/export/exportSpec'
import type { SpatialParams } from '../audio/spatial/spatialSpec'

export type VideoContainer = 'mp4' | 'mov' | 'webm' | 'mkv'

export class VideoCancelledError extends Error {
  constructor() {
    super('処理をキャンセルしました')
    this.name = 'VideoCancelledError'
  }
}

/** 動画の書き込み（映像のコピー + 音声のエンコード）が一定時間進まなかった。後始末は済んでいて、もう一度書き出せる */
export class VideoTimeoutError extends Error {
  readonly stalledMs: number
  constructor(stalledMs: number) {
    super(`動画の書き込み（MUXING）が ${Math.round(stalledMs / 1000)} 秒進まなかったため中止しました。もう一度書き出してください。`)
    this.name = 'VideoTimeoutError'
    this.stalledMs = stalledMs
  }
}

/** 動画の書き込みで、進捗（映像のパケット・音声のまとまり）が届かない時間の上限（ms） */
export const MUX_STALL_MS = 60000

export interface VideoTrackInfo {
  codec: string
  /** コーデック文字列（例 avc1.42001f）。不明なら null */
  codecString: string | null
  width: number
  height: number
  rotation: number
  /** 平均フレームレート（パケットの統計から）。不明なら null */
  fps: number | null
  startTime: number
  duration: number
  /** このブラウザでデコード（プレビュー）できるか。書き出し（ストリームコピー）には不要 */
  canDecode: boolean
}

export interface AudioTrackInfo {
  /** トラックの ID（コンテナ内） */
  id: number
  codec: string
  sampleRate: number
  channels: number
  startTime: number
  duration: number
  language: string
  /** このブラウザでデコードできるか（できなければ抽出できない） */
  canDecode: boolean
}

export interface VideoInfo {
  fileName: string
  fileSizeBytes: number
  container: VideoContainer
  /** 判定した形式の名前（mediabunny の InputFormat 名） */
  formatName: string
  mimeType: string
  duration: number
  video: VideoTrackInfo
  audioTracks: AudioTrackInfo[]
  /** 処理する音声トラック（最初のトラック、既定の指定があればそれ）。音声がなければ null */
  primaryAudioId: number | null
}

/** 抽出した音声（元のサンプルレート・コンテナの時刻つき） */
export interface ExtractedAudio {
  channels: Float32Array[]
  sampleRate: number
  /** 最初のサンプルの時刻（秒、コンテナの時刻。映像の時刻と同じ軸） */
  startTime: number
}

/** 動画の余韻の扱い: trim = 映像の長さを保つ（映像の終わりで切り、20 ms フェード）/ extend = 最後のフレームを延ばして余韻を最後まで */
export type VideoTailMode = 'trim' | 'extend'

/** 読み込める動画ファイルの上限（バイト）。映像は読み込みながらコピーするが、出力は全体をメモリに持つため */
export const MAX_VIDEO_FILE_BYTES = 1024 * 1024 * 1024
/** 出力の音声のビットレート */
export const VIDEO_AUDIO_BITRATE = { aac: 192_000, opus: 160_000 } as const
/** 映像の終わりで音声を切るときのフェード（秒） */
export const VIDEO_END_FADE_SECONDS = 0.02

/** 出力のコンテナ（入力と同じ系統。MOV は MOV、MKV は MKV のまま） */
export const outputContainerFor = (c: VideoContainer): VideoContainer => c

/** 出力の音声コーデック: MP4 / MOV は AAC（エンコードできなければ Opus）、WebM / MKV は Opus */
export function outputAudioCodecFor(c: VideoContainer, aacAvailable: boolean): 'aac' | 'opus' {
  return (c === 'mp4' || c === 'mov') && aacAvailable ? 'aac' : 'opus'
}

export const MIME_OF: Record<VideoContainer, string> = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska' }
export const EXT_OF: Record<VideoContainer, string> = { mp4: 'mp4', mov: 'mov', webm: 'webm', mkv: 'mkv' }

/**
 * 動画の書き出しに必要なメモリの見積もり（バイト）: 映像のコピー（出力はメモリに持つ。バッファーの拡張で最大 2 倍）+
 * 音声の書き出し（Phase 06 の見積もり）+ 抽出した音声
 */
export function estimateVideoExportBytes(info: VideoInfo, audio: { frames: number; channels: number; sampleRate: number } | null, p: SpatialParams): number {
  const videoCopy = info.fileSizeBytes * 2
  const audioExport = audio ? estimateExportBytes(audio.frames, audio.channels, audio.sampleRate, p, 16) : 0
  const extracted = audio ? audio.frames * audio.channels * 4 : 0
  return videoCopy + audioExport + extracted
}

/**
 * 出力ファイルの大きさの見積もり（バイト、上限の目安）: 入力ファイル全体（映像 + 元の音声）+ 新しい音声のビットレート × 長さ。
 * 元の音声は出力に含めないので、実際はこれより元の音声の分だけ小さい
 */
export function estimateVideoOutputBytes(info: VideoInfo, codec: 'aac' | 'opus', seconds: number): number {
  return Math.round(info.fileSizeBytes + (VIDEO_AUDIO_BITRATE[codec] / 8) * seconds)
}
