// AudioWorklet: 低域ダイナミクス ＋ 帯域合成 ＋ 出力トリム ＋ サンプルピークリミッター
//
//   input0 (低域, クロスオーバー LP) → 低域コンプ（ステレオリンク、ソフトニー）─┐
//   input1 (中高域, クロスオーバー HP) ──────────────────────────────────────┴→ 合成 → トリム → リミッター → 出力
//
// リミッターは先読み（lookahead）付きのサンプルピークリミッター。
// 窓内最小ゲイン → 同長の移動平均 → リリース平滑化の順で、出力サンプルが必ず ceiling 以下になるよう設計している。
// True Peak（サンプル間ピーク）は検出しない。

import type { DynamicsSettings, DynamicsMeter } from '../dynamicsTypes'

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: { processorOptions?: unknown })
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: unknown }) => AudioWorkletProcessor): void

const dbToLin = (db: number) => Math.pow(10, db / 20)
const timeCoef = (ms: number) => (ms <= 0 ? 0 : Math.exp(-1 / ((ms / 1000) * sampleRate)))

class BassDynamicsProcessor extends AudioWorkletProcessor {
  private s: DynamicsSettings
  // 低域コンプ
  private env = 0
  private bassGain = 1
  private envRelease = 0
  private attCoef = 0
  private relCoef = 0
  // トリム（平滑化）
  private trim = 1
  private trimTarget = 1
  private trimCoef = 0
  // リミッター
  private readonly L: number
  private delay: Float32Array[]
  private delayPos = 0
  private minQueueVal: Float32Array
  private minQueueIdx: Int32Array
  private qHead = 0
  private qTail = 0
  private boxBuf: Float32Array
  private boxPos = 0
  private boxSum: number
  private limGain = 1
  private limRelCoef = 0
  private ceiling = 1
  private n = 0
  // メーター
  private reportEvery: number
  private sinceReport = 0
  private maxBassGr = 0
  private maxLimGr = 0
  private clamped = 0

  constructor(options: { processorOptions?: unknown }) {
    super(options)
    this.s = options.processorOptions as DynamicsSettings
    this.L = Math.max(1, Math.round((this.s.lookaheadMs / 1000) * sampleRate))
    this.delay = [new Float32Array(this.L + 1), new Float32Array(this.L + 1)]
    this.minQueueVal = new Float32Array(this.L + 2)
    this.minQueueIdx = new Int32Array(this.L + 2)
    this.boxBuf = new Float32Array(this.L).fill(1)
    this.boxSum = this.L
    this.reportEvery = this.s.reportIntervalMs > 0 ? Math.round((this.s.reportIntervalMs / 1000) * sampleRate) : 0
    this.trim = this.trimTarget = dbToLin(this.s.trimDb)
    this.updateCoefs()
    this.port.onmessage = (e: MessageEvent<Partial<DynamicsSettings>>) => {
      this.s = { ...this.s, ...e.data }
      this.trimTarget = dbToLin(this.s.trimDb)
      this.updateCoefs()
    }
  }

  private updateCoefs() {
    this.envRelease = timeCoef(60)
    this.attCoef = timeCoef(this.s.bassAttackMs)
    this.relCoef = timeCoef(this.s.bassReleaseMs)
    this.trimCoef = timeCoef(80)
    this.limRelCoef = timeCoef(this.s.limiterReleaseMs)
    this.ceiling = this.s.limiterEnabled ? dbToLin(this.s.ceilingDb) : Infinity
  }

  /** ソフトニー付きのゲインリダクション量（dB, 0 以上） */
  private bassGr(levelDb: number): number {
    const { bassThresholdDb: T, bassKneeDb: W, bassRatio: R } = this.s
    const over = levelDb - T
    if (2 * over <= -W) return 0
    if (2 * over >= W) return over - over / R
    const x = over + W / 2
    return ((1 - 1 / R) * x * x) / (2 * W)
  }

