import { blockPeakPercentileDb, integratedLoudness, linearToDb, samplePeak } from '../loudness'
import { loadDynamicsWorklet } from '../processingGraph'
import { monoColorationDb, stereoColorationDb, stereoMetrics, type StereoMetrics } from '../stereoMetrics'
import type { Envelope } from './motion'
import { createSpatialGraph, loadMotionWorklet } from './spatialGraph'
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

async function render(excerpt: AudioBuffer, build?: (ctx: OfflineAudioContext, src: AudioNode) => Promise<AudioNode>): Promise<Float32Array[]> {
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
    // Motion ON なら Motion チェーンだけを作る（抜粋の先頭をメディア時刻 0 として動きを再現）。
    // Spatial Tail ON のときは残響が音量に効くため、モードのチェーン（反射音・Tail）も作る
    const motion = isMotionActive(params) && (await loadMotionWorklet(ctx))
    const tail = isTailActive(params)
    if (tail && opts.useWorklet) await loadTailWorklet(ctx)
    const g = createSpatialGraph(ctx, {
      params,
      bypass: false,
      trimDb,
      useWorklet: opts.useWorklet,
      hrtfLatencySeconds: opts.hrtfLatencySeconds,
      modes: motion && !tail ? [] : [params.mode],
      limiterEnabled,
      wideSideCapDb,
      motion: motion ? { envelope: opts.envelope ?? null } : undefined,
    })
    src.connect(g.input)
    return g.output
  })
}

/**
 * 実際の空間処理グラフで抜粋をレンダリングし、原音とラウドネスが一致するトリム量を決める。
 * （空間処理で「大きい方が良く聞こえる」錯覚を避けるため、A/B 比較は同じラウドネスで行う）
 * 持ち上げ方向はリミッター GR 予算 3 dB 以内、AudioWorklet が使えない環境では下げる方向のみ。
 */
export async function planSpatial(excerpt: AudioBuffer, before: StereoMetrics, params: SpatialParams, opts: SpatialPlanOptions): Promise<SpatialPlan> {
  if (params.mode === 'off' || !Number.isFinite(before.loudnessLufs)) {
    return { params, trimDb: 0, predictedLimiterGrDb: 0, after: null, monoColorationDb: null, stereoColorationDb: null, wideSideCapDb: wideCapFor(before) }
  }
  const p = { ...params, mode: params.mode }
  const cap = wideCapFor(before)
  const probe = await renderSpatial(excerpt, p, 0, false, opts, cap)
  const probeLufs = integratedLoudness(probe, excerpt.sampleRate)
  const peak999 = blockPeakPercentileDb(probe, excerpt.sampleRate, 0.999)
  let trimDb = Math.min(Math.max(before.loudnessLufs - probeLufs, TRIM_MIN_DB), opts.useWorklet ? TRIM_MAX_DB : 0)
  if (peak999 + trimDb > CEILING_DB + LIMITER_BUDGET_DB) trimDb = Math.min(trimDb, CEILING_DB + LIMITER_BUDGET_DB - peak999)
  const final = await renderSpatial(excerpt, p, trimDb, true, opts, cap)
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
