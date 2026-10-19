// 親ウィンドウ ⇄ 書き出し用フレームのメッセージ
import type { ExportProgress, ExportRequest, ExportResult } from './exportSpec'

export type ParentMessage = { type: 'render'; request: ExportRequest }

export type FrameMessage =
  | { type: 'ready' }
  | { type: 'progress'; progress: ExportProgress }
  | { type: 'done'; result: ExportResult }
  | { type: 'error'; name: string; message: string }
