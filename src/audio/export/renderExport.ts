// 書き出しのオフラインレンダリング（Phase 06）。再生と同じ createOutputChain（重低音 → 空間）と同じ処理計画で、
// 音源全体 + 余韻を OfflineAudioContext で描画し、WAV にする。
//
//   音源（メディア時刻 0 から）→ [重低音] → [空間: CINEMA / HALL / Motion / Spatial Tail / Dynamic Tail] → 出力
//   出力の先頭の処理の遅延を切り捨て（音源と同じ時刻にそろえる）、末尾は余韻が −100 dBFS を下回ってから 150 ms 後で切り、最後の 20 ms をフェード
//
// Motion の位置はメディア時刻の純粋関数なので、transport を「時刻 0 から再生」にすれば、再生中のシーク・プレビューの
// 履歴によらず曲の先頭から同じ動きになる。PULSE の包絡は書き出す音源全体から計算する（再生と同じ関数）。
// 通常は使い捨ての iframe（exportFrame.ts）の中で実行する（Chrome が AudioWorklet を読み込んだ OfflineAudioContext を
// 解放しないため、iframe ごと破棄してメモリを返す。キャンセルも iframe の破棄で行う）。

import { loadAlignWorklet } from '../alignDelay'
import { integratedLoudness, linearToDb, samplePeak } from '../loudness'
import { createOutputChain } from '../outputChain'
import { loadDynamicsWorklet } from '../processingGraph'
import { computeEnvelope } from '../spatial/motionEnvelope'
import { loadMotionWorklet, measureHrtfLatency } from '../spatial/spatialGraph'
import { isMotionActive } from '../spatial/spatialSpec'
import { loadTailWorklet } from '../spatial/tailEngine'
import {
  END_FADE_SECONDS,
  RENDER_PROGRESS_MAX_SECONDS,
  renderSeconds,
  TAIL_KEEP_AFTER_SECONDS,
  TAIL_SILENCE_THRESHOLD,
  type ExportProgress,
  type ExportRequest,
  type ExportResult,
  type ExportTraceStage,
} from './exportSpec'
import { encodeWav } from './wavEncoder'

/** 進捗を測るための suspend の回数（多すぎるとレンダリングが遅くなる） */
const PROGRESS_STEPS = 40
const RENDER_QUANTUM = 128

export interface RenderedExport {
  /** 先頭の処理の遅延を切り捨て、末尾を切り詰めた浮動小数点の出力（ステレオ） */
  channels: Float32Array[]
  sourceSeconds: number
  tailSeconds: number
  headTrimSeconds: number
  renderMs: number
}

/** 段階の記録（開始・完了・失敗）。音声の内容は渡さない */
export type TraceFn = (stage: ExportTraceStage, phase: 'start' | 'end' | 'fail', detail?: string) => void

/** 試験専用の停止（debugStall）: 指定の段階の開始で、戻らない Promise を待つ */
const stallIf = (req: Pick<ExportRequest, 'debugStall'>, stage: ExportTraceStage, attempt: number) =>
  req.debugStall && req.debugStall.stage === stage && (req.debugStall.attempt === undefined || req.debugStall.attempt === attempt) ? new Promise<never>(() => {}) : Promise.resolve()

/** 段階を記録しながら実行する（失敗したら fail を記録してそのまま投げる） */
async function step<T>(trace: TraceFn, stage: ExportTraceStage, fn: () => T | Promise<T>, detail?: string): Promise<T> {
  trace(stage, 'start', detail)
  try {
    const v = await fn()
    trace(stage, 'end', detail)
    return v
  } catch (e) {
    trace(stage, 'fail', e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : 'error')
    throw e
  }
}

/** 準備済みの文脈（音源を受け取る前に作れる部分） */
export interface PreparedRender {
  ctx: OfflineAudioContext
  hrtfLatency: number
  motionOk: boolean
  totalFrames: number
}

/**
 * 準備: HRTF の遅延の測定 → OfflineAudioContext の作成 → AudioWorklet の読み込み。音源の PCM は使わない
 * （音源の長さだけで決まる）ので、音源を送る前に済ませられる
 */