  /** 窓内最小値（単調キュー）。窓長 L+1 */
  private pushMin(v: number, idx: number): number {
    const cap = this.minQueueVal.length
    while (this.qTail !== this.qHead) {
      const last = (this.qTail - 1 + cap) % cap
      if (this.minQueueVal[last] >= v) this.qTail = last
      else break
    }
    this.minQueueVal[this.qTail] = v
    this.minQueueIdx[this.qTail] = idx
    this.qTail = (this.qTail + 1) % cap
    while (this.minQueueIdx[this.qHead] < idx - this.L) this.qHead = (this.qHead + 1) % cap
    return this.minQueueVal[this.qHead]
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const low = inputs[0] ?? []
    const high = inputs[1] ?? []
    const out = outputs[0]
    const frames = out[0]?.length ?? 128
    const outCh = out.length
    const pick = (chs: Float32Array[], c: number, i: number) => (chs.length === 0 ? 0 : chs[Math.min(c, chs.length - 1)][i])

    for (let i = 0; i < frames; i++) {
      // 1. 低域コンプ（ステレオリンクのピーク検出）
      let lvl = 0
      for (let c = 0; c < low.length; c++) lvl = Math.max(lvl, Math.abs(low[c][i]))
      this.env = lvl > this.env ? lvl : this.env * this.envRelease
      const gr = this.env > 1e-6 ? this.bassGr(20 * Math.log10(this.env)) : 0
      const target = dbToLin(-gr)
      const coef = target < this.bassGain ? this.attCoef : this.relCoef
      this.bassGain = target + (this.bassGain - target) * coef
      const appliedGr = -20 * Math.log10(this.bassGain)
      if (appliedGr > this.maxBassGr) this.maxBassGr = appliedGr

      // 2. 合成 → 3. トリム
      this.trim = this.trimTarget + (this.trim - this.trimTarget) * this.trimCoef
      let peak = 0
      const pos = this.delayPos
      for (let c = 0; c < 2; c++) {
        const v = (pick(low, c, i) * this.bassGain + pick(high, c, i)) * this.trim
        this.delay[c][pos] = v
        peak = Math.max(peak, Math.abs(v))
      }

      // 4. リミッター: 必要ゲイン → 窓内最小 → 移動平均 → リリース
      const req = peak > this.ceiling ? this.ceiling / peak : 1
      const m = this.pushMin(req, this.n)
      this.boxSum += m - this.boxBuf[this.boxPos]
      this.boxBuf[this.boxPos] = m
      this.boxPos = (this.boxPos + 1) % this.L
      const boxed = Math.min(1, this.boxSum / this.L)
      this.limGain = boxed < this.limGain ? boxed : boxed + (this.limGain - boxed) * this.limRelCoef
      const limGrDb = -20 * Math.log10(this.limGain)
      if (limGrDb > this.maxLimGr) this.maxLimGr = limGrDb

      const readPos = (pos + 1) % (this.L + 1) // L サンプル前
      for (let c = 0; c < outCh; c++) {
        let y = this.delay[Math.min(c, 1)][readPos] * this.limGain
        // 浮動小数点誤差対策の最終保護（設計上は発生しない。発生回数を計測）
        if (y > this.ceiling) {
          y = this.ceiling
          this.clamped++
        } else if (y < -this.ceiling) {
          y = -this.ceiling
          this.clamped++
        }
        out[c][i] = Number.isFinite(y) ? y : 0
      }
      this.delayPos = (pos + 1) % (this.L + 1)
      this.n++

      if (this.reportEvery > 0 && ++this.sinceReport >= this.reportEvery) {
        const meter: DynamicsMeter = { bassGrDb: this.maxBassGr, limiterGrDb: this.maxLimGr, clamped: this.clamped }
        this.port.postMessage(meter)
        this.sinceReport = 0
        this.maxBassGr = 0
        this.maxLimGr = 0
      }
    }
    if (!Number.isFinite(this.env) || !Number.isFinite(this.bassGain) || !Number.isFinite(this.limGain)) {
      this.env = 0
      this.bassGain = 1
      this.limGain = 1
    }
    return true
  }
}

registerProcessor('csx-bass-dynamics', BassDynamicsProcessor)
