import { CROSSOVER_HZ, DEFAULT_BASS_THRESHOLD_DB, MODE_SPECS, type BassParams } from './bassSpec'
import { eqCapScale, maxEqGainDb } from './biquadMath'
import { countAnalysisRender } from './analysisStats'
import type { DynamicsSettings } from './dynamicsTypes'
import { blockPeakPercentileDb, computeTrim, integratedLoudness, linearToDb, samplePeak, type TrimResult } from './loudness'
import { createProcessingGraph, dynamicsSettingsFor, loadDynamicsWorklet } from './processingGraph'
import { averageSpectrum, type Spectrum } from './spectrum'

/** 解析用レンダリングのサンプルレート（低域評価に十分で、計算量を半分にできる） */
export const ANALYSIS_SAMPLE_RATE = 24000
const ANALYSIS_FFT_SIZE = 16384 // 24 kHz で 1.46 Hz 分解能
const FULL_ANALYSIS_MAX_SECONDS = 30
const SEGMENT_SECONDS = 10
const SEGMENT_POSITIONS = [0.2, 0.5, 0.8]
/** 低域コンプしきい値の二分探索回数 */
const THRESHOLD_SEARCH_STEPS = 3
/** 安全制限（EQ 実効値の縮小）の最大反復回数 */
const SAFETY_ITERATIONS = 3
/** 予算超過をこの値まで許容する（計測の揺らぎ対策） */
const UNMET_TOLERANCE_DB = 0.5

/**
 * 解析用の抜粋。30 秒以下なら全体、それ以上なら 20% / 50% / 80% 位置の 10 秒ずつを連結する。
 * スライダー操作のたびに曲全体をレンダリングすると重いため。
 */
export function buildAnalysisExcerpt(buffer: AudioBuffer): AudioBuffer {
  if (buffer.duration <= FULL_ANALYSIS_MAX_SECONDS) return buffer
  const segLen = Math.floor(SEGMENT_SECONDS * buffer.sampleRate)
  const out = new AudioBuffer({
    length: segLen * SEGMENT_POSITIONS.length,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  })
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

async function renderExcerpt(
  excerpt: AudioBuffer,
  build: (ctx: OfflineAudioContext, src: AudioBufferSourceNode) => Promise<AudioNode> | AudioNode,
  worklet = false,
): Promise<Float32Array[]> {
  countAnalysisRender(worklet)
  const length = Math.max(1, Math.ceil(excerpt.duration * ANALYSIS_SAMPLE_RATE))
  const ctx = new OfflineAudioContext(Math.min(excerpt.numberOfChannels, 2), length, ANALYSIS_SAMPLE_RATE)
  const src = new AudioBufferSourceNode(ctx, { buffer: excerpt })
  const out = await build(ctx, src)
  out.connect(ctx.destination)
  src.start()
  const rendered = await ctx.startRendering()
  return Array.from({ length: rendered.numberOfChannels }, (_, c) => rendered.getChannelData(c))
}

export interface SourceAnalysis {
  loudnessLufs: number
  peakDb: number
  /** クロスオーバー以下の低域の 99 パーセンタイル・ブロックピーク（dBFS） */
  lowPeakDb: number
  spectrum: Spectrum
  silent: boolean
}

export async function analyzeSource(excerpt: AudioBuffer): Promise<SourceAnalysis> {
  const original = await renderExcerpt(excerpt, (_, src) => src)
  const low = await renderExcerpt(excerpt, (ctx, src) => {
    const q = 20 * Math.log10(Math.SQRT1_2)
    const lp1 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: CROSSOVER_HZ, Q: q })
    const lp2 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: CROSSOVER_HZ, Q: q })
    return src.connect(lp1).connect(lp2)
  })
  const loudnessLufs = integratedLoudness(original, ANALYSIS_SAMPLE_RATE)
  return {
    loudnessLufs,
    peakDb: linearToDb(samplePeak(original)),
    lowPeakDb: blockPeakPercentileDb(low, ANALYSIS_SAMPLE_RATE),
    spectrum: averageSpectrum(original, ANALYSIS_SAMPLE_RATE, ANALYSIS_FFT_SIZE),
    silent: !Number.isFinite(loudnessLufs),
  }
}

