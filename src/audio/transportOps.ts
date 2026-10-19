// 停止系の操作（STOP / PAUSE / CUT / SEEK / ループ境界）。AudioEngine とオフラインの自己診断で同じ関数を使い、
// 試聴時と検証時で同じ処理（同じフェード・同じ残響の消去）になるようにする。

import { linearRampAt, setValueAt } from './spatial/nodeUtils'

/** STOP: 直接音だけを短くフェードアウトする（クリック防止）。反射音・残響の余韻はそのまま鳴らす */
export const STOP_FADE_SECONDS = 0.012
/** PAUSE / CUT: 出力全体を短くフェードアウトしてから、残響を消す */
export const SILENCE_FADE_SECONDS = 0.02
/** 再生中の SEEK: 新旧の音源をクロスフェードする */
export const SEEK_FADE_SECONDS = 0.01
/** PAUSE / CUT 直後の再開は、反射音・STFT などの遅延線（最大約 0.25 秒）が空になるまで待つ */
export const FLUSH_WAIT_SECONDS = 0.25
/** NORMAL LOOP の境界で前回の残響を消すフェード */
export const NORMAL_LOOP_RESET_FADE_SECONDS = 0.08
/** 出力ゲートを戻すフェード */
const RESTORE_FADE_SECONDS = 0.005
/** 残響の消去時の古い残響のフェード（出力は既にゲートで 0） */
const SILENCED_RESET_FADE_SECONDS = 0.005

export interface ReverbResettable {
  resetReverb(at: number, fadeSeconds: number): void
}

/** 音源をフェードアウトして止める。止まったら onReleased（切り離し） */
export function fadeOutSource(ctx: BaseAudioContext, node: AudioBufferSourceNode, gain: GainNode, fade: number, onReleased: () => void): void {
  const t = ctx.currentTime
  linearRampAt(gain.gain, t, 0, t + fade)
  node.onended = onReleased
  try {
    node.stop(t + fade + 0.005)
  } catch {
    onReleased()
  }
}

/** 出力ゲートを短くフェードアウトし、その時点までの残響を消す（PAUSE / CUT）。出力が 0 になる時刻を返す */
export function silenceOutput(ctx: BaseAudioContext, gate: GainNode, graph: ReverbResettable | null): number {
  const t = ctx.currentTime
  const end = t + SILENCE_FADE_SECONDS
  linearRampAt(gate.gain, t, 0, end)
  graph?.resetReverb(end, SILENCED_RESET_FADE_SECONDS)
  return end
}

/** PAUSE / CUT で止めた出力を戻す。再生を始めてよい時刻（遅延線が空になった後）を返す */
export function restoreOutput(ctx: BaseAudioContext, gate: GainNode, silencedAt: number): number {
  const now = ctx.currentTime
  const when = Math.max(now, silencedAt + FLUSH_WAIT_SECONDS)
  setValueAt(gate.gain, now, 0)
  linearRampAt(gate.gain, when, 1, when + RESTORE_FADE_SECONDS)
  return when
}

/** ループ再生で、ctx 時刻 now の次の境界（ループ区間の終わりに達する ctx 時刻） */
export function nextLoopBoundary(now: number, startedAt: number, loop: { start: number; end: number }): number {
  const period = loop.end - loop.start
  const elapsed = now - startedAt
  const k = elapsed < loop.end ? 0 : Math.floor((elapsed - loop.end) / period) + 1
  return startedAt + loop.end + k * period
}
