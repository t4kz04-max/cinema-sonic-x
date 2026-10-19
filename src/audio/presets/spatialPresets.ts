// Phase 05: 完成版プリセット（CINEMA 3D / LIVE ARENA / 360° MOTION / IMMERSIVE X）。
// プリセットは「DSP 設定の型付きオブジェクト」で、presetToDsp で再生エンジンが受け取る DspConfig にそのまま写す
// （項目の名前と値が一対一。書き出し（OfflineAudioContext）でも同じ DspConfig からグラフを作る）。
// 元データは凍結（Object.freeze）して直接書き換えられないようにし、適用時は必ずコピーを渡す。

import { MODE_SPECS, paramsToGains, type BassMode, type CompensationMode } from '../bassSpec'
import { cloneDsp, dspEquals, type DspConfig } from '../dspConfig'
import { motionPeriodSeconds, type MotionPreset } from '../spatial/motion'
import {
  cinemaSettings,
  DEFAULT_SPATIAL_PARAMS,
  DYNAMIC_TAIL_DUCK_DB,
  hallSettings,
  isMotionActive,
  isTailActive,
  MOTION_PRESET_DOCS,
  TAIL_MODE_DOCS,
  tailSettings,
  type ActiveSpatialMode,
} from '../spatial/spatialSpec'
import type { TailMode } from '../spatial/tailImpulse'

export type PresetId = 'cinema-3d' | 'live-arena' | 'motion-360' | 'immersive-x'

/** 部屋（空間モードと 4 つの基本パラメーター、0〜100） */
export interface PresetRoom {
  mode: ActiveSpatialMode
  intensity: number
  roomSize: number
  depth: number
  wetDry: number
}

export interface PresetMotion {
  enabled: boolean
  preset: MotionPreset
  speed: number
  depth: number
  centerLock: number
}

export interface PresetTail {
  mode: TailMode
  length: number
  intensity: number
  dynamic: boolean
}

export interface PresetBass {
  enabled: boolean
  mode: BassMode
  bass: number
  sub: number
  compensation: CompensationMode
}

export interface SpatialPreset {
  id: PresetId
  /** 設定値を変えたら上げる（保存した CUSTOM のベースが古い版か判定するため） */
  version: number
  label: string
  /** カードに出す短い説明 */
  summary: string
  /** 音響上の目的（詳細） */
  description: string
  /** 主な音響効果（カードの箇条書き） */
  effects: readonly string[]
  /** 既知の制限 */
  caveats: readonly string[]
  /** ヘッドホン前提か（HRTF を使う） */
  headphones: boolean
  dsp: {
    room: PresetRoom
    motion: PresetMotion
    tail: PresetTail
    bass: PresetBass
  }
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v)
    Object.freeze(o)
  }
  return o
}

/**
 * 設定値の考え方（docs/SPATIAL.md の Phase 05 に詳細）:
 * - どのプリセットも最大値は使わない（INTENSITY・DEPTH・Motion DEPTH・Tail LENGTH/INTENSITY は 70 以下）。
 * - 重低音は控えめ（NORMAL・BASS 20〜35 / SUB 20〜30）。中高域を原音レベルに保つ mid-anchor 補正で、
 *   ラウドネスの増加を小さく抑える（A/B 比較を音量差で有利にしない）。
 * - Phase 04 の既知 FAIL の組み合わせ（HALL × SWEEP × RIPPLE + DYNAMIC TAIL）は使わない。原因は HALL + Motion で
 *   ピーク対ラウドネス比が約 4 dB 上がること（Phase 05 で測定）なので、HALL + Motion の組み合わせ自体を使わない。
 */