/**
 * 原音の低域ピークから低域コンプのしきい値を決める（ブーストで原音の低域ピークを超えた分を圧縮する）。
 * offset 省略時はモードの既定値。
 */
export function bassThresholdFor(params: BassParams, source: SourceAnalysis | null, offsetDb?: number): number {
  if (!source || !Number.isFinite(source.lowPeakDb)) return DEFAULT_BASS_THRESHOLD_DB
  return source.lowPeakDb + (offsetDb ?? MODE_SPECS[params.mode].bassComp.thresholdOffsetDb)
}

export interface PlanResult {
  /** 最終出力（トリム・リミッター込み）の統合ラウドネス変化 */
  loudnessDeltaLu: number
  outputPeakDb: number
  preLimiterPeakDb: number
  /** リミッターの最大ゲインリダクション予測（dB） */
  predictedLimiterGrDb: number
  spectrum: Spectrum
}

export interface ProcessingPlan {
  params: BassParams
  /** EQ 合成特性の上限（eqCapDb）による倍率 */
  capScale: number
  /** 安全予算を満たすための追加倍率 */
  safetyScale: number
  /** 採用した低域コンプしきい値の offset（原音の低域ピーク比） */
  thresholdOffsetDb: number
  /** EQ に実際に掛ける倍率 = capScale × safetyScale */
  scale: number
  trim: TrimResult
  dynamics: DynamicsSettings
  result: PlanResult | null
}

export interface PlanOptions {
  useWorklet: boolean
  /** フォールバック時のコンプ・メイクアップ打消し（linear） */
  makeupCancel: number
}

async function renderProcessed(
  excerpt: AudioBuffer,
  params: BassParams,
  scale: number,
  dynamics: DynamicsSettings,
  opts: PlanOptions,
): Promise<Float32Array[]> {
  return renderExcerpt(excerpt, async (ctx, src) => {
    if (opts.useWorklet && !(await loadDynamicsWorklet(ctx))) throw new Error('解析用 AudioWorklet を読み込めませんでした')
    const graph = createProcessingGraph(ctx, { params, scale, bypass: false, dynamics, useWorklet: opts.useWorklet })
    graph.setMakeupCancel(opts.makeupCancel, false)
    src.connect(graph.input)
    return graph.output
  }, opts.useWorklet)
}

/**
 * スライダー設定に対して、実際の処理グラフを解析用抜粋でレンダリングし、
 * 全帯域トリム量・安全制限・処理後スペクトルを決める。リアルタイム再生も同じ値を使う。
 */
