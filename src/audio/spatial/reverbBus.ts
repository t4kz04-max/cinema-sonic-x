// 畳み込み残響のバス: IR の切替（クロスフェード）と、残響の消去（PAUSE・CUT・NORMAL LOOP の境界）を受け持つ。
//
//   input ─→ inGate ─→ ConvolverNode ─→ outGain ─→ output   （使用中は 1 組。どちらのゲインも 1 = 原音と同じ値）
//
// ConvolverNode には内部状態を消す API がないため、消去は「入力を閉じた古い組を短くフェードアウト」
// ＋「指定時刻から入力を開く別の組」に切り替えて行う（どちらもサンプル単位の AudioParam 予約で正確）。
// 組は最大 MAX_SLOTS 個を使い回す。入力を閉じてから IR の長さ以上たった組は内部状態がすべて 0 なので、
// そのまま次の消去に使える（ループ境界のたびに ConvolverNode を作ると、カーネルのメモリが GC されるまで
// 積み上がるため。実時間で 1 回あたり十数 MB）。IR を変えたときだけ新しい組を作り、古い IR の組は破棄する。

import { linearRampAt, setValueAt } from './nodeUtils'

interface Slot {
  inGate: GainNode
  conv: ConvolverNode
  out: GainNode
  buffer: AudioBuffer
  /** 入力を閉じ終えた ctx 時刻（使用中は Infinity） */
  idleFrom: number
}

/**
 * 消去時の入力の受け渡し（秒）。古い組の入力を下げながら新しい組の入力を上げる（和は常に 1）。
 * 入力を瞬時に切り替えると、連続した音の残響が途中から立ち上がり直して広帯域の「チッ」というノイズになるため
 */
const HANDOFF_SECONDS = 0.01
/** 同時に持つ組の上限 */
const MAX_SLOTS = 3
/** 再利用の余裕（秒）。入力を閉じてから IR の長さ + これだけたった組を「空」とみなす */
const CLEAN_MARGIN_SECONDS = 0.05
/** 切り離しの余裕（秒）。予約したフェードが終わってから切り離す */
const RELEASE_MARGIN_SECONDS = 0.15

export class ReverbBus {
  private readonly ctx: BaseAudioContext
  private readonly input: AudioNode
  private readonly output: AudioNode
  private readonly channels: number
  private active: Slot | null = null
  private buffer: AudioBuffer | null = null
  /** 現在の IR の組（使用中を含む） */
  private readonly pool: Slot[] = []
  /** 古い IR の組（フェード後に切り離す）と、その予約が終わる時刻 */
  private readonly retiring = new Map<Slot, number>()

  constructor(ctx: BaseAudioContext, input: AudioNode, output: AudioNode, channels: 1 | 2) {
    this.ctx = ctx
    this.input = input
    this.output = output
    this.channels = channels
  }

  /** 現在の IR */
  get currentBuffer(): AudioBuffer | null {
    return this.buffer
  }

  /** 同時に存在する組の数（テスト用: ループを繰り返してもノードが増え続けないことの確認） */
  get slotCount(): number {
    return this.pool.length + this.retiring.size
  }

  private makeSlot(buffer: AudioBuffer, inGain: number, outGain: number): Slot {
    const ctx = this.ctx
    const opt = { channelCount: this.channels, channelCountMode: 'explicit', channelInterpretation: 'speakers' } as const
    const inGate = new GainNode(ctx, { ...opt, gain: inGain })
    const conv = new ConvolverNode(ctx, { disableNormalization: true })
    conv.buffer = buffer
    const out = new GainNode(ctx, { gain: outGain, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' })
    this.input.connect(inGate).connect(conv).connect(out).connect(this.output)
    return { inGate, conv, out, buffer, idleFrom: Infinity }
  }

  private release(slot: Slot): void {
    if (!this.retiring.has(slot)) return
    this.retiring.delete(slot)
    this.input.disconnect(slot.inGate)
    slot.inGate.disconnect()
    slot.conv.disconnect()
    slot.out.disconnect()
  }

  /** 予約したフェードが終わった古い IR の組を切り離す（オフラインでは壁時計のタイマーが進まないため、次の操作時にも掃除する） */
  private sweep(): void {
    for (const [slot, end] of this.retiring) if (this.ctx.currentTime > end + RELEASE_MARGIN_SECONDS) this.release(slot)
  }

  private retire(slot: Slot, endTime: number): void {
    this.retiring.set(slot, endTime)
    if (typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext) return
    const wait = Math.max(0, endTime - this.ctx.currentTime + RELEASE_MARGIN_SECONDS)
    setTimeout(() => this.release(slot), wait * 1000)
  }

  /** IR を設定する。fadeSeconds > 0 なら新旧をクロスフェード（入力は両方に入れたまま）。古い IR の組はすべて破棄する */
  setBuffer(buffer: AudioBuffer, fadeSeconds: number): void {
    this.sweep()
    this.buffer = buffer
    const old = this.active
    const stale = this.pool.splice(0)
    const t = this.ctx.currentTime
    const smooth = !!old && fadeSeconds > 0
    // 新しい組の入力も HANDOFF_SECONDS で立ち上げる（入力を瞬時に入れると、持続音が途中から
    // 立ち上がり直した形になり、新しい残響の頭に広帯域の「チッ」が出る。Phase 05 のプリセット切替で実測）
    const next = this.makeSlot(buffer, smooth ? 0 : 1, smooth ? 0 : 1)
    if (smooth) {
      linearRampAt(next.inGate.gain, t, 1, t + HANDOFF_SECONDS)
      linearRampAt(next.out.gain, t, 1, t + fadeSeconds)
    }
    for (const s of stale) {
      if (s === old && smooth) linearRampAt(s.out.gain, t, 0, t + fadeSeconds)
      else setValueAt(s.out.gain, t, 0)
      this.retire(s, t + (smooth ? fadeSeconds : 0))
    }
    this.pool.push(next)
    this.active = next
  }

  /** 次に使う組: 空の組 → 新しい組（上限まで）→ 最も前に入力を閉じた組 */
  private nextSlot(when: number, exclude: Slot): Slot {
    const idle = this.pool.filter((s) => s !== exclude)
    const clean = idle.find((s) => s.idleFrom + s.buffer.duration + CLEAN_MARGIN_SECONDS <= when)
    if (clean) return clean
    if (this.pool.length < MAX_SLOTS) {
      const s = this.makeSlot(this.buffer!, 0, 0)
      this.pool.push(s)
      return s
    }
    return idle.reduce((a, b) => (a.idleFrom <= b.idleFrom ? a : b))
  }

  /**
   * 時刻 at までに入った音の残響を消す。at から HANDOFF_SECONDS で入力を古い組 → 次の組へ受け渡し、
   * 古い組はその後 fadeSeconds でフェードアウトする（at 以降の音の残響は次の組で途切れずに続く）
   */
  reset(at: number, fadeSeconds: number): void {
    const old = this.active
    if (!old || !this.buffer) return
    this.sweep()
    const when = Math.max(at, this.ctx.currentTime)
    const handed = when + HANDOFF_SECONDS
    const next = this.nextSlot(when, old)
    setValueAt(next.out.gain, when, 1)
    linearRampAt(next.inGate.gain, when, 1, handed)
    next.idleFrom = Infinity
    linearRampAt(old.inGate.gain, when, 0, handed)
    linearRampAt(old.out.gain, handed, 0, handed + Math.max(fadeSeconds, 0.002))
    old.idleFrom = handed
    this.active = next
  }
}
