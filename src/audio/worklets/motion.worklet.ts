// AudioWorklet: Dynamic Spatial Motion Engine
//
//   L/R ─→ STFT(2048/1024, √Hann) ─→ 帯域ごとのマスクでレイヤー分解 ─→ ISTFT
//            CENTER / LEFT / RIGHT / AMB L / AMB R / BED L / BED R（7 レイヤーの和 = 原音）
//   各レイヤー ─→ 距離処理（伝搬遅延・空気吸収ローパス・逆距離ゲイン）─→ 等パワーパン ─→ 出力0: 仮想スピーカー 12ch
//   出力1: 原音を STFT 遅延分だけ遅らせた L/R（反射音・残響の送りに使い、直接音と時刻をそろえる）
//
// 位置はメディア時刻の純粋関数（motion.ts）。平滑化は 16 サンプルごとの制御レートで行い、
// ゲイン類は制御点間を線形補間する（パン・距離の変化でクリックが出ない）。
// HRTF は固定（12 方向）で、音源の移動は振幅パンだけで表現する（HRTF の切替ノイズを避ける）。

import {
  createPositions,
  distanceDelaySeconds,
  distanceGain,
  distanceLowpassHz,
  panPair,
  sourcePositions,
  SOURCE_COUNT,
  SPEAKER_COUNT,
  type Envelope,
  type MotionControl,
  type MotionLayout,
} from '../spatial/motion'
import {
  MOTION_BED_HIGH_HZ,
  MOTION_BED_LOW_HZ,
  MOTION_FFT_SIZE,
  MOTION_HOP,
  type MotionMessage,
  type MotionReport,
  type MotionTransport,
  type MotionWorkletOptions,
} from '../spatial/motionTypes'

declare const sampleRate: number
declare const currentTime: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: { processorOptions?: unknown })
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: unknown }) => AudioWorkletProcessor): void

const N = MOTION_FFT_SIZE
const H = MOTION_HOP
const BINS = N / 2 + 1
/** 帯域ごとの統計（相関・パワー）の平滑化時定数 */
const STAT_TC = 0.12
/** 位置の平滑化時定数（パラメーター変更時の急な移動を防ぐ） */
const POSITION_TC = 0.15
const CONTROL = 16
const MAX_DELAY = 4096
/** Motion OFF 後もフェードアウトのために処理を続ける時間（秒）。その後は処理を止めて CPU を使わない */
const IDLE_AFTER_SECONDS = 0.5
/** 1 レイヤーが同時に使う仮想スピーカーの最大数（制御点の前後のペア） */
const MAX_ACTIVE = 4

class MotionProcessor extends AudioWorkletProcessor {
  private layout: MotionLayout
  private control: MotionControl
  private transport: MotionTransport
  private envelope: Envelope | null
  private readonly debugLayers: boolean

  // FFT
  private readonly re = new Float64Array(N)
  private readonly im = new Float64Array(N)
  private readonly twCos = new Float64Array(N / 2)
  private readonly twSin = new Float64Array(N / 2)
  private readonly rev = new Uint32Array(N)
  private readonly win = new Float64Array(N)
  private readonly bedW = new Float64Array(BINS)
  // STFT バッファ
  private readonly inL = new Float32Array(N)
  private readonly inR = new Float32Array(N)
  private fill = 0
  private readonly acc: Float32Array[]
  private readonly outQ: Float32Array[]
  private readonly specRe: Float64Array[]
  private readonly specIm: Float64Array[]
  // 帯域統計
  private readonly pll = new Float64Array(BINS)
  private readonly prr = new Float64Array(BINS)
  private readonly plrRe = new Float64Array(BINS)
  private readonly plrIm = new Float64Array(BINS)
  private readonly statAlpha: number
  // 原音の遅延（出力 1）
  private readonly alignL = new Float32Array(N)
  private readonly alignR = new Float32Array(N)
  private alignPos = 0
  // レイヤーごとの距離処理
  private readonly dl: Float32Array[]
  private dlPos = 0
  private readonly lpState = new Float64Array(SOURCE_COUNT)
  // 位置（平滑化後）と制御点
  private readonly target = createPositions()
  private readonly px = new Float64Array(SOURCE_COUNT)
  private readonly py = new Float64Array(SOURCE_COUNT)
  private readonly pd = new Float64Array(SOURCE_COUNT)
  private snap = true
  private readonly posCoef: number
  private ctrlCount = 0
  private readonly gPrev: Float64Array[]
  private readonly gNext: Float64Array[]
  /** 疎なパンゲイン（前後の制御点で 0 でないスピーカーだけ） */
  private readonly actIdx: Int32Array[]
  private readonly actFrom: Float64Array[]
  private readonly actTo: Float64Array[]
  private readonly actCount = new Int32Array(SOURCE_COUNT)
  /** 無相関な信号でもコヒーレンス推定値が 0 にならない分（平均フレーム数による偏り）の補正 */
  private readonly cohBias: number
  // 休止（Motion OFF 時は処理しない）
  private idle = false
  private idleCountdown = 0
  private readonly lpPrev = new Float64Array(SOURCE_COUNT)
  private readonly lpNext = new Float64Array(SOURCE_COUNT)
  private readonly dlyPrev = new Float64Array(SOURCE_COUNT)
  private readonly dlyNext = new Float64Array(SOURCE_COUNT)
  private readonly layerVal = new Float64Array(SOURCE_COUNT)
  // レポート
  private readonly reportEvery: number
  private sinceReport = 0