export const SPATIAL_PRESETS: readonly SpatialPreset[] = deepFreeze([
  {
    id: 'cinema-3d',
    version: 1,
    label: 'CINEMA 3D',
    summary: '映画館の前方の大きなスクリーン・スピーカーから鳴る空間',
    description:
      '前方の仮想スピーカー（HRTF）と映画館の初期反射で前方定位をつくり、中央の音（台詞・ボーカル）は CENTER LOCK で正面に固定する。後期残響は既存 HALL と同じ NATURAL TAIL を短めに。Motion は CINEMATIC をごく弱く使い、周辺の音がわずかに漂うだけで回転はしない。',
    effects: ['前方定位（HRTF 仮想スピーカー）', 'センター固定（CENTER LOCK 90%）', '自然な初期反射 + NATURAL TAIL（短め）', '控えめな CINEMATIC MOTION（振れ幅 30%・遅い周期）'],
    caveats: ['ヘッドホン専用（HRTF の前方定位には個人差があり、頭の中・後方に聞こえる場合がある）'],
    headphones: true,
    dsp: {
      room: { mode: 'cinema', intensity: 55, roomSize: 45, depth: 65, wetDry: 100 },
      motion: { enabled: true, preset: 'cinematic', speed: 20, depth: 30, centerLock: 90 },
      tail: { mode: 'natural', length: 45, intensity: 45, dynamic: false },
      bass: { enabled: true, mode: 'normal', bass: 20, sub: 20, compensation: 'mid-anchor' },
    },
  },
  {
    id: 'live-arena',
    version: 1,
    label: 'LIVE ARENA',
    summary: '大きなライブ会場で、響きに包まれて聴く',
    description:
      '既存 HALL の残響（NATURAL TAIL = HALL と同じ IR）を長めにして会場の大きさを出し、初期反射で周囲を包む。演奏が密な間は DYNAMIC TAIL が残響を下げて直接音を明瞭に保ち、音の切れ目で響きを戻す。HRTF を使わないためスピーカーでも聴ける。',
    effects: ['広い音場（HALL 初期反射 8 本）', '長めの自然な余韻（NATURAL TAIL・LENGTH 65）', `DYNAMIC TAIL（密な所で残響を最大 ${DYNAMIC_TAIL_DUCK_DB} dB 下げる）`, 'HRTF なし（スピーカー可）'],
    caveats: ['Motion を使わないため、音の移動はない', '残響が長いため、テンポの速い曲では響きが重なりやすい（DYNAMIC TAIL で軽減）'],
    headphones: false,
    dsp: {
      room: { mode: 'hall', intensity: 60, roomSize: 70, depth: 55, wetDry: 100 },
      motion: { enabled: false, preset: 'cinematic', speed: 40, depth: 60, centerLock: 80 },
      tail: { mode: 'natural', length: 65, intensity: 50, dynamic: true },
      bass: { enabled: true, mode: 'normal', bass: 35, sub: 30, compensation: 'mid-anchor' },
    },
  },
  {
    id: 'motion-360',
    version: 1,
    label: '360° MOTION',
    summary: '音の方向と距離の変化がはっきり分かる立体音響',
    description:
      'ORBIT で空間成分（AMBIENCE）が聴取者の周囲を回り、LEFT / RIGHT の音がそれぞれの側で前方〜後方へ独立に回り込む。距離も変化させ、余韻は DISTANCE TAIL で遠ざかりながら消える。中央の音と 200 Hz 以下（BED）は固定し、ボーカルと低域は動かさない。曲全体を一括で回転・パンする処理ではない。',
    effects: ['ORBIT（空間成分が周囲を一周）', 'LEFT / RIGHT が独立して前後に移動', '距離の変化（距離ゲイン・空気吸収・遅延）+ DISTANCE TAIL', 'センター・低域（BED）は固定'],
    caveats: [
      'ヘッドホン専用。前後の判別は HRTF の個人差が大きい',
      'Motion エンジンは 1 度に 1 つの動き（ORBIT）。SWEEP（左右の横断）は詳細設定で切り替えられる',
    ],
    headphones: true,
    dsp: {
      room: { mode: 'cinema', intensity: 60, roomSize: 50, depth: 60, wetDry: 100 },
      motion: { enabled: true, preset: 'orbit', speed: 45, depth: 70, centerLock: 90 },
      tail: { mode: 'distance', length: 45, intensity: 45, dynamic: false },
      bass: { enabled: true, mode: 'normal', bass: 20, sub: 20, compensation: 'mid-anchor' },
    },
  },
  {
    id: 'immersive-x',
    version: 1,
    label: 'IMMERSIVE X',
    summary: '空間処理を統合したフラッグシップ',
    description:
      'Motion の 12 方向 HRTF とレイヤー分解（Independent Spatial Layers）で直接音を立体的に配置し、映画館の初期反射（床・天井・側壁・後壁、HRTF）が音源の位置に追従する。後期残響は RIPPLE TAIL で中央から外へ広がり、DYNAMIC TAIL が密な所で残響を下げる。各パラメーターは中程度に抑え、どれも最大にはしない。',
    effects: ['HRTF + 独立した空間レイヤー（CINEMATIC MOTION）', '初期反射（HRTF）が音源の位置に追従', 'RIPPLE TAIL（中央 → 外へ広がる余韻）+ DYNAMIC TAIL', '奥行き（DEPTH 60）と広がり'],
    caveats: [
      'ヘッドホン専用',
      'RIPPLE は自然な響きではなく演出的な余韻',
      'HALL + Motion は使わない（ピーク対ラウドネス比が原音より約 4 dB 上がり、ピーク制限の範囲では原音のラウドネスにそろえられないため。docs/SPATIAL.md の Phase 05 参照）',
    ],
    headphones: true,
    dsp: {
      room: { mode: 'cinema', intensity: 60, roomSize: 60, depth: 60, wetDry: 100 },
      motion: { enabled: true, preset: 'cinematic', speed: 40, depth: 55, centerLock: 85 },
      tail: { mode: 'ripple', length: 55, intensity: 45, dynamic: true },
      bass: { enabled: true, mode: 'normal', bass: 25, sub: 20, compensation: 'mid-anchor' },
    },
  },
])

