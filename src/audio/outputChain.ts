// 再生・書き出しで共通の処理チェーン: 重低音グラフ → 空間グラフ（直列）。
// リアルタイム再生（AudioEngine）とオフラインレンダリング（自己診断・Phase 06 の書き出し）が同じ関数で作るため、
// 同じ DspConfig・処理計画なら同じ音になる。

import type { DynamicsSettings } from './dynamicsTypes'
import type { DspConfig } from './dspConfig'
import { createProcessingGraph, type ProcessingGraph } from './processingGraph'
import { createSpatialGraph, type SpatialGraph, type SpatialGraphOptions } from './spatial/spatialGraph'

export interface OutputChainOptions {
  dsp: DspConfig
  /** ORIGINAL（両段とも BYPASS） */
  bypass: boolean
  useWorklet: boolean
  /** 重低音: EQ の実効倍率（上限・安全制限）とダイナミクス（処理計画の値） */
  bassScale: number
  bassDynamics: DynamicsSettings
  /** 空間: パラメーター・BYPASS 以外のオプション（トリム・HRTF 遅延・Motion など） */
  spatial: Omit<SpatialGraphOptions, 'params' | 'bypass' | 'useWorklet' | 'alignBypass'>
  /** ORIGINAL/PROCESSED 比較の時刻合わせ（事前に loadAlignWorklet が必要） */
  alignBypass?: boolean
}

export interface OutputChain {
  input: AudioNode
  output: AudioNode
  bass: ProcessingGraph
  spatial: SpatialGraph
}

/** 重低音段を BYPASS するか（ORIGINAL、または重低音 OFF） */
export const bassBypassed = (dsp: DspConfig, bypass: boolean) => bypass || !dsp.bassEnabled
/** 空間段を BYPASS するか（ORIGINAL、または空間 OFF） */
export const spatialBypassed = (dsp: DspConfig, bypass: boolean) => bypass || dsp.spatial.mode === 'off'

export function createOutputChain(ctx: BaseAudioContext, o: OutputChainOptions): OutputChain {
  const bass = createProcessingGraph(ctx, {
    params: o.dsp.bass,
    scale: o.bassScale,
    bypass: bassBypassed(o.dsp, o.bypass),
    dynamics: o.bassDynamics,
    useWorklet: o.useWorklet,
    alignBypass: o.alignBypass,
  })
  const spatial = createSpatialGraph(ctx, {
    ...o.spatial,
    params: o.dsp.spatial,
    bypass: spatialBypassed(o.dsp, o.bypass),
    useWorklet: o.useWorklet,
    alignBypass: o.alignBypass,
  })
  bass.output.connect(spatial.input)
  return { input: bass.input, output: spatial.output, bass, spatial }
}

/**
 * 構築済みのチェーンに DSP 設定を適用する（再生エンジンの applyDsp と同じ順序: 重低音 → 空間 → BYPASS）。
 * 切替は平滑化する（モードのクロスフェード・IR のクロスフェード・EQ の平滑化）。オフラインでは suspend 中に呼ぶ
 */
export function applyDspToChain(chain: OutputChain, dsp: DspConfig, bypass: boolean, bassScale: number): void {
  chain.bass.setParams(dsp.bass, bassScale, true)
  chain.spatial.setParams(dsp.spatial, true)
  chain.bass.setBypass(bassBypassed(dsp, bypass), true)
  chain.spatial.setBypass(spatialBypassed(dsp, bypass), true)
}