  constructor(options: { processorOptions?: unknown }) {
    super(options)
    const o = options.processorOptions as MotionWorkletOptions
    this.layout = o.layout
    this.control = o.control
    this.transport = o.transport
    this.envelope = o.envelope
    this.debugLayers = !!o.debugLayers
    this.reportEvery = o.reportIntervalMs > 0 ? Math.round((o.reportIntervalMs / 1000) * sampleRate) : 0

    const bits = Math.log2(N)
    for (let i = 0; i < N; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
      // 周期 √Hann（分析・合成とも）。ホップ N/2 で Hann の和 = 1、N/4 で 2
      this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
    }
    for (let i = 0; i < N / 2; i++) {
      this.twCos[i] = Math.cos((-2 * Math.PI * i) / N)
      this.twSin[i] = Math.sin((-2 * Math.PI * i) / N)
    }
    for (let k = 0; k < BINS; k++) {
      const f = (k * sampleRate) / N
      if (f <= MOTION_BED_LOW_HZ) this.bedW[k] = 1
      else if (f >= MOTION_BED_HIGH_HZ) this.bedW[k] = 0
      else {
        const x = (f - MOTION_BED_LOW_HZ) / (MOTION_BED_HIGH_HZ - MOTION_BED_LOW_HZ)
        this.bedW[k] = 0.5 + 0.5 * Math.cos(Math.PI * x)
      }
    }
    this.acc = Array.from({ length: SOURCE_COUNT }, () => new Float32Array(N))
    this.outQ = Array.from({ length: SOURCE_COUNT }, () => new Float32Array(H))
    this.specRe = Array.from({ length: SOURCE_COUNT }, () => new Float64Array(BINS))
    this.specIm = Array.from({ length: SOURCE_COUNT }, () => new Float64Array(BINS))
    this.dl = Array.from({ length: SOURCE_COUNT }, () => new Float32Array(MAX_DELAY))
    this.gPrev = Array.from({ length: SOURCE_COUNT }, () => new Float64Array(SPEAKER_COUNT))
    this.gNext = Array.from({ length: SOURCE_COUNT }, () => new Float64Array(SPEAKER_COUNT))
    this.actIdx = Array.from({ length: SOURCE_COUNT }, () => new Int32Array(MAX_ACTIVE))
    this.actFrom = Array.from({ length: SOURCE_COUNT }, () => new Float64Array(MAX_ACTIVE))
    this.actTo = Array.from({ length: SOURCE_COUNT }, () => new Float64Array(MAX_ACTIVE))
    this.statAlpha = Math.exp(-H / (STAT_TC * sampleRate))
    // 指数平均の実効フレーム数 Neff = (1+α)/(1−α)。独立な信号のコヒーレンス推定値の期待値 ≈ 1/√Neff
    this.cohBias = 1 / Math.sqrt((1 + this.statAlpha) / (1 - this.statAlpha))
    this.idle = !this.control.enabled
    this.idleCountdown = 0
    this.posCoef = 1 - Math.exp(-CONTROL / (POSITION_TC * sampleRate))

    this.port.onmessage = (e: MessageEvent<MotionMessage>) => {
      const m = e.data
      if (m.type === 'params') {
        const wasEnabled = this.control.enabled
        this.layout = m.layout
        this.control = m.control
        if (m.control.enabled && this.idle) this.wake()
        else if (!m.control.enabled && wasEnabled) this.idleCountdown = Math.round(IDLE_AFTER_SECONDS * sampleRate) + N
      } else if (m.type === 'transport') {
        this.transport = m.transport
        // 再生開始・シーク時は平滑化をやめて正確な位置へ移る（再生位置から常に同じ位置を再現する）
        this.snap = true
      } else if (m.type === 'envelope') {
        this.envelope = m.envelope
      }
    }
  }

