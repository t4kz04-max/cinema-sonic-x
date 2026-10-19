// 再生エンジンが受け取る DSP 設定一式（重低音 + 空間）。プリセット・CUSTOM・オフライン書き出しで共通の形。
// UI の状態（選択中のカード、CUSTOM 表示など）は含めない。

import { DEFAULT_BASS_PARAMS, type BassMode, type BassParams, type CompensationMode } from './bassSpec'
import type { MotionPreset } from './spatial/motion'
import { DEFAULT_SPATIAL_PARAMS, isMotionActive, isTailActive, type SpatialMode, type SpatialParams } from './spatial/spatialSpec'
import type { TailMode } from './spatial/tailImpulse'

export interface DspConfig {
  spatial: SpatialParams
  bass: BassParams
  /** 重低音エンジンを使うか（false なら重低音段は BYPASS） */
  bassEnabled: boolean
}

export const DEFAULT_DSP_CONFIG: DspConfig = { spatial: DEFAULT_SPATIAL_PARAMS, bass: DEFAULT_BASS_PARAMS, bassEnabled: false }

const SPATIAL_NUMBER_KEYS = ['intensity', 'roomSize', 'depth', 'wetDry', 'motionSpeed', 'motionDepth', 'centerLock', 'tailLength', 'tailIntensity'] as const
const SPATIAL_MODES: SpatialMode[] = ['off', 'wide', 'cinema', 'hall']
const MOTION_PRESETS: MotionPreset[] = ['cinematic', 'orbit', 'sweep', 'pulse']
const TAIL_MODES: TailMode[] = ['off', 'natural', 'distance', 'ripple']
const BASS_MODES: BassMode[] = ['normal', 'extreme']
const COMPENSATIONS: CompensationMode[] = ['mid-anchor', 'loudness-match']

/** 2 つの設定が DSP として同じか（全項目の比較。CUSTOM 判定に使う） */
export function dspEquals(a: DspConfig, b: DspConfig): boolean {
  if (a.bassEnabled !== b.bassEnabled) return false
  const sa = a.spatial as unknown as Record<string, unknown>
  const sb = b.spatial as unknown as Record<string, unknown>
  for (const k of Object.keys(DEFAULT_SPATIAL_PARAMS)) if (sa[k] !== sb[k]) return false
  const ba = a.bass as unknown as Record<string, unknown>
  const bb = b.bass as unknown as Record<string, unknown>
  for (const k of Object.keys(DEFAULT_BASS_PARAMS)) if (ba[k] !== bb[k]) return false
  return true
}

/** 設定のコピー（呼び出し側が変更してもプリセットの元データに影響しない） */
export function cloneDsp(c: DspConfig): DspConfig {
  return { spatial: { ...c.spatial }, bass: { ...c.bass }, bassEnabled: c.bassEnabled }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null)
const pct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(Math.max(v, 0), 100)) : null)

/**
 * 保存データなど外部から来た値を検証して DspConfig にする。型・範囲が 1 つでも合わなければ null
 * （不正な値で音声グラフを壊さないため。範囲外の数値は 0〜100 に丸める）
 */
export function parseDspConfig(v: unknown): DspConfig | null {
  if (!isObj(v) || !isObj(v.spatial) || !isObj(v.bass) || typeof v.bassEnabled !== 'boolean') return null
  const s = v.spatial
  const mode = pick(s.mode, SPATIAL_MODES)
  const motionPreset = pick(s.motionPreset, MOTION_PRESETS)
  const tailMode = pick(s.tailMode, TAIL_MODES)
  if (!mode || !motionPreset || !tailMode || typeof s.motionEnabled !== 'boolean' || typeof s.dynamicTail !== 'boolean') return null
  const spatial: SpatialParams = { ...DEFAULT_SPATIAL_PARAMS, mode, motionPreset, tailMode, motionEnabled: s.motionEnabled, dynamicTail: s.dynamicTail }
  for (const k of SPATIAL_NUMBER_KEYS) {
    const n = pct(s[k])
    if (n === null) return null
    spatial[k] = n
  }
  const b = v.bass
  const bassMode = pick(b.mode, BASS_MODES)
  const compensation = pick(b.compensation, COMPENSATIONS)
  const bass = pct(b.bass)
  const sub = pct(b.sub)
  if (!bassMode || !compensation || bass === null || sub === null) return null
  return { spatial, bass: { bass, sub, mode: bassMode, compensation }, bassEnabled: v.bassEnabled }
}

/**
 * 空間解析（ラウドネス合わせ）の結果を左右する項目だけを並べたキー。
 * 使われていない項目（WIDE の Motion 設定、Tail OFF の LENGTH など）は含めない（同じ音になる設定を同じキーにする）
 */
export function spatialPlanKey(p: SpatialParams): string {
  if (p.mode === 'off') return 'off'
  const parts: (string | number | boolean)[] = [p.mode, p.intensity, p.roomSize, p.depth, p.wetDry]
  if (isMotionActive(p)) parts.push('m', p.motionPreset, p.motionSpeed, p.motionDepth, p.centerLock)
  if (isTailActive(p)) parts.push('t', p.tailMode, p.tailLength, p.tailIntensity, p.dynamicTail)
  return parts.join('|')
}

/** 重低音の処理計画を左右する項目のキー */
export function bassPlanKey(p: BassParams): string {
  return [p.mode, p.bass, p.sub, p.compensation].join('|')
}
