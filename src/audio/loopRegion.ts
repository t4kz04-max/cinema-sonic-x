// ループ区間の決定（純粋関数）。
// NORMAL LOOP: ファイル全体（0 〜 長さ）。
// SPATIAL LOOP: 音楽が鳴っている区間（先頭・末尾の無音を除く）。曲の最後の音が鳴り終わった時点で次のループの冒頭が始まり、
//               前回の余韻（残響）と次の冒頭が重なる。

export type LoopType = 'normal' | 'spatial'

export interface LoopRegion {
  start: number
  end: number
}

/** これより小さい振幅を無音とみなす（dBFS） */
export const SILENCE_THRESHOLD_DB = -60
/** 音の立ち上がりの直前に残す余裕（秒） */
const LEAD_MARGIN_SECONDS = 0.005
/** 最後の音の後に残す余裕（秒） */
const TRAIL_MARGIN_SECONDS = 0.02
/** 無音を除いた区間がこれより短ければファイル全体を使う（秒） */
const MIN_REGION_SECONDS = 1

/** 音楽が鳴っている区間（どのチャンネルかの振幅がしきい値を超える最初と最後のサンプル） */
export function musicRegion(channels: Float32Array[], sampleRate: number, thresholdDb = SILENCE_THRESHOLD_DB): LoopRegion | null {
  const th = Math.pow(10, thresholdDb / 20)
  const n = channels[0]?.length ?? 0
  let first = -1
  let last = -1
  for (let i = 0; i < n && first < 0; i++) for (const ch of channels) if (Math.abs(ch[i]) > th) first = i
  for (let i = n - 1; i >= 0 && last < 0; i--) for (const ch of channels) if (Math.abs(ch[i]) > th) last = i
  if (first < 0 || last <= first) return null
  // サンプル位置にそろえる（ループの周期がサンプル単位で一定になる）
  const startFrame = Math.max(0, first - Math.round(LEAD_MARGIN_SECONDS * sampleRate))
  const endFrame = Math.min(n, last + Math.round(TRAIL_MARGIN_SECONDS * sampleRate))
  const start = startFrame / sampleRate
  const end = endFrame / sampleRate
  return end - start >= MIN_REGION_SECONDS ? { start, end } : null
}

export function loopBounds(type: LoopType, region: LoopRegion | null, duration: number): LoopRegion {
  if (type === 'spatial' && region) return region
  return { start: 0, end: duration }
}
