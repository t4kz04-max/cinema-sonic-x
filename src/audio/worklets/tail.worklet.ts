// AudioWorklet: Dynamic Tail ＋ 残響の蓄積防止（Spatial Tail の残響の戻りに掛けるゲイン）
//
//   input0: 残響の戻り（ステレオ）──→ × ゲイン ──→ 出力0
//   input1: 原音（残響への送りと同じ時刻、ステレオ）→ 検出器
//   出力1:  現在のゲイン（モノラル、テスト・測定用）
//
// 検出器: 短時間レベル（速い）と曲の平均レベル（100 ms 平均パワーの遅い追従、無音中は更新しない）を比べ、
// 「演奏が密」なら残響を duckDb だけ下げ、「音の切れ目」なら設定レベル（0 dB）へ戻す。
// 下げる側は速く（Attack）、戻す側は Hold の後にゆっくり（Release）、最後に平滑化する。
// 設定レベルより大きくはしない（残響を突然増幅しない）。
// 蓄積防止: 残響の戻りが曲の平均レベル − guardMarginDb を超えたら、ゆっくり抑える。
// 原音が無音になった後（停止後の余韻）は、残響が減衰した分だけ抑制を解除する（出力は増えずに、抑制だけが外れていく）。
// DYNAMIC TAIL OFF かつ蓄積防止が働いていなければゲインは厳密に 1（NATURAL = 既存 HALL と同じ値）。

import { TAIL_DETECTOR as D, type TailDynamics, type TailMessage, type TailReport, type TailWorkletOptions } from '../spatial/tailTypes'

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: { processorOptions?: unknown })
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: unknown }) => AudioWorkletProcessor): void

const CONTROL = 16
const coef = (seconds: number, every = 1) => 1 - Math.exp(-every / (seconds * sampleRate))
const powDb = (p: number) => 10 * Math.log10(p + 1e-30)

class TailProcessor extends AudioWorkletProcessor {
  private dyn: TailDynamics
  private fast = 0
  /** 100 ms の平均パワー（ピーク寄りに偏らない平均レベルの元） */
  private mean = 0
  private program = 0
  private programSeen = false
  /** 音が鳴っていた累計サンプル数（平均レベルが定まるまで蓄積防止を働かせない） */
  private active = 0
  private wet = 0
  private prevWetDb = -300
  private duck = 0
  private guard = 0
  private hold = 0
  private gain = 1
  private gainTarget = 1
  private ctrl = 0
  private readonly kFastA = coef(D.fastAttack)
  private readonly kFastR = coef(D.fastRelease)
  private readonly kMean = coef(0.1)
  private readonly kProgUp = coef(0.4)
  private readonly guardAfter = Math.round(0.5 * sampleRate)
  private readonly kProgDown = coef(D.programTc)
  private readonly kWet = coef(0.3)
  private readonly kAtt = coef(D.attack, CONTROL)
  private readonly kRel = coef(D.release, CONTROL)
  private readonly kGuardA = coef(D.guardAttack, CONTROL)
  private readonly kGuardR = coef(D.guardRelease, CONTROL)
  private readonly kSmooth = coef(D.smoothing)
  private readonly holdSamples = Math.round(D.hold * sampleRate)
  private readonly silence = Math.pow(10, D.silenceDb / 10)
  private readonly reportEvery: number
  private sinceReport = 0

  constructor(options: { processorOptions?: unknown }) {
    super(options)
    const o = options.processorOptions as TailWorkletOptions
    this.dyn = { dynamic: o.dynamic, duckDb: o.duckDb, guardMarginDb: o.guardMarginDb }
    this.reportEvery = o.reportIntervalMs > 0 ? Math.round((o.reportIntervalMs / 1000) * sampleRate) : 0
    this.port.onmessage = (e: MessageEvent<TailMessage>) => {
      if (e.data.type === 'dynamics') this.dyn = e.data.dynamics
    }
  }

