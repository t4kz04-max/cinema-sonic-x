// Spatial Tail Engine（CINEMA / HALL 共通の後期残響チェーン）
//
//   input（ステレオ）─┬─ HPF 180 Hz → LPF 9 kHz → モノラル → プリディレイ → [ReverbBus: 畳み込み] → レベル ─→ [csx-tail] ─→ output
//                    └──────────────────────────────────────────────────────────────── 検出器入力 ──┘
//
// 送り・プリディレイ・レベルは HALL の後期残響と同じ構成で、NATURAL・TAIL LENGTH/INTENSITY 50 なら同じ値になる。

import tailWorkletUrl from '../worklets/tail.worklet.ts?worker&url'
import { BUTTERWORTH_Q_DB, dbToGain, monoGain, setParam, stereoGain } from './nodeUtils'
import { ReverbBus } from './reverbBus'
import { synthesizeTailIR, type ActiveTailMode } from './tailImpulse'
import type { TailMessage, TailReport, TailWorkletOptions } from './tailTypes'
import { HALL_SEND_HIGHPASS_HZ, HALL_SEND_LOWPASS_HZ, isTailActive, tailDynamics, tailSettings, type SpatialParams } from './spatialSpec'

/** IR 切替のクロスフェード（HALL と同じ） */
const IR_FADE_SECONDS = 0.15
/** IR を作り直す残響時間の差（秒） */
const RT60_EPSILON = 0.03

const tailLoads = new WeakMap<BaseAudioContext, Promise<boolean>>()
/** 読み込みが完了した文脈（グラフ構築は同期のため、事前に loadTailWorklet を待つ必要がある） */
const tailReady = new WeakSet<BaseAudioContext>()

/** Dynamic Tail の AudioWorklet を読み込む。非対応なら false（残響は使えるが Dynamic Tail と蓄積防止は無効） */
export function loadTailWorklet(ctx: BaseAudioContext): Promise<boolean> {
  let p = tailLoads.get(ctx)
  if (!p) {
    p =
      typeof AudioWorkletNode === 'undefined' || !ctx.audioWorklet
        ? Promise.resolve(false)
        : ctx.audioWorklet.addModule(tailWorkletUrl).then(
            () => {
              tailReady.add(ctx)
              return true
            },
            () => false,
          )
    tailLoads.set(ctx, p)
  }
  return p
}

// 合成した IR のキャッシュ（同じモード・残響時間を何度も合成しない。AudioBuffer は文脈ごとに作る）
const irCache = new Map<string, [Float32Array, Float32Array]>()
const IR_CACHE_LIMIT = 6

function tailIrBuffer(ctx: BaseAudioContext, mode: ActiveTailMode, rt60: number): AudioBuffer {
  const key = `${mode}:${rt60.toFixed(3)}:${ctx.sampleRate}`
  let ir = irCache.get(key)
  if (!ir) {
    ir = synthesizeTailIR(mode, rt60, ctx.sampleRate)
    irCache.set(key, ir)
    if (irCache.size > IR_CACHE_LIMIT) irCache.delete(irCache.keys().next().value!)
  }
  const buf = new AudioBuffer({ length: ir[0].length, numberOfChannels: 2, sampleRate: ctx.sampleRate })
  buf.copyToChannel(ir[0] as Float32Array<ArrayBuffer>, 0)
  buf.copyToChannel(ir[1] as Float32Array<ArrayBuffer>, 1)
  return buf
}

export interface TailChain {
  input: AudioNode
  output: AudioNode
  /** Dynamic Tail・蓄積防止のゲイン（モノラル、テスト用）。ワークレットがなければ null */
  gainProbe: AudioNode | null
  engine: 'worklet' | 'fallback'
  update(p: SpatialParams, smooth: boolean): void
  /** チェーン入力に時刻 at までに入った音の残響を消す（PAUSE・CUT・NORMAL LOOP の境界。プリディレイ分はここで足す） */
  reset(at: number, fadeSeconds: number): void
  onReport(listener: ((r: TailReport) => void) | null): void
  /** 同時に存在する畳み込みの組の数（テスト用） */
  readonly slotCount: number
}

export function createTail(ctx: BaseAudioContext, p: SpatialParams, useWorklet: boolean, reportIntervalMs = 0): TailChain {
  let s = tailSettings(p)
  const input = stereoGain(ctx)
  const sendHp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: HALL_SEND_HIGHPASS_HZ, Q: BUTTERWORTH_Q_DB })
  const sendLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: HALL_SEND_LOWPASS_HZ, Q: BUTTERWORTH_Q_DB })
  const send = monoGain(ctx)
  const preDelay = new DelayNode(ctx, { maxDelayTime: 0.2, delayTime: s.preDelayMs / 1000 })
  input.connect(sendHp).connect(sendLp).connect(send).connect(preDelay)
  const busOut = stereoGain(ctx)
  const bus = new ReverbBus(ctx, preDelay, busOut, 1)
  const level = stereoGain(ctx, dbToGain(s.gainDb))
  busOut.connect(level)
  const output = stereoGain(ctx)

  let worklet: AudioWorkletNode | null = null
  let reportListener: ((r: TailReport) => void) | null = null
  if (useWorklet && tailReady.has(ctx)) {
    const options: TailWorkletOptions = { ...tailDynamics(p), reportIntervalMs }
    worklet = new AudioWorkletNode(ctx, 'csx-tail', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [2, 1],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: options,
    })
    level.connect(worklet, 0, 0)
    input.connect(worklet, 0, 1)
    worklet.connect(output, 0)
    // 通知を使うときだけ受信する（onmessage を設定した MessagePort は閉じるまで GC されず、解析用の OfflineAudioContext ごと残るため）
    if (reportIntervalMs > 0) worklet.port.onmessage = (e: MessageEvent<TailReport>) => reportListener?.(e.data)
  } else {
    level.connect(output)
  }
  const gainProbe = worklet ? new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit' }) : null
  if (worklet && gainProbe) worklet.connect(gainProbe, 1)

  // IR は Tail を使うときに初めて作る（OFF のまま解析用のグラフを何度も作る場合に合成しない）
  let irKey: { mode: ActiveTailMode; rt60: number } | null = null
  const ensureIr = (smooth: boolean) => {
    if (irKey && irKey.mode === s.mode && Math.abs(irKey.rt60 - s.rt60) <= RT60_EPSILON) return
    bus.setBuffer(tailIrBuffer(ctx, s.mode, s.rt60), smooth && irKey ? IR_FADE_SECONDS : 0)
    irKey = { mode: s.mode, rt60: s.rt60 }
  }
  if (isTailActive(p)) ensureIr(false)

  return {
    input,
    output,
    gainProbe,
    engine: worklet ? 'worklet' : 'fallback',
    update(np, smooth) {
      s = tailSettings(np)
      setParam(ctx, preDelay.delayTime, s.preDelayMs / 1000, smooth, 0.1)
      setParam(ctx, level.gain, dbToGain(s.gainDb), smooth)
      if (isTailActive(np)) ensureIr(smooth)
      const m: TailMessage = { type: 'dynamics', dynamics: tailDynamics(np) }
      worklet?.port.postMessage(m)
    },
    reset(at, fadeSeconds) {
      bus.reset(at + preDelay.delayTime.value, fadeSeconds)
    },
    onReport(listener) {
      reportListener = listener
    },
    get slotCount() {
      return bus.slotCount
    },
  }
}
