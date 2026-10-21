// 親ウィンドウ ⇄ 解析用フレーム（analysis-frame.html）のメッセージ（Phase 09）
import type { PlanOptions, SourceAnalysis } from '../analysis'
import type { BassParams } from '../bassSpec'
import type { SpatialPlanOptions } from '../spatial/spatialAnalysis'
import type { SpatialParams } from '../spatial/spatialSpec'
import type { StereoMetrics } from '../stereoMetrics'

/** 解析の呼び出し（excerpt は先に送った抜粋の ID） */
export type AnalysisCall =
  | { kind: 'analyzeSource'; excerpt: string }
  | { kind: 'planProcessing'; excerpt: string; source: SourceAnalysis; params: BassParams; opts: PlanOptions }
  | { kind: 'analyzeSpatialSource'; excerpt: string }
  | { kind: 'planSpatial'; excerpt: string; before: StereoMetrics; params: SpatialParams; opts: SpatialPlanOptions }

export type AnalysisParentMessage =
  | { type: 'excerpt'; id: string; channels: Float32Array<ArrayBuffer>[]; sampleRate: number }
  | { type: 'call'; callId: number; call: AnalysisCall }

export type AnalysisFrameMessage =
  | { type: 'ready' }
  /** renders / workletRenders: この呼び出しで作った解析用の OfflineAudioContext の数（親の analysisStats に足す） */
  | { type: 'result'; callId: number; value: unknown; renders: number; workletRenders: number }
  | { type: 'error'; callId: number; name: string; message: string }
