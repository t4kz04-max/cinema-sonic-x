// 親ウィンドウ ⇄ 書き出し用フレームのメッセージ
// 2 段階: prepare（音源なしの設定だけ。フレームが文脈・ワークレットを準備）→ prepared → render（音源を転送してレンダリング）。
// 準備で止まった場合に、音源を送る前なので音源のコピーを持たずに作り直せる（再試行のため）
import type { ExportProgress, ExportRequest, ExportResult, ExportTraceStage } from './exportSpec'

/** 準備に使う要求（音源の PCM を除く。音源の長さ・チャンネル数だけ） */
export type PrepareRequest = Omit<ExportRequest, 'channels'> & { frames: number; channelCount: number }

export type ParentMessage = { type: 'prepare'; request: PrepareRequest; id: string; attempt: number } | { type: 'render'; channels: Float32Array[] }

export type FrameMessage =
  | { type: 'ready' }
  | { type: 'trace'; stage: ExportTraceStage; phase: 'start' | 'end' | 'fail'; detail?: string }
  | { type: 'prepared' }
  | { type: 'progress'; progress: ExportProgress }
  | { type: 'done'; result: ExportResult }
  | { type: 'error'; name: string; message: string }
