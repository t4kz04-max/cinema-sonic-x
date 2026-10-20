// 書き出し（Phase 06）の仕様: 余韻の長さ・メモリの見積もり・要求と結果の型（純粋関数）。

import type { DspConfig } from '../dspConfig'
import type { DynamicsSettings } from '../dynamicsTypes'
import { MAX_IR_SECONDS } from '../spatial/hallImpulse'
import { CINEMA_REFLECTIONS, cinemaSettings, HALL_ER_TAPS_MS, hallSettings, isTailActive, tailSettings, wideSettings, type SpatialParams } from '../spatial/spatialSpec'
import { TAIL_MAX_IR_SECONDS } from '../spatial/tailImpulse'
import { wavDataBytes, type WavBitDepth } from './wavEncoder'

/**
 * 余韻の後ろに足す余裕（秒）: フィルターの減衰・リミッターの解放・Dynamic Tail の平滑化など。
 * 残響そのものの長さは IR から決まるので、ここは短くてよい
 */
const TAIL_MARGIN_SECONDS = 0.25
/** 末尾を切り詰めるしきい値（−100 dBFS。16-bit の 1 LSB = −96 dBFS より小さい） */
export const TAIL_SILENCE_THRESHOLD = 1e-5
/** 末尾のフェードアウト（秒）。しきい値以下の残りを 0 へ滑らかにつなぐ */
export const END_FADE_SECONDS = 0.02
/** 最後にしきい値を超えたサンプルから残す長さ（秒） */
export const TAIL_KEEP_AFTER_SECONDS = 0.15

/**
 * 音源が終わった後に処理が鳴り続ける最大の長さ（秒）。設定された残響の IR の長さ・プリディレイ・
 * 反射音の最大遅延から決める（固定値ではない）。IR は有限長（RT60 × 1.3、最大 4.5 / 8 秒）なので上限がある
 */
export function reverbTailSeconds(p: SpatialParams): number {
  if (p.mode === 'off') return 0
  if (p.mode === 'wide') return Math.max(...wideSettings(p).ambienceDelaysMs) / 1000
  if (isTailActive(p)) {
    const t = tailSettings(p)
    const early = p.mode === 'hall' ? hallErMaxSeconds(p) : cinemaReflectionMaxSeconds(p)
    return Math.max(early, t.preDelayMs / 1000 + Math.min(t.rt60 * 1.3, TAIL_MAX_IR_SECONDS))
  }
  if (p.mode === 'cinema') return cinemaReflectionMaxSeconds(p)
  const h = hallSettings(p)
  return Math.max(hallErMaxSeconds(p), h.preDelayMs / 1000 + Math.min(h.rt60 * 1.3, MAX_IR_SECONDS))
}

function hallErMaxSeconds(p: SpatialParams): number {
  return (Math.max(...HALL_ER_TAPS_MS) * hallSettings(p).erScale * 1.09) / 1000
}

function cinemaReflectionMaxSeconds(p: SpatialParams): number {
  const s = cinemaSettings(p)
  return (Math.max(...CINEMA_REFLECTIONS.map((r) => r.baseDelayMs)) * s.roomScale * s.itdgScale) / 1000
}

/** 書き出すレンダリングの長さ（秒）: 処理の遅延（先頭で切り捨てる分）+ 音源 + 余韻 + 余裕 */
export function renderSeconds(sourceSeconds: number, headLatencySeconds: number, p: SpatialParams): number {
  return headLatencySeconds + sourceSeconds + reverbTailSeconds(p) + TAIL_MARGIN_SECONDS
}

/** 書き出しの上限（秒）。メモリの見積もりとは別に、極端に長い音源を止める */
export const EXPORT_MAX_SECONDS = 30 * 60

/**
 * 書き出しに必要なメモリの見積もり（バイト）。
 * 音源のコピー（親 → 書き出し用フレームへ送る分と、フレーム内の AudioBuffer）、レンダリング結果（OfflineAudioContext の
 * 出力 + 切り詰めたコピー）、WAV のデータ、IR・畳み込みなどの固定分
 */
export function estimateExportBytes(sourceFrames: number, sourceChannels: number, sampleRate: number, p: SpatialParams, bitDepth: WavBitDepth): number {
  const renderFrames = Math.ceil(renderSeconds(sourceFrames / sampleRate, 0.1, p) * sampleRate)
  const source = sourceFrames * sourceChannels * 4 * 2
  const render = renderFrames * 2 * 4 * 2
  const wav = wavDataBytes(renderFrames, 2, bitDepth)
  const fixed = 160 * 2 ** 20
  return source + render + wav + fixed
}

/** 書き出しに使ってよいメモリ（バイト）。端末のメモリ（navigator.deviceMemory、GB・上限 8）の 1/4、不明なら 1 GiB */
export function exportMemoryBudget(deviceMemoryGb: number | undefined): number {
  const gb = deviceMemoryGb && Number.isFinite(deviceMemoryGb) ? deviceMemoryGb : 4
  return Math.min(2 * 2 ** 30, gb * 2 ** 30 * 0.25)
}

