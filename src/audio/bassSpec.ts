import type { CompensationMode } from './loudness'

/** 出力補正の方式（詳細は loudness.ts の computeTrim） */
export type { CompensationMode }

export type BassMode = 'normal' | 'extreme'

/** スライダー値（0〜100%）とモード */
export interface BassParams {
  bass: number
  sub: number
  mode: BassMode
  compensation: CompensationMode
}

export const DEFAULT_BASS_PARAMS: BassParams = { bass: 0, sub: 0, mode: 'normal', compensation: 'mid-anchor' }

export interface ModeSpec {
  label: string
  /** 4 次（Butterworth 2 段）サブソニック HPF */
  subsonicHz: number
  shelf: { frequency: number; maxGainDb: number }
  punch: { frequency: number; q: number; maxGainDb: number }
  sub: { frequency: number; q: number; maxGainDb: number }
  /** 低域 EQ 合成特性の構造上の上限（出力音量ではなく EQ 内部のゲイン） */
  eqCapDb: number
  /**
   * 低域コンプ: しきい値 = 原音の低域ピーク + offset。
   * ピークが予算に収まらない場合、offset を minThresholdOffsetDb まで下げて低域側で吸収する
   * （全帯域トリムで中高域を下げるより優先する）
   */
  bassComp: {
    thresholdOffsetDb: number
    minThresholdOffsetDb: number
    ratio: number
    kneeDb: number
    attackMs: number
    releaseMs: number
  }
  limiter: { ceilingDb: number; lookaheadMs: number; releaseMs: number }
  /**
   * 安全予算（mid-anchor 時）: リミッターのピーク GR 許容量 / 全帯域トリムの目標と下限（= 中高域を下げてよい量）/
   * ラウドネス増加の上限。トリムは目標値以内に収まるよう低域コンプを強め、
   * それでも下限を超える設定は EQ の実効値を自動で下げる（安全制限）
   */
  budget: { maxLimiterGrDb: number; trimTargetDb: number; trimFloorDb: number; maxLoudnessIncreaseLu: number }
}

/**
 * NORMAL : Phase 02 と同じ EQ 範囲（シェルフ +6 / 80 Hz +3 / 45 Hz +9）
 * EXTREME: シェルフ 100 Hz +10 / 80 Hz +8 / 50 Hz +9。合成で最大 +24 dB 程度（eqCapDb で制限）。
 *          ピーク予算を 40 Hz 付近に使うより、ヘッドホンや小型スピーカーでも再生できる 50〜100 Hz に
 *          配分した方が同じ天井で低音の存在感が大きい（楽曲相当信号の比較で決定）
 */
export const MODE_SPECS: Record<BassMode, ModeSpec> = {
  normal: {
    label: 'NORMAL',
    subsonicHz: 20,
    shelf: { frequency: 120, maxGainDb: 6 },
    punch: { frequency: 80, q: 1.0, maxGainDb: 3 },
    sub: { frequency: 45, q: 1.4, maxGainDb: 9 },
    eqCapDb: 18,
    bassComp: { thresholdOffsetDb: 3, minThresholdOffsetDb: -3, ratio: 3, kneeDb: 6, attackMs: 10, releaseMs: 180 },
    limiter: { ceilingDb: -1, lookaheadMs: 5, releaseMs: 120 },
    budget: { maxLimiterGrDb: 3, trimTargetDb: -1.5, trimFloorDb: -2, maxLoudnessIncreaseLu: 2 },
  },
  extreme: {
    label: 'EXTREME',
    subsonicHz: 25,
    shelf: { frequency: 100, maxGainDb: 10 },
    punch: { frequency: 80, q: 0.9, maxGainDb: 8 },
    sub: { frequency: 50, q: 1.2, maxGainDb: 9 },
    eqCapDb: 24,
    bassComp: { thresholdOffsetDb: 2, minThresholdOffsetDb: -9, ratio: 8, kneeDb: 6, attackMs: 5, releaseMs: 120 },
    limiter: { ceilingDb: -1, lookaheadMs: 5, releaseMs: 100 },
    budget: { maxLimiterGrDb: 8, trimTargetDb: -0.5, trimFloorDb: -3, maxLoudnessIncreaseLu: 4 },
  },
}

/** ローパス/ハイパスに分ける Linkwitz-Riley 4 次クロスオーバー周波数（両モード共通） */
export const CROSSOVER_HZ = 150

/** 解析前（原音の低域レベル未計測）に使う低域コンプのしきい値 */
export const DEFAULT_BASS_THRESHOLD_DB = -12

/** AudioWorklet が使えない環境（非セキュアコンテキスト等）の簡易ピーク対策 */
export const FALLBACK_COMPRESSOR_SPEC = {
  threshold: -3,
  knee: 3,
  ratio: 12,
  attack: 0.002,
  release: 0.12,
} as const

export interface EqGains {
  shelfDb: number
  punchDb: number
  subDb: number
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1)

/** スライダー値 → 各フィルターのゲイン。scale は安全制限・上限制限による実効倍率（0〜1） */
export function paramsToGains(p: Pick<BassParams, 'bass' | 'sub' | 'mode'>, scale = 1): EqGains {
  const spec = MODE_SPECS[p.mode]
  const b = clamp01(p.bass / 100) * scale
  const s = clamp01(p.sub / 100) * scale
  return {
    shelfDb: b * spec.shelf.maxGainDb,
    punchDb: b * spec.punch.maxGainDb,
    subDb: s * spec.sub.maxGainDb,
  }
}
