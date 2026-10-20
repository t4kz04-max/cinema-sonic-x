import type { Spectrum } from '../audio/spectrum'
import type { StereoMetrics } from '../audio/stereoMetrics'
import type { VideoInfo } from '../video/videoSpec'

/**
 * wav / mp3: 対応形式。flac / ogg / m4a / webm: ブラウザのデコーダーが対応していれば読み込める形式。
 * mp4 / mov / mkv（と映像つきの webm）: 動画（Phase 07。音声トラックを取り出して処理する）
 */
export type SourceFormat = 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'webm' | 'mp4' | 'mov' | 'mkv'

/** ファイルヘッダーから読み取った元データの情報（取得できない項目は null） */
export interface SourceHeaderInfo {
  sampleRate: number | null
  channels: number | null
  /** WAV のみ: 量子化ビット数 */
  bitDepth: number | null
  /** MP3 のみ: 先頭フレームのビットレート。VBR の場合は平均値と異なる */
  bitrateKbps: number | null
  codec: string | null
}

export interface LoadedAudio {
  fileName: string
  fileSizeBytes: number
  format: SourceFormat
  header: SourceHeaderInfo
  /** AudioContext のサンプルレートでデコード済みの PCM */
  buffer: AudioBuffer
  /** 元のファイル（書き出し時に元のサンプルレートでデコードし直すため。音声はブラウザの外へ送らない） */
  file: File
  /**
   * 動画のとき: コンテナ・トラックの情報と、取り出した音声の開始時刻（秒、映像と同じ時刻の軸）。
   * buffer は音声トラックを元のサンプルレートでデコードしたもの（decodeAudioData は開始時刻を失うため使わない）
   */
  video?: { info: VideoInfo; audioStart: number }
}

export type PlaybackStatus = 'stopped' | 'playing' | 'paused'

export interface DspStatus {
  /**
   * idle: 音源未読み込み / measuring: 計測中 / ready: 適用済み
   * silent: 無音のため計測不能（補正 0 dB） / error: 計測失敗（直前の値を維持）
   * standby: 重低音 OFF のため未計測（ON にすると計測。解析用の文脈を無駄に作らない）
   */
  analysis: 'idle' | 'measuring' | 'ready' | 'silent' | 'error' | 'standby'
  /** worklet: 低域コンプ＋サンプルピークリミッター / fallback: AudioWorklet 非対応時の簡易コンプ */
  dynamicsEngine: 'worklet' | 'fallback' | null
  trimDb: number
  trimReason: 'none' | 'peak' | 'loudness'
  /** EQ 合成特性の上限による倍率 / 安全予算による倍率（1 = 制限なし） */
  capScale: number
  safetyScale: number
  bassThresholdDb: number | null
  loudnessDeltaLu: number | null
  outputPeakDb: number | null
  predictedLimiterGrDb: number | null
  spectra: { before: Spectrum; after: Spectrum } | null
  /** フォールバックのコンプ・メイクアップ打消し（dB）。未計測は null */
  makeupCancelDb: number | null
  spatial: SpatialStatus
  compare: CompareStatus
}

/** ORIGINAL/PROCESSED 比較と解析の状態 */
export interface CompareStatus {
  /** ORIGINAL 経路の時刻合わせ（ms、処理経路の遅延と同じ）。時刻合わせが使えない環境では null */
  alignMs: number | null
  /** 解析用 OfflineAudioContext の作成回数（うち AudioWorklet を読み込んだもの）と、キャッシュから反映した回数 */
  analysis: { renders: number; workletRenders: number; cacheHits: number }
}

export interface SpatialStatus {
  analysis: 'idle' | 'measuring' | 'ready' | 'silent' | 'error'
  /** 原音とラウドネスをそろえるトリム（dB） */
  trimDb: number
  /** WIDE の Side ゲイン上限（原音の幅から決定） */
  wideSideCapDb: number | null
  before: StereoMetrics | null
  after: StereoMetrics | null
  monoColorationDb: number | null
  stereoColorationDb: number | null
  predictedLimiterGrDb: number | null
  hrtfLatencyMs: number | null
  /** Motion Engine（AudioWorklet）が使えるか */
  motionAvailable: boolean
  /** Spatial Tail: worklet = Dynamic Tail・蓄積防止あり / fallback = 残響のみ / null = 未初期化 */
  tailEngine: 'worklet' | 'fallback' | null
}

export interface DspMeters {
  bassGrDb: number
  limiterGrDb: number
  spatialLimiterGrDb: number
}

export type LoadErrorKind =
  | 'unsupported'
  | 'empty'
  | 'too-large'
  | 'read'
  | 'decode'
  | 'memory'
  | 'context'
  | 'no-audio'

export interface LoadError {
  kind: LoadErrorKind
  message: string
  detail?: string
}