export async function prepareRender(req: Omit<ExportRequest, 'channels'> & { frames: number }, trace: TraceFn = () => {}, attempt = 1): Promise<PreparedRender> {
  const sr = req.sampleRate
  const sourceSeconds = req.frames / sr
  const hrtfLatency = await step(trace, 'hrtf', async () => {
    await stallIf(req, 'hrtf', attempt)
    return measureHrtfLatency(sr)
  })
  // 遅延（先頭の切り捨て量）はチェーンを作ってから正確に分かるため、まず上限で長さを決める（Motion の STFT + HRTF + 先読み 2 段）
  const maxHead = 4096 / sr + hrtfLatency + 0.02
  const totalFrames = Math.ceil(renderSeconds(sourceSeconds, maxHead, req.dsp.spatial) * sr)
  const ctx = await step(trace, 'context', async () => {
    await stallIf(req, 'context', attempt)
    return new OfflineAudioContext(2, totalFrames, sr)
  })
  let motionOk = false
  await step(trace, 'worklets', async () => {
    await stallIf(req, 'worklets', attempt)
    // モジュールごとに記録する（どの読み込みで止まったかを分けるため）
    if (!(await step(trace, 'worklets', () => loadDynamicsWorklet(ctx), 'bassDynamics'))) throw new Error('AudioWorklet を読み込めませんでした（書き出しには AudioWorklet が必要です）')
    await step(trace, 'worklets', () => loadTailWorklet(ctx), 'tail')
    motionOk = await step(trace, 'worklets', () => loadMotionWorklet(ctx), 'motion')
    await step(trace, 'worklets', () => loadAlignWorklet(ctx), 'align')
  })
  if (isMotionActive(req.dsp.spatial) && !motionOk) throw new Error('Motion の AudioWorklet を読み込めませんでした')
  return { ctx, hrtfLatency, motionOk, totalFrames }
}

/** レンダリングの追加の指定（フレーム内で使う） */
export interface RenderOptions {
  trace?: TraceFn
  /** 準備済みの文脈（prepareRender の結果）。省略時はここで準備する */
  prepared?: PreparedRender
  attempt?: number
  /**
   * true: 音源の PCM を AudioBuffer に写した後、要求の配列から外す（req.channels を空にする）。
   * 書き出し用フレームでは要求は使い捨てなので外してよい。呼び出し側の配列を使い続ける場合は false（既定）
   */
  releaseInput?: boolean
}

/** オフラインレンダリング（WAV にする前の浮動小数点の結果） */
export async function renderExportFloat(req: ExportRequest, onProgress: (p: ExportProgress) => void = () => {}, opts: RenderOptions = {}): Promise<RenderedExport> {
  const { trace = () => {}, attempt = 1 } = opts
  onProgress({ stage: 'preparing' })
  const sr = req.sampleRate
  const srcFrames = req.channels[0].length
  const sourceSeconds = srcFrames / sr
  const { ctx, hrtfLatency, motionOk, totalFrames } = opts.prepared ?? (await prepareRender({ ...req, frames: srcFrames }, trace, attempt))

  const { source, envelope } = await step(trace, 'chain', async () => {
    await stallIf(req, 'chain', attempt)
    const envelope = isMotionActive(req.dsp.spatial) ? computeEnvelope(req.channels, sr, req.dsp.spatial.motionSpeed / 100) : null
    const source = new AudioBuffer({ length: srcFrames, numberOfChannels: req.channels.length, sampleRate: sr })
    req.channels.forEach((d, c) => source.copyToChannel(d as Float32Array<ArrayBuffer>, c))
    // 写した後の音源の配列（3 分で 約 69 MB）を手放し、レンダリング中のピークを下げる（AudioBuffer に写したので不要）
    if (opts.releaseInput) req.channels.length = 0
    return { source, envelope }
  }, 'source')
  trace('chain', 'start', 'graph')
  const chain = createOutputChain(ctx, {
    dsp: req.dsp,
    bypass: false,
    useWorklet: true,
    bassScale: req.bassScale,
    bassDynamics: { ...req.bassDynamics, reportIntervalMs: 0 },
    spatial: {
      trimDb: req.spatialTrimDb,
      hrtfLatencySeconds: hrtfLatency,
      wideSideCapDb: req.wideSideCapDb,
      // 使うモードだけ作る（使わないチェーンは再生時も入力を切り離していて、出力に寄与しない）
      modes: req.dsp.spatial.mode === 'off' ? [] : [req.dsp.spatial.mode],
      reportIntervalMs: 0,
      motion: motionOk ? { transport: { playing: true, startedAt: 0, pausedAt: 0 }, envelope, reportIntervalMs: 0 } : undefined,
    },
  })
  const node = new AudioBufferSourceNode(ctx, { buffer: source })
  node.connect(chain.input)
  chain.output.connect(ctx.destination)
  const headTrimSeconds = chain.bass.latencySeconds * (req.dsp.bassEnabled ? 1 : 0) + chain.spatial.processingLatencySeconds()
  const head = Math.round(headTrimSeconds * sr)
  trace('chain', 'end', 'graph')

  // 進捗: 一定間隔で suspend し、そこまでレンダリングし終えた割合を通知する（推定ではなく実際に描画済みの時刻）。
  // 間隔は全体の 1/40、ただし音声 RENDER_PROGRESS_MAX_SECONDS 秒ごと以下（長い音源でも進捗が一定の間隔で届き、止まったことを検出できる）
  const quanta = (frames: number) => Math.max(RENDER_QUANTUM, Math.floor(frames / RENDER_QUANTUM) * RENDER_QUANTUM)
  const stepFrames = Math.min(Math.max(RENDER_QUANTUM, Math.ceil(totalFrames / PROGRESS_STEPS / RENDER_QUANTUM) * RENDER_QUANTUM), quanta(RENDER_PROGRESS_MAX_SECONDS * sr))
  for (let f = stepFrames; f < totalFrames; f += stepFrames) {
    void ctx.suspend(f / sr).then(() => {
      onProgress({ stage: 'rendering', rendered: f / totalFrames })
      void ctx.resume()
    })
  }
  node.start(0)
  await step(trace, 'render-start', () => stallIf(req, 'render-start', attempt))
  onProgress({ stage: 'rendering', rendered: 0 })
  const t0 = performance.now()
  trace('render', 'start')
  // 試験専用: レンダリングの段階で止める（進捗 0 のまま途絶えた状態）
  await stallIf(req, 'render', attempt)
  const out = await ctx.startRendering().catch((e: unknown) => {
    trace('render', 'fail', e instanceof Error ? e.name : 'error')
    throw e
  })
  const renderMs = performance.now() - t0
  trace('render', 'end')
  onProgress({ stage: 'rendering', rendered: 1 })

  // 先頭の処理の遅延を切り捨て、末尾は余韻がしきい値を下回った所まで（音源の長さより短くはしない）
  const L = out.getChannelData(0)
  const R = out.getChannelData(1)
  let last = head + srcFrames - 1
  for (let i = L.length - 1; i > last; i--) {
    if (Math.abs(L[i]) > TAIL_SILENCE_THRESHOLD || Math.abs(R[i]) > TAIL_SILENCE_THRESHOLD) {
      last = i
      break
    }
  }
  const end = Math.min(L.length, last + 1 + Math.round(TAIL_KEEP_AFTER_SECONDS * sr))
  const channels = [L.slice(head, end), R.slice(head, end)]
  // 末尾のフェード（しきい値以下の残りを 0 へ。余韻の本体は切らない）
  const fade = Math.min(Math.round(END_FADE_SECONDS * sr), channels[0].length)
  for (const ch of channels) {
    for (let i = 0; i < fade; i++) {
      const k = ch.length - fade + i
      ch[k] *= 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / fade)
    }
  }
  return { channels, sourceSeconds, tailSeconds: channels[0].length / sr - sourceSeconds, headTrimSeconds: head / sr, renderMs }
}