  /** 休止から復帰: 古い状態を消し、正確な位置から始める */
  private wake(): void {
    this.idle = false
    this.inL.fill(0)
    this.inR.fill(0)
    this.fill = 0
    for (const a of this.acc) a.fill(0)
    for (const q of this.outQ) q.fill(0)
    for (const d of this.dl) d.fill(0)
    this.alignL.fill(0)
    this.alignR.fill(0)
    this.pll.fill(0)
    this.prr.fill(0)
    this.plrRe.fill(0)
    this.plrIm.fill(0)
    this.lpState.fill(0)
    this.ctrlCount = 0
    this.snap = true
  }

  /** 出力中の音に対応するメディア時刻（STFT の遅延分だけ前） */
  private mediaTime(frameOffset: number): number {
    const t = this.transport
    const base = t.playing ? currentTime + frameOffset / sampleRate - t.startedAt : t.pausedAt
    return base - N / sampleRate
  }

  private fft(re: Float64Array, im: Float64Array): void {
    const rev = this.rev
    for (let i = 0; i < N; i++) {
      const j = rev[i]
      if (i < j) {
        const tr = re[i]
        re[i] = re[j]
        re[j] = tr
        const ti = im[i]
        im[i] = im[j]
        im[j] = ti
      }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const half = len >> 1
      const step = N / len
      for (let i = 0; i < N; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.twCos[k * step]
          const wi = this.twSin[k * step]
          const a = i + k
          const b = a + half
          const tr = re[b] * wr - im[b] * wi
          const ti = re[b] * wi + im[b] * wr
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }

  private processFrame(): void {
    const re = this.re
    const im = this.im
    const w = this.win
    for (let n = 0; n < N; n++) {
      re[n] = this.inL[n] * w[n]
      im[n] = this.inR[n] * w[n]
    }
    this.fft(re, im)

    const a = this.statAlpha
    const lock = Math.min(Math.max(this.control.enabled ? this.control.centerLock : 1, 0), 1)
    const sr = this.specRe
    const si = this.specIm
    for (let k = 0; k < BINS; k++) {
      const nk = (N - k) % N
      // 2 つの実信号を 1 回の複素 FFT から分離
      const xlr = (re[k] + re[nk]) / 2
      const xli = (im[k] - im[nk]) / 2
      const xrr = (im[k] + im[nk]) / 2
      const xri = -(re[k] - re[nk]) / 2

      this.pll[k] = a * this.pll[k] + (1 - a) * (xlr * xlr + xli * xli)
      this.prr[k] = a * this.prr[k] + (1 - a) * (xrr * xrr + xri * xri)
      this.plrRe[k] = a * this.plrRe[k] + (1 - a) * (xlr * xrr + xli * xri)
      this.plrIm[k] = a * this.plrIm[k] + (1 - a) * (xli * xrr - xlr * xri)
      const sL = Math.sqrt(this.pll[k])
      const sR = Math.sqrt(this.prr[k])
      const mag = Math.hypot(this.plrRe[k], this.plrIm[k])
      // 左右のレベルの釣り合い（片側だけの音 = 0）・コヒーレンス・位相のそろい
      const bal = (2 * Math.min(sL, sR)) / (sL + sR + 1e-20)
      const cohRaw = Math.min(mag / (sL * sR + 1e-20), 1)
      const coh = Math.max(0, (cohRaw - this.cohBias) / (1 - this.cohBias))
      const inPhase = Math.max(0, this.plrRe[k] / (mag + 1e-20))
      // 両チャンネルにあり無相関 = アンビエンス、両チャンネルにあり同相 = センター
      const amb = Math.min(Math.max((1 - coh) * bal, 0), 1)
      const cen = lock * bal * inPhase

      const b = this.bedW[k]
      const yl = 1 - b
      const pr = (1 - amb) * yl
      const plR = pr * xlr
      const plI = pr * xli
      const prR = pr * xrr
      const prI = pr * xri
      const cR = (cen * (plR + prR)) / 2
      const cI = (cen * (plI + prI)) / 2
      sr[0][k] = cR
      si[0][k] = cI
      sr[1][k] = plR - cR
      si[1][k] = plI - cI
      sr[2][k] = prR - cR
      si[2][k] = prI - cI
      sr[3][k] = amb * yl * xlr
      si[3][k] = amb * yl * xli
      sr[4][k] = amb * yl * xrr
      si[4][k] = amb * yl * xri
      sr[5][k] = b * xlr
      si[5][k] = b * xli
      sr[6][k] = b * xrr
      si[6][k] = b * xri
    }

    // 逆変換: 2 レイヤーずつ 1 回の複素 IFFT（実部 = A、虚部 = B）
    // IFFT の 1/N と、√Hann² = Hann をホップ H で重ねたときの和（N / 2H）の補正
    const scale = 1 / (N * (N / (2 * H)))
    for (let p = 0; p < SOURCE_COUNT; p += 2) {
      const A = p
      const B = p + 1 < SOURCE_COUNT ? p + 1 : -1
      for (let k = 0; k < BINS; k++) {
        const ar = sr[A][k]
        const ai = si[A][k]
        const br = B >= 0 ? sr[B][k] : 0
        const bi = B >= 0 ? si[B][k] : 0
        // Y[k] = A[k] + iB[k]（共役を取って順変換で逆変換する）
        re[k] = ar - bi
        im[k] = -(ai + br)
        if (k > 0 && k < N / 2) {
          re[N - k] = ar + bi
          im[N - k] = -(-ai + br)
        }
      }
      this.fft(re, im)
      const accA = this.acc[A]
      const accB = B >= 0 ? this.acc[B] : null
      for (let n = 0; n < N; n++) {
        accA[n] += re[n] * w[n] * scale
        if (accB) accB[n] += -im[n] * w[n] * scale
      }
    }
    for (let s = 0; s < SOURCE_COUNT; s++) {
      const acc = this.acc[s]
      this.outQ[s].set(acc.subarray(0, H))
      acc.copyWithin(0, H)
      acc.fill(0, N - H)
    }
    this.inL.copyWithin(0, H)
    this.inR.copyWithin(0, H)
  }

  /** 制御点の更新: 目標位置 → 平滑化 → パンゲイン・距離パラメーター */
  private updateControl(frameOffset: number): void {
    sourcePositions(this.mediaTime(frameOffset), this.layout, this.control, this.envelope, this.target)
    const k = this.snap ? 1 : this.posCoef
    for (let s = 0; s < SOURCE_COUNT; s++) {
      const az = (this.target[s].azimuth * Math.PI) / 180
      // 方位は単位ベクトルで平滑化（±180° をまたいでも最短経路で動く）
      this.px[s] += (Math.sin(az) - this.px[s]) * k
      this.py[s] += (Math.cos(az) - this.py[s]) * k
      this.pd[s] += (this.target[s].distance - this.pd[s]) * k
      const smoothedAz = (Math.atan2(this.px[s], this.py[s]) * 180) / Math.PI
      const [i0, i1, g0, g1] = panPair(smoothedAz)
      const gd = distanceGain(this.pd[s])
      const prev = this.gPrev[s]
      const next = this.gNext[s]
      prev.set(next)
      next.fill(0)
      next[i0] = g0 * gd
      next[i1] += g1 * gd
      this.lpPrev[s] = this.lpNext[s]
      this.lpNext[s] = 1 - Math.exp((-2 * Math.PI * distanceLowpassHz(this.pd[s])) / sampleRate)
      this.dlyPrev[s] = this.dlyNext[s]
      this.dlyNext[s] = Math.min(distanceDelaySeconds(this.pd[s]) * sampleRate, MAX_DELAY - 2)
      if (this.snap) {
        prev.set(next)
        this.lpPrev[s] = this.lpNext[s]
        this.dlyPrev[s] = this.dlyNext[s]
      }
      // 前後どちらかで 0 でないスピーカーだけを列挙（最大 4）
      let n = 0
      const idx = this.actIdx[s]
      for (let c = 0; c < SPEAKER_COUNT && n < MAX_ACTIVE; c++) {
        if (prev[c] !== 0 || next[c] !== 0) {
          idx[n] = c
          this.actFrom[s][n] = prev[c]
          this.actTo[s][n] = next[c]
          n++
        }
      }
      this.actCount[s] = n
    }
    this.snap = false
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] ?? []
    const L = input[0]
    const R = input[1] ?? input[0]
    const spk = outputs[0]
    const aux = outputs[1]
    const frames = spk[0]?.length ?? 128
    for (const ch of spk) ch.fill(0)
    if (this.idle) {
      for (const ch of aux) ch.fill(0)
      return true
    }
    if (!this.control.enabled) {
      this.idleCountdown -= frames
      if (this.idleCountdown <= 0) {
        this.idle = true
        for (const ch of aux) ch.fill(0)
        return true
      }
    }
    const dl = this.dl
    const lpState = this.lpState
    const layerVal = this.layerVal

    for (let i = 0; i < frames; i++) {
      const l = L ? L[i] : 0
      const r = R ? R[i] : 0
      if (this.ctrlCount === 0) this.updateControl(i)
      const frac = this.ctrlCount / CONTROL
      this.ctrlCount = (this.ctrlCount + 1) % CONTROL

      // 出力 1: 原音を N サンプル遅らせる（反射音・残響の送り用）
      const ap = this.alignPos
      const dL = this.alignL[ap]
      const dR = this.alignR[ap]
      this.alignL[ap] = l
      this.alignR[ap] = r
      this.alignPos = (ap + 1) % N

      // STFT の入出力
      const fi = this.fill
      this.inL[N - H + fi] = l
      this.inR[N - H + fi] = r
      for (let s = 0; s < SOURCE_COUNT; s++) this.layerVal[s] = this.outQ[s][fi]
      this.fill = fi + 1
      if (this.fill === H) {
        this.processFrame()
        this.fill = 0
      }

      if (this.debugLayers) {
        for (let s = 0; s < SOURCE_COUNT && s < aux.length; s++) aux[s][i] = this.layerVal[s]
      } else if (aux.length >= 2) {
        aux[0][i] = dL
        aux[1][i] = dR
      }

      // 各レイヤー: 伝搬遅延 → 空気吸収 → パン（ゲインは制御点間を線形補間）
      const pos = this.dlPos
      for (let s = 0; s < SOURCE_COUNT; s++) {
        const line = dl[s]
        line[pos] = layerVal[s]
        const d = this.dlyPrev[s] + (this.dlyNext[s] - this.dlyPrev[s]) * frac
        const di = d | 0
        const df = d - di
        let i0 = pos - di
        if (i0 < 0) i0 += MAX_DELAY
        const i1 = i0 === 0 ? MAX_DELAY - 1 : i0 - 1
        const x = line[i0] + (line[i1] - line[i0]) * df
        const kLp = this.lpPrev[s] + (this.lpNext[s] - this.lpPrev[s]) * frac
        const y = (lpState[s] += (x - lpState[s]) * kLp)
        if (y === 0) continue
        const n = this.actCount[s]
        const idx = this.actIdx[s]
        const gf = this.actFrom[s]
        const gt = this.actTo[s]
        for (let j = 0; j < n; j++) spk[idx[j]][i] += y * (gf[j] + (gt[j] - gf[j]) * frac)
      }
      this.dlPos = (pos + 1) % MAX_DELAY

      if (this.reportEvery > 0 && ++this.sinceReport >= this.reportEvery) {
        this.sinceReport = 0
        const positions = new Float32Array(SOURCE_COUNT * 2)
        for (let s = 0; s < SOURCE_COUNT; s++) {
          positions[s * 2] = (Math.atan2(this.px[s], this.py[s]) * 180) / Math.PI
          positions[s * 2 + 1] = this.pd[s]
        }
        const report: MotionReport = { mediaTime: this.mediaTime(i), positions }
        this.port.postMessage(report)
      }
    }
    for (let s = 0; s < SOURCE_COUNT; s++) {
      if (!Number.isFinite(this.lpState[s])) this.lpState[s] = 0
    }
    return true
  }
}

registerProcessor('csx-motion', MotionProcessor)