  private control(): void {
    // Dynamic Tail: 演奏の密度（短時間レベルが平均にどれだけ近いか）→ 下げる量
    let target = 0
    if (this.dyn.dynamic && this.programSeen) {
      const a = Math.min(Math.max((powDb(this.fast) - (powDb(this.program) - D.gapBelowDb)) / D.rangeDb, 0), 1)
      target = -this.dyn.duckDb * a
    }
    if (target < this.duck) {
      this.duck += (target - this.duck) * this.kAtt
      this.hold = this.holdSamples
    } else if (this.hold > 0) {
      this.hold -= CONTROL
    } else {
      this.duck += (target - this.duck) * this.kRel
      if (this.duck > -1e-6 && target === 0) this.duck = 0
    }
    // 蓄積防止: 残響の戻り > 平均レベル − margin なら抑える（無音中は平均を更新しないため、停止後の余韻は抑えない）
    let gTarget = 0
    if (this.programSeen && this.active >= this.guardAfter) {
      const over = powDb(this.wet) - (powDb(this.program) - this.dyn.guardMarginDb)
      if (over > 0) gTarget = -over
    }
    const wetDb = powDb(this.wet)
    if (gTarget < this.guard) this.guard += (gTarget - this.guard) * this.kGuardA
    else if (this.fast <= this.silence) {
      // 無音中: 残響が減衰した分だけ解除（平滑化した戻りは実際の減衰より遅れて下がるため、出力は増えない）
      this.guard = Math.min(gTarget, this.guard + Math.max(0, this.prevWetDb - wetDb))
    } else {
      this.guard += (gTarget - this.guard) * this.kGuardR
      if (this.guard > -1e-6 && gTarget === 0) this.guard = 0
    }
    this.prevWetDb = wetDb
    const db = this.duck + this.guard
    this.gainTarget = db === 0 ? 1 : Math.pow(10, db / 20)
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const wetIn = inputs[0] ?? []
    const dryIn = inputs[1] ?? []
    const out = outputs[0]
    const gOut = outputs[1]?.[0]
    const frames = out[0]?.length ?? 128
    const wl = wetIn[0]
    const wr = wetIn[1] ?? wetIn[0]
    const dl = dryIn[0]
    const dr = dryIn[1] ?? dryIn[0]
    const ol = out[0]
    const or = out[1] ?? out[0]
    for (let i = 0; i < frames; i++) {
      const xl = dl ? dl[i] : 0
      const xr = dr ? dr[i] : 0
      const p = 0.5 * (xl * xl + xr * xr)
      this.fast += (p - this.fast) * (p > this.fast ? this.kFastA : this.kFastR)
      if (this.fast > this.silence) {
        this.mean += (p - this.mean) * this.kMean
        this.program += (this.mean - this.program) * (this.mean > this.program ? this.kProgUp : this.kProgDown)
        this.programSeen = true
        if (this.active < this.guardAfter) this.active++
      }
      const a = wl ? wl[i] : 0
      const b = wr ? wr[i] : 0
      this.wet += (0.5 * (a * a + b * b) - this.wet) * this.kWet
      if (this.ctrl === 0) this.control()
      this.ctrl = (this.ctrl + 1) % CONTROL
      if (this.gain !== this.gainTarget) {
        this.gain += (this.gainTarget - this.gain) * this.kSmooth
        if (Math.abs(this.gain - this.gainTarget) < 1e-7) this.gain = this.gainTarget
      }
      const g = this.gain
      ol[i] = g === 1 ? a : a * g
      if (or !== ol) or[i] = g === 1 ? b : b * g
      if (gOut) gOut[i] = g
    }
    if (!Number.isFinite(this.fast) || !Number.isFinite(this.wet) || !Number.isFinite(this.mean)) {
      this.fast = 0
      this.wet = 0
      this.mean = 0
    }
    if (this.reportEvery > 0) {
      this.sinceReport += frames
      if (this.sinceReport >= this.reportEvery) {
        this.sinceReport = 0
        const r: TailReport = { duckDb: this.duck, guardDb: this.guard }
        this.port.postMessage(r)
      }
    }
    return true
  }
}

registerProcessor('csx-tail', TailProcessor)