/** ENCODING の表示のために親へ譲る時間（ms）。出力の内容には影響しない */
const ENCODE_STAGE_YIELD_MS = 50

/** レンダリング → WAV */
export async function renderExport(req: ExportRequest, onProgress: (p: ExportProgress) => void = () => {}, opts: RenderOptions = {}): Promise<ExportResult> {
  const { trace = () => {}, attempt = 1 } = opts
  const r = await renderExportFloat(req, onProgress, opts)
  onProgress({ stage: 'encoding' })
  // 書き出し用の iframe は親と同じスレッドで動くため、すぐに同期のエンコードを始めると、親が ENCODING を
  // 描画する前に完了の通知まで届き、画面に ENCODING が出ない（Phase 08 の UI 試験で発見）。親が描画できるよう一度譲る
  await new Promise((r) => setTimeout(r, ENCODE_STAGE_YIELD_MS))
  const { blob, stats } = await step(trace, 'encode', async () => {
    await stallIf(req, 'encode', attempt)
    return req.encodeWav === false ? { blob: new Blob([]), stats: { clippedSamples: 0, dataBytes: 0 } } : encodeWav(r.channels, { sampleRate: req.sampleRate, bitDepth: req.bitDepth, dither: true, seed: req.ditherSeed })
  })
  return {
    blob,
    sampleRate: req.sampleRate,
    bitDepth: req.bitDepth,
    channels: 2,
    frames: r.channels[0].length,
    sourceSeconds: r.sourceSeconds,
    tailSeconds: r.tailSeconds,
    headTrimSeconds: r.headTrimSeconds,
    peakDb: linearToDb(samplePeak(r.channels)),
    loudnessLufs: integratedLoudness(r.channels, req.sampleRate),
    clippedSamples: stats.clippedSamples,
    renderMs: r.renderMs,
    float: req.returnFloat ? r.channels : undefined,
  }
}