export function getPreset(id: PresetId): SpatialPreset {
  const p = SPATIAL_PRESETS.find((x) => x.id === id)
  if (!p) throw new Error(`unknown preset: ${id}`)
  return p
}

export const isPresetId = (v: unknown): v is PresetId => SPATIAL_PRESETS.some((p) => p.id === v)

/** プリセット → 再生エンジン・書き出しが受け取る DSP 設定（新しいオブジェクト。項目は一対一の写し） */
export function presetToDsp(p: SpatialPreset): DspConfig {
  const { room, motion, tail, bass } = p.dsp
  return cloneDsp({
    spatial: {
      ...DEFAULT_SPATIAL_PARAMS,
      mode: room.mode,
      intensity: room.intensity,
      roomSize: room.roomSize,
      depth: room.depth,
      wetDry: room.wetDry,
      motionEnabled: motion.enabled,
      motionPreset: motion.preset,
      motionSpeed: motion.speed,
      motionDepth: motion.depth,
      centerLock: motion.centerLock,
      tailMode: tail.mode,
      tailLength: tail.length,
      tailIntensity: tail.intensity,
      dynamicTail: tail.dynamic,
    },
    bass: { bass: bass.bass, sub: bass.sub, mode: bass.mode, compensation: bass.compensation },
    bassEnabled: bass.enabled,
  })
}

/** 現在の設定に一致するプリセット（なければ null） */
export function matchPreset(c: DspConfig): PresetId | null {
  return SPATIAL_PRESETS.find((p) => dspEquals(presetToDsp(p), c))?.id ?? null
}

/**
 * DSP 設定から実際に使われる値（秒・dB・角度）を計算する。UI のカードとドキュメントに表示する
 * （spatialSpec / bassSpec の同じ関数を使うので、表示と処理が食い違わない）
 */
export function derivedDspValues(c: DspConfig): [string, string][] {
  const p = c.spatial
  const rows: [string, string][] = []
  const f1 = (v: number) => v.toFixed(1)
  const sgn = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
  if (p.mode === 'cinema') {
    const s = cinemaSettings(p)
    rows.push(['仮想スピーカー', `±${s.speakerAngleDeg.toFixed(0)}°・${f1(s.distanceM)} m`], ['初期反射', `レベル ${s.reflectionLevel.toFixed(2)}・遅延 ×${s.roomScale.toFixed(2)}`])
  } else if (p.mode === 'hall') {
    const h = hallSettings(p)
    rows.push(['初期反射', `レベル ${h.erGain.toFixed(2)}・遅延 ×${h.erScale.toFixed(2)}`], ['直接音', `${sgn(h.directGainDb)} dB`])
  }
  if (isTailActive(p)) {
    const t = tailSettings(p)
    rows.push(['後期残響', `${TAIL_MODE_DOCS[t.mode].label}・RT60 ${f1(t.rt60)} 秒・${sgn(t.gainDb)} dB・プリディレイ ${t.preDelayMs.toFixed(0)} ms${p.dynamicTail ? `・DYNAMIC（最大 −${DYNAMIC_TAIL_DUCK_DB} dB）` : ''}`])
  } else if (p.mode === 'hall') {
    const h = hallSettings(p)
    rows.push(['後期残響', `HALL・RT60 ${f1(h.rt60)} 秒・${sgn(h.lateGainDb)} dB`])
  }
  if (isMotionActive(p)) {
    const period = p.motionPreset === 'pulse' ? '包絡に追従' : `周期 ${f1(motionPeriodSeconds(p.motionSpeed / 100))} 秒`
    rows.push(['Motion', `${MOTION_PRESET_DOCS[p.motionPreset].label}・${period}・DEPTH ${p.motionDepth}%・CENTER LOCK ${p.centerLock}%`])
  } else {
    rows.push(['Motion', 'OFF'])
  }
  if (c.bassEnabled) {
    const g = paramsToGains(c.bass)
    rows.push(['重低音', `${MODE_SPECS[c.bass.mode].label}・シェルフ ${sgn(g.shelfDb)} / 80 Hz ${sgn(g.punchDb)} / サブ ${sgn(g.subDb)} dB（上限値。安全制限で下がる場合あり）`])
  } else {
    rows.push(['重低音', 'OFF'])
  }
  return rows
}
