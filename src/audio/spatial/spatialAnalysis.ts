import { countAnalysisRender } from '../analysisStats'
import { blockPeakPercentileDb, integratedLoudness, linearToDb, samplePeak } from '../loudness'
import type { BassParams } from '../bassSpec'
import type { DynamicsSettings } from '../dynamicsTypes'
import { createProcessingGraph, loadDynamicsWorklet } from '../processingGraph'
import { monoColorationDb, stereoColorationDb, stereoMetrics, type StereoMetrics } from '../stereoMetrics'
import type { Envelope } from './motion'
import { createSpatialGraph, loadMotionWorklet } from './spatialGraph'
import { dbToGain } from './nodeUtils'
import { loadTailWorklet } from './tailEngine'
import { isMotionActive, isTailActive, wideSideCapDb, type ActiveSpatialMode, type SpatialParams } from './spatialSpec'

/** 原音の中高域の幅から WIDE の Side ゲイン上限を決める */
export function wideCapFor(before: StereoMetrics | null): number {
  return wideSideCapDb(before ? Math.max(before.bandWidthDb.mid, before.bandWidthDb.high) : null)
}

const FULL_MAX_SECONDS = 15
const SEGMENT_SECONDS = 5
const SEGMENT_POSITIONS = [0.2, 0.5, 0.8]
const CEILING_DB = -1
/** ラウドネス合わせで持ち上げる場合に許すリミッターのピーク GR */
const LIMITER_BUDGET_DB = 3
const TRIM_MIN_DB = -12
const TRIM_MAX_DB = 6

/**
 * 解析用の抜粋（15 秒以下は全体、それ以上は 20/50/80% 位置の 5 秒×3）。
 * HRTF の処理は重く、ブラウザ内蔵の HRTF データはサンプルレートに依存するため、元のレートのまま処理する。
 */
export function buildSpatialExcerpt(buffer: AudioBuffer): AudioBuffer {
  if (buffer.duration <= FULL_MAX_SECONDS) return buffer
  const segLen = Math.floor(SEGMENT_SECONDS * buffer.sampleRate)
  const out = new AudioBuffer({ length: segLen * 3, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate })
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c)
    const dst = out.getChannelData(c)
    SEGMENT_POSITIONS.forEach((pos, i) => {
      const start = Math.min(Math.max(0, Math.floor(pos * buffer.length - segLen / 2)), buffer.length - segLen)
      dst.set(src.subarray(start, start + segLen), i * segLen)
    })
  }
  return out
}

async function render(
  excerpt: AudioBuffer,
  build?: (ctx: OfflineAudioContext, src: AudioNode) => Promise<AudioNode>,
  worklet = false,
): Promise<Float32Array[]> {
  countAnalysisRender(worklet)
  // 残響の余韻を含めるため 1 秒長くレンダリングする
  const ctx = new OfflineAudioContext(2, excerpt.length + excerpt.sampleRate, excerpt.sampleRate)
  const src = new AudioBufferSourceNode(ctx, { buffer: excerpt })
  const out = build ? await build(ctx, src) : src
  out.connect(ctx.destination)
  src.start()
  const r = await ctx.startRendering()
  return [r.getChannelData(0), r.getChannelData(1)]
}

/** 原音の指標（モノラル音源は L=R に展開して評価） */
export async function analyzeSpatialSource(excerpt: AudioBuffer): Promise<StereoMetrics> {
  return stereoMetrics(await render(excerpt), excerpt.sampleRate)
}

export interface SpatialPlan {
  params: SpatialParams
  trimDb: number
  /** リミッターの最大ゲインリダクション予測（dB） */
  predictedLimiterGrDb: number
  after: StereoMetrics | null
  /** モノラル和の音色変化（125 Hz〜8 kHz、レベル差を除いた最大偏差 dB） */
  monoColorationDb: number | null
  /** 左右それぞれの耳で聞く音色の変化（両チャンネルのパワー平均、同上） */
  stereoColorationDb: number | null
  /** WIDE の Side ゲイン上限（dB） */
  wideSideCapDb: number
}

export interface SpatialPlanOptions {
  useWorklet: boolean
  hrtfLatencySeconds: number
  /** PULSE 用の包絡（Motion ON 時） */
  envelope?: Envelope | null
  /**
   * 重低音段（ON のとき）。空間段の前に同じ処理を通してから測り、チェーン全体（重低音 + 空間）が原音と同じ
   * ラウドネスになるトリムを決める（重低音段がピークの予算のために全帯域を下げた分も、空間段のリミッター予算内で戻す）
   */
  bass?: { params: BassParams; scale: number; dynamics: DynamicsSettings }
}