/** 書き出し用フレームへ送る要求（構造化複製できる値だけ） */
export interface ExportRequest {
  /** 音源の PCM（チャンネルごと）。転送（transfer）するので、呼び出し側はコピーを渡す */
  channels: Float32Array[]
  sampleRate: number
  dsp: DspConfig
  /** 処理計画（再生と同じ値）: 重低音の EQ 倍率・ダイナミクス、空間のトリム・WIDE の Side 上限 */
  bassScale: number
  bassDynamics: DynamicsSettings
  spatialTrimDb: number
  wideSideCapDb: number
  bitDepth: WavBitDepth
  ditherSeed: number
  /** 量子化前の浮動小数点の結果も返す（試験用・動画の音声差し替え用） */
  returnFloat?: boolean
  /** false: WAV を作らない（動画の音声差し替えでは浮動小数点の結果だけを使う。既定 true） */
  encodeWav?: boolean
  /**
   * 試験専用: この段階の開始で処理を止めたままにする（監視・打ち切り・復旧の試験用。UI からは使わない）。
   * attempt を付けると、その回の試行だけ止める（自動の再試行の試験）
   */
  debugStall?: { stage: ExportTraceStage; attempt?: number }
}

export type ExportStage = 'preparing' | 'rendering' | 'encoding'

/**
 * 書き出しの処理段階（記録用）。親: frame（iframe の生成）・init（フレームの初期化 = ready を受け取るまで）・transfer（音源の受け渡し）・return（結果の受け取り）。
 * フレーム内: hrtf（HRTF の遅延の測定）・context（OfflineAudioContext の作成）・worklets（AudioWorklet モジュールの読み込み）・
 * chain（DSP チェーンの構築）・render-start（startRendering の呼び出し）・render（レンダリング完了まで）・encode（WAV エンコード）
 */
export type ExportTraceStage = 'frame' | 'init' | 'transfer' | 'hrtf' | 'context' | 'worklets' | 'chain' | 'render-start' | 'render' | 'encode' | 'return'

export interface ExportTraceEvent {
  stage: ExportTraceStage
  phase: 'start' | 'end' | 'fail'
  /** 書き出しの開始からの経過時間（ms、親ウィンドウの時計） */
  t: number
  /** 補足（モジュール名・エラー名など。音声の内容・ファイル名は入れない） */
  detail?: string
}

/** 1 回の書き出しの記録（音声の内容・ファイル名は含まない） */
export interface ExportTrace {
  id: string
  /** 何回目の試行か（自動の再試行で 2） */
  attempt: number
  browser: string
  input: { sampleRate: number; channels: number; seconds: number; spatialMode: string; motion: boolean; bassEnabled: boolean; returnFloat: boolean; encodeWav: boolean }
  events: ExportTraceEvent[]
  outcome: 'running' | 'done' | 'cancelled' | 'timeout' | 'error'
  /** 打ち切ったとき: 止まっていた段階と、進まなかった時間（ms） */
  stalled?: { stage: ExportStage; ms: number }
}

/**
 * 書き出しの監視の時間（ms）。進捗（段階の記録・レンダリングの割合）が届くたびに数え直すので、長い音源でも正常な処理は止めない。
 * - prepareStallMs: 準備（フレームの初期化〜startRendering）で、段階の記録が届かない時間の上限。通常は数秒以内（実測は下記の記録）
 * - renderStallMs: レンダリング中に割合が届かない時間の上限。割合は最大 RENDER_PROGRESS_MAX_SECONDS の音声ごとに届く
 * - encodeBaseMs / encodeMsPerSecond: WAV エンコード〜結果の受け取りの上限（同期処理で途中の進捗がないため、音声の長さに比例させる）
 */
export interface ExportWatchdog {
  prepareStallMs: number
  renderStallMs: number
  encodeBaseMs: number
  encodeMsPerSecond: number
  /** 準備の段階で打ち切ったときの自動の再試行の回数（音源を送る前に止まった場合だけ。無限には繰り返さない） */
  prepareRetries: number
}

export const DEFAULT_EXPORT_WATCHDOG: ExportWatchdog = { prepareStallMs: 30000, renderStallMs: 60000, encodeBaseMs: 60000, encodeMsPerSecond: 200, prepareRetries: 1 }

/** レンダリングの進捗を測る間隔の上限（音声の秒）。長い音源でも進捗が一定の間隔で届くようにする（監視のため） */
export const RENDER_PROGRESS_MAX_SECONDS = 5

export interface ExportProgress {
  stage: ExportStage
  /** rendering のときだけ: レンダリング済みの音声の割合（OfflineAudioContext.suspend で実際に測った値、0〜1） */
  rendered?: number
}

export interface ExportResult {
  blob: Blob
  sampleRate: number
  bitDepth: WavBitDepth
  channels: number
  frames: number
  /** 音源の長さ・余韻として足した長さ・先頭で切り捨てた処理の遅延（秒） */
  sourceSeconds: number
  tailSeconds: number
  headTrimSeconds: number
  /** 書き出した音声（量子化前）のサンプルピーク（dBFS）と統合ラウドネス（LUFS） */
  peakDb: number
  loudnessLufs: number
  clippedSamples: number
  /** レンダリングにかかった時間（ms） */
  renderMs: number
  /** returnFloat のときだけ */
  float?: Float32Array[]
}
