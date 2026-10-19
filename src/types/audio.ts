import type { Spectrum } from '../audio/spectrum'
import type { StereoMetrics } from '../audio/stereoMetrics'

export type SourceFormat = 'wav' | 'mp3'

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
}

export type PlaybackStatus = 'stopped' | 'playing' | 'paused'

export interface DspStatus {
  /**
   * idle: 音源未読み込み / measuring: 計測中 / ready: 適用済み
   * silent: 無音のため計測不能（補正 0 dB） / error: 計測失敗（直前の値を維持）
   */
  analysis: 'idle' | 'measuring' | 'ready' | 'silent' | 'error'
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

export interface LoadError {
  kind: LoadErrorKind
  message: string
  detail?: string
}