async function renderSpatial(
  excerpt: AudioBuffer,
  params: SpatialParams & { mode: ActiveSpatialMode },
  trimDb: number,
  limiterEnabled: boolean,
  opts: SpatialPlanOptions,
  wideSideCapDb: number,
) {
  return render(excerpt, async (ctx, src) => {
    if (opts.useWorklet && !(await loadDynamicsWorklet(ctx))) throw new Error('解析用 AudioWorklet を読み込めませんでした')
    // 抜粋の先頭をメディア時刻 0 として Motion の動きを再現する。Motion ON でも反射音（モードのチェーン）は
    // 出力に含まれるため、モードのチェーンも作る（Phase 05 で修正: 以前は Tail OFF のとき作らず、反射音の分だけ音量を低く見積もっていた）
    const motion = isMotionActive(params) && (await loadMotionWorklet(ctx))
    const tail = isTailActive(params)
    if (tail && opts.useWorklet) await loadTailWorklet(ctx)
    const g = createSpatialGraph(ctx, {
      params,
      bypass: false,
      trimDb,
      useWorklet: opts.useWorklet,
      hrtfLatencySeconds: opts.hrtfLatencySeconds,
      modes: [params.mode],
      limiterEnabled,
      wideSideCapDb,
      motion: motion ? { envelope: opts.envelope ?? null } : undefined,
    })
    if (opts.bass) {
      const b = createProcessingGraph(ctx, { params: opts.bass.params, scale: opts.bass.scale, bypass: false, dynamics: { ...opts.bass.dynamics, reportIntervalMs: 0 }, useWorklet: opts.useWorklet })
      src.connect(b.input)
      b.output.connect(g.input)
    } else src.connect(g.input)
    return g.output
  }, opts.useWorklet)
}

/**
 * 実際の空間処理グラフで抜粋をレンダリングし、原音とラウドネスが一致するトリム量を決める。
 * （空間処理で「大きい方が良く聞こえる」錯覚を避けるため、A/B 比較は同じラウドネスで行う）
 * 持ち上げ方向はリミッター GR 予算 3 dB 以内、AudioWorklet が使えない環境では下げる方向のみ。
 *
 * 解析用の OfflineAudioContext を減らす（Chrome は AudioWorklet を読み込んだ文脈を解放しないため）:
 * - 1 回目（トリム 0・リミッターなし）は、Motion・Spatial Tail を使わない設定なら AudioWorklet なしで作る
 *   （出力段のワークレットはトリム 0・リミッター OFF では素通しなので、ゲイン 1 の経路と同じ値）
 * - 2 回目（トリム・リミッター込み）は、トリム後のピークが天井を超える（リミッターが働く）ときだけ実際にレンダリングし、
 *   超えない場合は 1 回目の出力にトリムのゲインを掛けたものを使う（リミッターが働かなければ同じ値）
 */
export async function planSpatial(excerpt: AudioBuffer, before: StereoMetrics, params: SpatialParams, opts: SpatialPlanOptions): Promise<SpatialPlan> {
  if (params.mode === 'off' || !Number.isFinite(before.loudnessLufs)) {
    return { params, trimDb: 0, predictedLimiterGrDb: 0, after: null, monoColorationDb: null, stereoColorationDb: null, wideSideCapDb: wideCapFor(before) }
  }
  const p = { ...params, mode: params.mode }
  const cap = wideCapFor(before)
  const needsWorklet = opts.useWorklet && (isMotionActive(p) || isTailActive(p) || !!opts.bass)
  const probe = await renderSpatial(excerpt, p, 0, false, { ...opts, useWorklet: needsWorklet }, cap)
  const probeLufs = integratedLoudness(probe, excerpt.sampleRate)
  const peak999 = blockPeakPercentileDb(probe, excerpt.sampleRate, 0.999)
  let trimDb = Math.min(Math.max(before.loudnessLufs - probeLufs, TRIM_MIN_DB), opts.useWorklet ? TRIM_MAX_DB : 0)
  if (peak999 + trimDb > CEILING_DB + LIMITER_BUDGET_DB) trimDb = Math.min(trimDb, CEILING_DB + LIMITER_BUDGET_DB - peak999)
  const g = dbToGain(trimDb)
  const limiterIdle = samplePeak(probe) * g <= dbToGain(CEILING_DB)
  const final = limiterIdle ? probe.map((x) => Float32Array.from(x, (v) => v * g)) : await renderSpatial(excerpt, p, trimDb, true, opts, cap)
  const after = stereoMetrics(final, excerpt.sampleRate)
  return {
    params,
    trimDb,
    predictedLimiterGrDb: Math.max(0, linearToDb(samplePeak(probe)) + trimDb - CEILING_DB),
    after,
    monoColorationDb: monoColorationDb(before, after),
    stereoColorationDb: stereoColorationDb(before, after),
    wideSideCapDb: cap,
  }
}