export async function planProcessing(
  excerpt: AudioBuffer,
  source: SourceAnalysis,
  params: BassParams,
  opts: PlanOptions,
): Promise<ProcessingPlan> {
  const spec = MODE_SPECS[params.mode]
  const capScale = eqCapScale(params)
  const threshold = bassThresholdFor(params, source)
  if (source.silent) {
    return {
      params,
      capScale,
      safetyScale: 1,
      thresholdOffsetDb: spec.bassComp.thresholdOffsetDb,
      scale: capScale,
      trim: { trimDb: 0, unmetDb: 0, reason: 'none' },
      dynamics: dynamicsSettingsFor(params.mode, threshold, 0),
      result: null,
    }
  }

  const probe = async (offsetDb: number, safetyScale: number) => {
    const scale = capScale * safetyScale
    const out = await renderProcessed(
      excerpt,
      params,
      scale,
      dynamicsSettingsFor(params.mode, bassThresholdFor(params, source, offsetDb), 0, { limiterEnabled: false }),
      opts,
    )
    const preLimiterPeakDb = linearToDb(samplePeak(out))
    const trim = computeTrim({
      compensation: params.compensation,
      loudnessDeltaLu: integratedLoudness(out, ANALYSIS_SAMPLE_RATE) - source.loudnessLufs,
      // 単発の 1 サンプルで全体トリムが決まらないよう、20 ms ブロックピークの 99.9 パーセンタイルで予算を判定する
      // （それを超える稀なピークもリミッターが天井を守る）
      preLimiterPeakDb: blockPeakPercentileDb(out, ANALYSIS_SAMPLE_RATE, 0.999),
      ceilingDb: spec.limiter.ceilingDb,
      maxLimiterGrDb: spec.budget.maxLimiterGrDb,
      trimFloorDb: spec.budget.trimFloorDb,
      maxLoudnessIncreaseLu: spec.budget.maxLoudnessIncreaseLu,
    })
    return { offsetDb, safetyScale, scale, preLimiterPeakDb, trim }
  }
  /** 下限内に収まるか */
  const ok = (r: { trim: TrimResult }) => r.trim.unmetDb <= UNMET_TOLERANCE_DB
  /** 中高域をほぼ下げずに済む（トリムが目標値以内）か */
  const withinTarget = (r: { trim: TrimResult }) => ok(r) && r.trim.trimDb >= spec.budget.trimTargetDb - 0.05

  // 1) 既定の低域コンプ設定でトリムが目標値以内ならそのまま
  let chosen = await probe(spec.bassComp.thresholdOffsetDb, 1)
  if (!withinTarget(chosen) && params.compensation === 'mid-anchor') {
    // 2) 全帯域トリムで中高域を下げる前に、低域コンプのしきい値を下げて低域側でピークを吸収する
    const strongest = await probe(spec.bassComp.minThresholdOffsetDb, 1)
    if (withinTarget(strongest)) {
      // 目標を満たす中で最も弱い低域コンプ（＝低域のダイナミクスを最も残す設定）を二分探索
      let hi = spec.bassComp.thresholdOffsetDb
      let lo = spec.bassComp.minThresholdOffsetDb
      chosen = strongest
      for (let i = 0; i < THRESHOLD_SEARCH_STEPS; i++) {
        const mid = (hi + lo) / 2
        const r = await probe(mid, 1)
        if (withinTarget(r)) {
          chosen = r
          lo = mid
        } else {
          hi = mid
        }
      }
    } else if (ok(strongest)) {
      // 最大限の低域コンプでも目標に届かない: 下限内のトリムを併用
      chosen = strongest
    } else {
      // 3) それでも収まらない設定は EQ の実効値を下げる（安全制限）
      chosen = strongest
      for (let i = 0; i < SAFETY_ITERATIONS && !ok(chosen); i++) {
        const maxGain = maxEqGainDb(params, chosen.scale)
        if (maxGain < 0.5) break
        chosen = await probe(chosen.offsetDb, chosen.safetyScale * Math.max(0.25, 1 - chosen.trim.unmetDb / maxGain))
      }
    }
  }

  const { safetyScale, scale, trim, preLimiterPeakDb, offsetDb } = chosen
  const dynamics = dynamicsSettingsFor(params.mode, bassThresholdFor(params, source, offsetDb), trim.trimDb)
  const final = await renderProcessed(excerpt, params, scale, dynamics, opts)
  return {
    params,
    capScale,
    safetyScale,
    thresholdOffsetDb: offsetDb,
    scale,
    trim,
    dynamics,
    result: {
      loudnessDeltaLu: integratedLoudness(final, ANALYSIS_SAMPLE_RATE) - source.loudnessLufs,
      outputPeakDb: linearToDb(samplePeak(final)),
      preLimiterPeakDb,
      predictedLimiterGrDb: Math.max(0, preLimiterPeakDb + trim.trimDb - spec.limiter.ceilingDb),
      spectrum: averageSpectrum(final, ANALYSIS_SAMPLE_RATE, ANALYSIS_FFT_SIZE),
    },
  }
}
