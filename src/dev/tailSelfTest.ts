// Phase 04（Spatial Tail / Dynamic Tail / STOP・PAUSE・CUT / NORMAL・SPATIAL LOOP）の自己診断。
// test:spatial の一部、または ?suite=tail で単独実行する。
// STOP・PAUSE・CUT・ループ境界は、再生エンジンと同じ関数（transportOps.ts）を OfflineAudioContext の suspend で
// 指定時刻に呼び出して検証する（実時間の再生を待たずに、サンプル単位で同じ処理を確認できる）。

import { AudioEngine } from '../audio/AudioEngine'
import { integratedLoudness, linearToDb, samplePeak } from '../audio/loudness'
import { loopBounds, musicRegion, type LoopRegion } from '../audio/loopRegion'
import { DEFAULT_BASS_PARAMS } from '../audio/bassSpec'
import { createProcessingGraph, dynamicsSettingsFor, loadDynamicsWorklet } from '../audio/processingGraph'
import { linearRampAt } from '../audio/spatial/nodeUtils'
import { averageSpectrum, thirdOctaveLevelsDb, THIRD_OCTAVE_CENTERS } from '../audio/spectrum'
import { transportTime, type MotionTransport } from '../audio/spatial/motionTypes'
import { analyzeSpatialSource, buildSpatialExcerpt, planSpatial } from '../audio/spatial/spatialAnalysis'
import { createSpatialGraph, loadMotionWorklet, measureHrtfLatency, type SpatialGraph } from '../audio/spatial/spatialGraph'
import { DEFAULT_SPATIAL_PARAMS, hallSettings, tailSettings, type ActiveSpatialMode, type SpatialParams } from '../audio/spatial/spatialSpec'
import { loadTailWorklet } from '../audio/spatial/tailEngine'
import type { TailMode } from '../audio/spatial/tailImpulse'
import type { TailWorkletOptions } from '../audio/spatial/tailTypes'
import { stereoMetrics } from '../audio/stereoMetrics'
import { fadeOutSource, NORMAL_LOOP_RESET_FADE_SECONDS, restoreOutput, silenceOutput, SILENCE_FADE_SECONDS, STOP_FADE_SECONDS } from '../audio/transportOps'
import type { TestResult } from './dspSelfTest'
import hallBaseline from './hallBaseline.json'
import { blockEnergiesDb, HALL_BASELINE_CASES, IMPULSE_AT, renderImpulse, stopDecaySeconds } from './tailBaseline'
import { analyzeTail } from './tailMetrics'
import { programPop, programStereoMix, TEST_RATE, toBuffer } from './testSignals'

const RATE = TEST_RATE
const f1 = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}` : String(v))
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : String(v))
const ms = (s: number) => `${(s * 1000).toFixed(0)} ms`
const hall = (patch: Partial<SpatialParams> = {}): SpatialParams => ({ ...DEFAULT_SPATIAL_PARAMS, mode: 'hall', ...patch })
const TAIL_MODES: Exclude<TailMode, 'off'>[] = ['natural', 'distance', 'ripple']

let hrtfLatency = 0

// ---------------- 信号 ----------------

function noise(seconds: number, seed: number, amp = 0.2): Float32Array {
  let s = seed >>> 0
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s / 0x100000000 - 0.5) * 2 * amp
  })
}
const sine = (f: number, a: number, seconds: number) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / RATE))
const zeros = (seconds: number) => new Float32Array(Math.round(seconds * RATE))
const concat = (...xs: Float32Array[]) => {
  const out = new Float32Array(xs.reduce((n, x) => n + x.length, 0))
  let o = 0
  for (const x of xs) {
    out.set(x, o)
    o += x.length
  }
  return out
}
/** 指定区間だけ鳴る（両端 5 ms のフェード）ノイズ */
function gated(seconds: number, segments: [number, number][], seed: number, amp = 0.25): Float32Array {
  const x = noise(seconds, seed, amp)
  const fade = Math.round(0.005 * RATE)
  const env = new Float32Array(x.length)
  for (const [a, b] of segments) {
    const i0 = Math.round(a * RATE)
    const i1 = Math.round(b * RATE)
    for (let i = i0; i < i1 && i < x.length; i++) env[i] = Math.min(1, (i - i0) / fade, (i1 - i) / fade)
  }
  for (let i = 0; i < x.length; i++) x[i] *= env[i]
  return x
}
/** 長い配列の最小・最大（スプレッド構文はスタックを使い切るため使わない） */
const arrMin = (x: ArrayLike<number>) => {
  let m = Infinity
  for (let i = 0; i < x.length; i++) if (x[i] < m) m = x[i]
  return m
}
const arrMax = (x: ArrayLike<number>) => {
  let m = -Infinity
  for (let i = 0; i < x.length; i++) if (x[i] > m) m = x[i]
  return m
}
const chansOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))

// ---------------- レンダリング ----------------

interface Env {
  ctx: OfflineAudioContext
  graph: SpatialGraph
  gate: GainNode
  source: { node: AudioBufferSourceNode; gain: GainNode } | null
  /** 再生エンジンと同じ: when から offset の位置で再生（ループ区間つき） */
  start(offset: number, when: number): void
}

interface RenderOpts {
  seconds?: number
  limiter?: boolean
  trimDb?: number
  motion?: boolean
  loop?: LoopRegion | null
  modes?: ActiveSpatialMode[]
  /** 最初の再生（既定: ctx 時刻 0 から位置 0） */
  startAt?: { offset: number; when: number }
  /** ctx 時刻 t に実行する操作（OfflineAudioContext.suspend） */
  actions?: [number, (env: Env) => void][]
}

interface Rendered {
  L: Float32Array
  R: Float32Array
  probe: Float32Array | null
  graph: SpatialGraph
}

async function render(buf: AudioBuffer, params: SpatialParams, o: RenderOpts = {}): Promise<Rendered> {
  const len = Math.round((o.seconds ?? buf.duration) * RATE)
  const ctx = new OfflineAudioContext(3, len, RATE)
  await loadDynamicsWorklet(ctx)
  await loadTailWorklet(ctx)
  if (o.motion) await loadMotionWorklet(ctx)
  const loop = o.loop ?? null
  const transport: MotionTransport = { playing: true, startedAt: 0, pausedAt: 0, loopStart: loop?.start ?? 0, loopEnd: loop?.end ?? 0 }
  const graph = createSpatialGraph(ctx, {
    params,
    bypass: params.mode === 'off',
    trimDb: o.trimDb ?? 0,
    useWorklet: true,
    hrtfLatencySeconds: hrtfLatency,
    limiterEnabled: o.limiter ?? false,
    modes: o.modes ?? (params.mode === 'off' ? [] : [params.mode]),
    motion: o.motion ? { transport, envelope: null } : undefined,
  })
  const gate = new GainNode(ctx)
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 })
  const merge = new ChannelMergerNode(ctx, { numberOfInputs: 3 })
  graph.output.connect(gate).connect(split)
  split.connect(merge, 0, 0)
  split.connect(merge, 1, 1)
  graph.debug.tailGain?.connect(merge, 0, 2)
  merge.connect(ctx.destination)
  const env: Env = {
    ctx,
    graph,
    gate,
    source: null,
    start(offset, when) {
      const node = new AudioBufferSourceNode(ctx, { buffer: buf, loop: !!loop, loopStart: loop?.start ?? 0, loopEnd: loop?.end ?? 0 })
      const gain = new GainNode(ctx)
      node.connect(gain).connect(graph.input)
      node.start(when, offset)
      env.source = { node, gain }
      graph.setTransport({ ...transport, startedAt: when - offset, pausedAt: offset })
    },
  }
  env.start(o.startAt?.offset ?? 0, o.startAt?.when ?? 0)
  for (const [t, fn] of o.actions ?? []) {
    void ctx.suspend(t).then(() => {
      fn(env)
      void ctx.resume()
    })
  }
  const r = await ctx.startRendering()
  return { L: r.getChannelData(0), R: r.getChannelData(1), probe: graph.debug.tailGain ? r.getChannelData(2) : null, graph }
}

/** 再生エンジンの STOP / PAUSE / CUT と同じ操作 */
const ops = {
  stop: (e: Env) => {
    const s = e.source
    if (s) fadeOutSource(e.ctx, s.node, s.gain, STOP_FADE_SECONDS, () => s.node.disconnect())
    e.source = null
  },
  silence: (e: Env) => {
    const s = e.source
    const at = silenceOutput(e.ctx, e.gate, e.graph)
    if (s) fadeOutSource(e.ctx, s.node, s.gain, SILENCE_FADE_SECONDS, () => s.node.disconnect())
    e.source = null
    return at
  },
}

// ---------------- 測定 ----------------

const energyDb = (L: Float32Array, R: Float32Array, from: number, to: number) => {
  const a = Math.max(0, Math.round(from * RATE))
  const b = Math.min(L.length, Math.round(to * RATE))
  let e = 0
  for (let i = a; i < b; i++) e += L[i] * L[i] + R[i] * R[i]
  return 10 * Math.log10(e / Math.max(1, b - a) / 2 + 1e-30)
}
const maxAbs = (x: Float32Array, from: number, to: number) => {
  let m = 0
  for (let i = Math.max(0, Math.round(from * RATE)); i < Math.min(x.length, Math.round(to * RATE)); i++) m = Math.max(m, Math.abs(x[i]))
  return m
}
const peakOf = (xs: Float32Array[]) => xs.reduce((m, x) => Math.max(m, maxAbs(x, 0, x.length / RATE)), 0)
/** 2 区間（同じ長さ）の最大差 ÷ 全体ピーク（dB） */
function segmentDiffDb(xs: Float32Array[], a: number, b: number, len: number, ref: number): number {
  let m = 0
  const ia = Math.round(a * RATE)
  const ib = Math.round(b * RATE)
  const n = Math.round(len * RATE)
  for (const x of xs) for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(x[ia + i] - x[ib + i]))
  return 20 * Math.log10(m / ref + 1e-30)
}
function segmentEnergyRatioDb(xs: Float32Array[], a: number, b: number, len: number): number {
  let d = 0
  let e = 0
  const ia = Math.round(a * RATE)
  const ib = Math.round(b * RATE)
  const n = Math.round(len * RATE)
  for (const x of xs) {
    for (let i = 0; i < n; i++) {
      d += (x[ia + i] - x[ib + i]) ** 2
      e += x[ib + i] ** 2
    }
  }
  return 10 * Math.log10(d / (e + 1e-30) + 1e-30)
}
/**
 * 周回の一致の判定基準（実測の下限）: 同じグラフに、入力を period だけ遅らせて入れたときの出力の差（最大差 ÷ ピーク）。
 * Chrome の DelayNode は小数サンプルの遅延で時不変でない（入力をずらすと単体で −56 dB 前後の差が出る）ため、
 * HALL の初期反射を含むグラフでは周回の差がこの値より小さくならない
 */
async function timeVarianceFloorDb(sig: AudioBuffer, params: SpatialParams, period: number): Promise<number> {
  const shift = Math.round(period * RATE)
  const mk = async (s0: number) => {
    const x = toBuffer(chansOf(sig).map((c) => concat(zeros(s0 / RATE), c, zeros(3))))
    return render(x, params, { seconds: x.duration })
  }
  const a = await mk(0)
  const b = await mk(shift)
  let m = 0
  let pk = 0
  for (const [x, y] of [
    [a.L, b.L],
    [a.R, b.R],
  ]) {
    for (let i = 0; i < sig.length; i++) {
      m = Math.max(m, Math.abs(x[i] - y[i + shift]))
      pk = Math.max(pk, Math.abs(x[i]))
    }
  }
  return 20 * Math.log10(m / pk + 1e-30)
}
/** 「一致」の基準: −80 dB、ただし実測の下限がそれより大きければ下限 + 3 dB */
const sameLimit = (floor: number) => Math.max(-80, floor + 3)

/**
 * テストを実行しているブラウザ（全プロセス）の物理メモリ使用量（MB）。test:dsp の実行スクリプトが OS から測って返す。
 * ブラウザ単体で開いた場合など、測れないときは null
 */
async function browserMemoryMb(): Promise<number | null> {
  const w = window as unknown as { csxMemSample?: (id: string) => void; __csxMem?: Record<string, number | null> }
  if (!w.csxMemSample) return null
  const id = String(Math.random())
  w.csxMemSample(id)
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (w.__csxMem && id in w.__csxMem) return w.__csxMem[id]
  }
  return null
}

/** 純音のクリック指標（2 階差分の最大値 ÷ 純音として期待される値。1 前後が正常） */
function clickRatio(x: Float32Array, f: number, from: number, to: number, amp: number): number {
  let maxD2 = 0
  for (let i = Math.max(2, Math.round(from * RATE)); i < Math.min(x.length, Math.round(to * RATE)); i++) maxD2 = Math.max(maxD2, Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]))
  const w = (2 * Math.PI * f) / RATE
  return maxD2 / (amp * w * w + 1e-12)
}
function toneAmp(x: Float32Array, f: number, from: number, len: number): number {
  let re = 0
  let im = 0
  for (let i = 0; i < len && from + i < x.length; i++) {
    const w = (2 * Math.PI * f * (from + i)) / RATE
    re += x[from + i] * Math.cos(w)
    im -= x[from + i] * Math.sin(w)
  }
  return (2 * Math.hypot(re, im)) / len
}
const std = (a: number[]) => {
  const m = a.reduce((s, v) => s + v, 0) / a.length
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length)
}
const gainDbAt = (probe: Float32Array, from: number, to: number) => {
  const a = Math.round(from * RATE)
  const b = Math.round(to * RATE)
  let s = 0
  for (let i = a; i < b; i++) s += 20 * Math.log10(Math.max(probe[i], 1e-6))
  return s / (b - a)
}
/** 余韻のモノラル和の音色: 1/3 オクターブごとの「モノラル和 − 左右平均」(dB) の最大 − 最小（200 Hz〜8 kHz） */
function monoTailColorationDb(L: Float32Array, R: Float32Array, from: number): number {
  const a = Math.round(from * RATE)
  const l = L.subarray(a)
  const r = R.subarray(a)
  const m = Float32Array.from(l, (v, i) => (v + r[i]) / 2)
  const lm = thirdOctaveLevelsDb(averageSpectrum([m], RATE, 8192))
  const ll = thirdOctaveLevelsDb(averageSpectrum([l], RATE, 8192))
  const lr = thirdOctaveLevelsDb(averageSpectrum([r], RATE, 8192))
  const d: number[] = []
  THIRD_OCTAVE_CENTERS.forEach((fc, k) => {
    if (fc < 200 || fc > 8000) return
    const st = 10 * Math.log10((10 ** (ll[k] / 10) + 10 ** (lr[k] / 10)) / 2)
    d.push(lm[k] - st)
  })
  return Math.max(...d) - Math.min(...d)
}

/** ?groups=a-b で実行するグループを絞る（長い試験を分けて実行するため。省略時はすべて） */
function groupRange(): [number, number] {
  const m = /(?:^|[?&])groups=(\d+)-(\d+)/.exec(typeof location === 'undefined' ? '' : location.search)
  return m ? [Number(m[1]), Number(m[2])] : [0, Infinity]
}

export async function runTailSelfTest(): Promise<TestResult[]> {
  const [g0, g1] = groupRange()
  const want = (n: number) => n >= g0 && n <= g1
  const results: TestResult[] = []
  let group = ''
  const started = performance.now()
  let lastGroup = ''
  const check = (name: string, pass: boolean, detail: string) => {
    results.push({ group, name, pass, detail })
    console.info(`[${((performance.now() - started) / 1000).toFixed(1)}s] ${pass ? 'PASS' : 'FAIL'} ${group} / ${name} :: ${detail}`)
    // グループが変わるたびに GC を促す（多数の OfflineAudioContext の出力でヘッドレスブラウザのメモリが膨らまないように）
    if (group !== lastGroup) {
      lastGroup = group
      ;(globalThis as { gc?: () => void }).gc?.()
    }
  }
  hrtfLatency = await measureHrtfLatency(RATE)

  group = '20. Phase 04: 実行環境'
  if (want(20)) {
    const ctx = new OfflineAudioContext(1, 128, RATE)
    const ok = await loadTailWorklet(ctx)
    check('Dynamic Tail AudioWorklet の読み込み', ok, ok ? '成功' : '失敗')
    if (!ok) return results
  }

  group = '21. 既存 HALL の余韻の維持（Phase 04 前に保存したベースラインと比較）'
  if (want(21)) {
    const base = hallBaseline as { id: string; rt60: number; blocks: number[][]; report: { t20: number } }[]
    for (const c of HALL_BASELINE_CASES) {
      const ref = base.find((b) => b.id === c.id)!
      const off = await renderImpulse(c.params, 5, hrtfLatency)
      const blocks = blockEnergiesDb(off)
      const top = Math.max(...ref.blocks.flat())
      let maxD = 0
      ref.blocks.forEach((ch, ci) => ch.forEach((v, i) => v > top - 100 && (maxD = Math.max(maxD, Math.abs(v - blocks[ci][i])))))
      const t20 = analyzeTail(off.getChannelData(0), off.getChannelData(1), RATE, Math.round(IMPULSE_AT * RATE)).t20
      check(
        `${c.id}: Tail OFF の HALL がベースラインと一致（10 ms ごとのエネルギー差 ≤ 0.01 dB・T20 差 ≤ 1%）`,
        maxD <= 0.01 && Math.abs(t20 / ref.report.t20 - 1) <= 0.01,
        `最大差 ${maxD.toFixed(4)} dB、T20 ${f2(t20)} s（ベースライン ${f2(ref.report.t20)} s）`,
      )
      const nat = await renderImpulse({ ...c.params, tailMode: 'natural' }, 5, hrtfLatency)
      let m = 0
      let pk = 0
      for (let ch = 0; ch < 2; ch++) {
        const x = nat.getChannelData(ch)
        const y = off.getChannelData(ch)
        for (let i = 0; i < x.length; i++) {
          m = Math.max(m, Math.abs(x[i] - y[i]))
          pk = Math.max(pk, Math.abs(y[i]))
        }
      }
      const d = 20 * Math.log10(m / pk + 1e-30)
      check(`${c.id}: NATURAL（LENGTH/INTENSITY 50）= 既存 HALL（差 ≤ −120 dB、再レンダリングの揺らぎ −155 dB 前後）`, d <= -120, `差 ${f1(d)} dB（ピーク比）`)
    }
    const p = hall()
    const t = tailSettings({ ...p, tailMode: 'natural' })
    const h = hallSettings(p)
    check('NATURAL 50/50 の設定値 = HALL の後期残響', t.rt60 === h.rt60 && t.gainDb === h.lateGainDb && t.preDelayMs === h.preDelayMs, `RT60 ${t.rt60}/${h.rt60}、レベル ${t.gainDb}/${h.lateGainDb} dB、プリディレイ ${t.preDelayMs}/${h.preDelayMs} ms`)
  }

  // インパルス応答（HALL 既定値の部屋）で各 Tail を測る
  const tailIr = async (patch: Partial<SpatialParams>) => {
    const b = await renderImpulse(hall(patch), 7, hrtfLatency)
    return { L: b.getChannelData(0), R: b.getChannelData(1), r: analyzeTail(b.getChannelData(0), b.getChannelData(1), RATE, Math.round(IMPULSE_AT * RATE)) }
  }
  const natural = await tailIr({ tailMode: 'natural' })
  const win = (r: typeof natural.r, from: number) => r.windows.find((w) => w.from === from)!

  group = '22. NATURAL TAIL の減衰'
  if (want(22)) {
    const short = await tailIr({ tailMode: 'natural', tailLength: 0 })
    const long = await tailIr({ tailMode: 'natural', tailLength: 100 })
    const a = short.r.t20 / natural.r.t20
    const b = long.r.t20 / natural.r.t20
    check('TAIL LENGTH 0 / 100 で残響時間が ½ / 2 倍（T20 比 0.42〜0.58 / 1.7〜2.3）', a >= 0.42 && a <= 0.58 && b >= 1.7 && b <= 2.3, `T20 ${f2(short.r.t20)} / ${f2(natural.r.t20)} / ${f2(long.r.t20)} s（比 ${f2(a)} / ${f2(b)}）`)
    const lo = natural.r.bandT20.find((x) => x.fc === 250)!.t20
    const hi = natural.r.bandT20.find((x) => x.fc === 8000)!.t20
    check('周波数別の減衰（8 kHz の T20 ≤ 250 Hz の 92%）', hi <= lo * 0.92, `250 Hz ${f2(lo)} s / 8 kHz ${f2(hi)} s`)
    const iaccs = [0.2, 0.5].map((f) => win(natural.r, f).iacc)
    check('ステレオ残響（200 ms 以降の IACC ≤ 0.2）', iaccs.every((v) => v <= 0.2), iaccs.map(f2).join(' / '))

    // 蓄積防止（ワークレット単体）: 残響の戻りが原音より大きいと抑え、小さいときと停止後の余韻はゲイン 1 のまま
    const guard = async (wetDb: number, tailOnly: boolean) => {
      const sec = 6
      const ctx = new OfflineAudioContext(3, sec * RATE, RATE)
      await loadTailWorklet(ctx)
      const opts: TailWorkletOptions = { dynamic: false, duckDb: 8, guardMarginDb: 3, reportIntervalMs: 0 }
      const node = new AudioWorkletNode(ctx, 'csx-tail', { numberOfInputs: 2, numberOfOutputs: 2, outputChannelCount: [2, 1], channelCount: 2, channelCountMode: 'explicit', processorOptions: opts })
      const dry = concat(noise(3, 5, 0.2), zeros(3))
      const g = Math.pow(10, wetDb / 20)
      // 残響の戻り: 原音と無相関のノイズ。tailOnly では原音が止まった後に戻りだけが減衰しながら続く
      const wet = Float32Array.from(noise(sec, 9, 0.2), (v, i) => v * g * (i < 3 * RATE ? 1 : tailOnly ? Math.exp(-(i - 3 * RATE) / (0.6 * RATE)) : 0))
      const sD = new AudioBufferSourceNode(ctx, { buffer: toBuffer([dry, dry]) })
      const sW = new AudioBufferSourceNode(ctx, { buffer: toBuffer([wet, wet]) })
      sW.connect(node, 0, 0)
      sD.connect(node, 0, 1)
      const merge = new ChannelMergerNode(ctx, { numberOfInputs: 3 })
      const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 })
      node.connect(split, 0)
      split.connect(merge, 0, 0)
      split.connect(merge, 1, 1)
      node.connect(merge, 1, 2)
      merge.connect(ctx.destination)
      sD.start()
      sW.start()
      const r = await ctx.startRendering()
      const out = r.getChannelData(0)
      const probe = r.getChannelData(2)
      // 停止後の出力が 50 ms ごとに単調に減る（抑制の解除で余韻が持ち上がらない）か
      const steps = Array.from({ length: 50 }, (_, k) => energyDb(out, out, 3 + k * 0.05, 3.05 + k * 0.05))
      const rises = steps.slice(1).map((v, k) => v - steps[k])
      return { outDb: energyDb(out, out, 2, 3) - energyDb(dry, dry, 2, 3), minAfter: arrMin(probe.subarray(3.05 * RATE)), probeEnd: probe[probe.length - 1], probeMin: arrMin(probe), maxRise: Math.max(...rises) }
    }
    const loud = await guard(6, false)
    check('蓄積防止: 残響の戻りが原音 +6 dB → 原音 −3 dB 付近まで抑える（−4.5〜−1.5 dB）', loud.outDb >= -4.5 && loud.outDb <= -1.5, `抑制後の戻り ${f1(loud.outDb)} dB（原音比）`)
    const quiet = await guard(-10, true)
    check('蓄積防止: 原音より 10 dB 小さい戻り・停止後の余韻ではゲイン 1 のまま', quiet.probeMin === 1, `最小ゲイン ${quiet.probeMin}`)
    const after = await guard(6, true)
    check('蓄積防止: 停止後（原音が無音）は抑制を戻し、余韻を抑え続けない（終端のゲイン ≥ 0.9）', after.probeEnd >= 0.9, `終端のゲイン ${after.probeEnd.toFixed(3)}`)
    check('蓄積防止: 抑制の解除中も停止後の余韻は持ち上がらない（50 ms ごとのレベルが増えない、+0.1 dB 以内）', after.maxRise <= 0.1, `最大の増加 ${f2(after.maxRise)} dB`)
  }

  group = '23. DISTANCE TAIL の距離変化（NATURAL と同じ部屋で比較）'
  if (want(23)) {
    const d = await tailIr({ tailMode: 'distance' })
    const t = d.r.t20 / natural.r.t20
    check('減衰の速さは NATURAL と同程度（T20 比 0.85〜1.15）', t >= 0.85 && t <= 1.15, `T20 ${f2(d.r.t20)} s（NATURAL ${f2(natural.r.t20)} s）`)
    const cD = win(d.r, 1).centroidHz
    const cN = win(natural.r, 1).centroidHz
    check('高域減衰: 1〜2 秒のスペクトル重心が NATURAL の 75% 以下', cD <= cN * 0.75, `${cD.toFixed(0)} Hz（NATURAL ${cN.toFixed(0)} Hz）`)
    const nar = win(d.r, 1).sideToMidDb - win(d.r, 0.05).sideToMidDb
    const narN = win(natural.r, 1).sideToMidDb - win(natural.r, 0.05).sideToMidDb
    check('広がりが時間とともに狭まる（S/M 比 −6 dB 以上の減少、NATURAL は ±2 dB 以内）', nar <= -6 && Math.abs(narN) <= 2, `S/M 変化 ${f1(nar)} dB（NATURAL ${f1(narN)} dB）`)
    const iD = win(d.r, 1).iacc
    check('遠い一点へまとまる（1〜2 秒の IACC ≥ 0.4、NATURAL ≤ 0.2）', iD >= 0.4 && win(natural.r, 1).iacc <= 0.2, `IACC ${f2(iD)}（NATURAL ${f2(win(natural.r, 1).iacc)}）`)
    const levels = d.r.windows.map((w) => w.levelDb)
    const mono = levels.every((v, i) => i === 0 || v < levels[i - 1])
    const dev = Math.max(...d.r.windows.slice(0, 5).map((w, i) => Math.abs(w.levelDb - natural.r.windows[i].levelDb)))
    check('急な音量変化なし（各時間窓のレベルが単調に減少し、NATURAL との差 ≤ 6 dB）', mono && dev <= 6, `レベル ${levels.map((v) => v.toFixed(1)).join(' / ')} dB、NATURAL との最大差 ${f1(dev)} dB`)
  }

  group = '24. RIPPLE TAIL の空間変化'
  if (want(24)) {
    const rp = await tailIr({ tailMode: 'ripple' })
    const early = win(rp.r, 0.05)
    const late = win(rp.r, 1)
    check('中央から始まり拡散する（50–200 ms の IACC ≥ 0.5 → 1–2 秒 ≤ 0.25）', early.iacc >= 0.5 && late.iacc <= 0.25, `IACC ${rp.r.windows.map((w) => f2(w.iacc)).join(' → ')}`)
    check('左右へ広がる（S/M 比が 6 dB 以上増加）', late.sideToMidDb - early.sideToMidDb >= 6, `S/M ${rp.r.windows.map((w) => f1(w.sideToMidDb)).join(' → ')} dB`)
    const t = rp.r.t20 / natural.r.t20
    check('全体の減衰は NATURAL と同程度（T20 比 0.85〜1.15）', t >= 0.85 && t <= 1.15, `T20 ${f2(rp.r.t20)} s`)
    for (const [label, ir] of [['NATURAL', natural], ['DISTANCE', await tailIr({ tailMode: 'distance' })], ['RIPPLE', rp]] as const) {
      const c = monoTailColorationDb(ir.L, ir.R, IMPULSE_AT + 0.05)
      check(`${label}: 余韻のモノラル和に極端な位相干渉なし（1/3 oct の「モノラル − 左右平均」の幅 ≤ 4 dB）`, c <= 4, `${f1(c)} dB`)
    }
  }

  group = '25. DYNAMIC TAIL（演奏の密度に追従）'
  if (want(25)) {
    // 0.6 秒の音 → 1.4 秒の切れ目 × 4
    const bursts: [number, number][] = [
      [0.5, 1.1],
      [2.5, 3.1],
      [4.5, 5.1],
      [6.5, 7.1],
    ]
    const sig = toBuffer([gated(8.6, bursts, 3), gated(8.6, bursts, 4)])
    const on = await render(sig, hall({ tailMode: 'natural', dynamicTail: true }))
    const off = await render(sig, hall({ tailMode: 'natural', dynamicTail: false }))
    const pr = on.probe!
    const duck = bursts.map(([a, b]) => gainDbAt(pr, a + 0.15, b))
    const attack = bursts.map(([a]) => gainDbAt(pr, a + 0.055, a + 0.065))
    const held = bursts.map(([, b]) => gainDbAt(pr, b + 0.09, b + 0.1))
    const bloom = bursts.map(([, b]) => gainDbAt(pr, b + 0.45, b + 0.5))
    const back = bursts.map(([, b]) => gainDbAt(pr, b + 0.9, b + 1.2))
    check('演奏中は残響を下げる（音の途中の平均 ≤ −5 dB）', duck.every((v) => v <= -5), duck.map(f1).join(' / ') + ' dB')
    check('次の音が始まったら速やかに下げる（立ち上がり 60 ms 後 ≤ −4 dB）', attack.every((v) => v <= -4), attack.map(f1).join(' / ') + ' dB')
    check('Hold: 音が止まって 100 ms はまだ戻さない（≤ −4 dB）', held.every((v) => v <= -4), held.map(f1).join(' / ') + ' dB')
    check('切れ目で余韻が広がり始める（切れ目の 0.45 秒で ≥ −5 dB）', bloom.every((v) => v >= -5), bloom.map(f1).join(' / ') + ' dB')
    check('音の切れ目で設定レベルへ戻す（切れ目の 0.9〜1.2 秒 ≥ −1 dB）', back.every((v) => v >= -1), back.map(f1).join(' / ') + ' dB')
    const maxG = arrMax(pr)
    check('設定レベルより大きくしない（ゲイン ≤ 1）', maxG <= 1 + 1e-6, `最大 ${maxG.toFixed(6)}`)
    let maxStep = 0
    for (let i = 1; i < pr.length; i++) maxStep = Math.max(maxStep, Math.abs(pr[i] - pr[i - 1]))
    check('ゲインの変化は滑らか（1 サンプルあたり ≤ 0.003）', maxStep <= 0.003, `最大 ${maxStep.toExponential(2)}`)
    const tailOn = bursts.map(([, b]) => energyDb(on.L, on.R, b + 0.9, b + 1.3))
    const tailOff = bursts.map(([, b]) => energyDb(off.L, off.R, b + 0.9, b + 1.3))
    const dd = tailOn.map((v, i) => v - tailOff[i])
    check('切れ目の余韻は Dynamic OFF と同程度（−3〜+0.5 dB、突然の増幅なし）', dd.every((v) => v >= -3 && v <= 0.5), dd.map(f1).join(' / ') + ' dB')
    check('Dynamic OFF ではゲインが常に 1', arrMin(off.probe!) === 1 && arrMax(off.probe!) === 1, `最小 ${arrMin(off.probe!)} / 最大 ${arrMax(off.probe!)}`)

    const steady = await render(toBuffer([noise(5, 7, 0.2), noise(5, 8, 0.2)]), hall({ tailMode: 'natural', dynamicTail: true }))
    const sdb = Array.from({ length: 30 }, (_, k) => gainDbAt(steady.probe!, 1.5 + k * 0.1, 1.6 + k * 0.1))
    check('ポンピングなし: 定常ノイズでゲインの揺れ（標準偏差）≤ 0.5 dB', std(sdb) <= 0.5, `${f2(std(sdb))} dB（平均 ${f1(sdb.reduce((s, v) => s + v, 0) / sdb.length)} dB）`)
    const rhythm: [number, number][] = Array.from({ length: 20 }, (_, k) => [0.25 + k * 0.25, 0.25 + k * 0.25 + 0.17])
    const rh = await render(toBuffer([gated(5.5, rhythm, 11), gated(5.5, rhythm, 12)]), hall({ tailMode: 'natural', dynamicTail: true }))
    const rdb = Array.from({ length: 70 }, (_, k) => gainDbAt(rh.probe!, 1.5 + k * 0.05, 1.55 + k * 0.05))
    const range = Math.max(...rdb) - Math.min(...rdb)
    check('リズムの細かい隙間（80 ms）では戻さない: ゲインの変動幅 ≤ 3 dB', range <= 3, `${f1(range)} dB`)
  }

  group = '26. STOP 後の余韻（直接音 12 ms フェード、反射音・残響は残す）'
  if (want(26)) {
    const mix = programStereoMix(2.5)
    const pad = (b: AudioBuffer, sec: number) => toBuffer(chansOf(b).map((x) => concat(x, zeros(sec))))
    const sig = pad(mix, 4)
    for (const [label, params] of [
      ['HALL（Tail OFF = 既存）', hall()],
      ['HALL × NATURAL', hall({ tailMode: 'natural' })],
      ['HALL × DISTANCE', hall({ tailMode: 'distance' })],
      ['CINEMA × RIPPLE', { ...DEFAULT_SPATIAL_PARAMS, mode: 'cinema', tailMode: 'ripple' } as SpatialParams],
    ] as const) {
      const st = await render(sig, params, { actions: [[2.0, ops.stop]] })
      // 比較: STOP の代わりに音源がその時刻で途切れた場合（Phase 03 までの停止と同じ = 余韻はそのまま鳴る）
      const cutSrc = toBuffer(chansOf(mix).map((x) => concat(x.subarray(0, 2 * RATE), zeros(4.5))))
      const ref = await render(cutSrc, params)
      const tS = stopDecaySeconds(new AudioBufferLike(st), 2.0)
      const tR = stopDecaySeconds(new AudioBufferLike(ref), 2.0)
      check(`${label}: 余韻が残る（−60 dB まで ≥ 1 秒、従来の停止との差 ≤ 10%）`, tS >= 1 && Math.abs(tS / tR - 1) <= 0.1, `${ms(tS)}（従来 ${ms(tR)}）`)
    }
    const off = await render(sig, { ...DEFAULT_SPATIAL_PARAMS, mode: 'off' }, { actions: [[2.0, ops.stop]] })
    const rest = Math.max(maxAbs(off.L, 2.0 + STOP_FADE_SECONDS + 0.006, 6), maxAbs(off.R, 2.0 + STOP_FADE_SECONDS + 0.006, 6))
    check('直接音は 12 ms で止まる（空間処理 OFF で停止 18 ms 後から完全に無音）', rest === 0, `最大振幅 ${rest}`)
    const tone = toBuffer([concat(sine(440, 0.3, 2.5), zeros(1)), concat(sine(440, 0.3, 2.5), zeros(1))])
    const toneStop = await render(tone, { ...DEFAULT_SPATIAL_PARAMS, mode: 'off' }, { actions: [[2.0, ops.stop]] })
    const cr = clickRatio(toneStop.L, 440, 1.9, 2.1, 0.3)
    const abrupt = await render(toBuffer([concat(sine(440, 0.3, 2.0), zeros(1.5)), concat(sine(440, 0.3, 2.0), zeros(1.5))]), { ...DEFAULT_SPATIAL_PARAMS, mode: 'off' })
    check('STOP でクリックなし（440 Hz の 2 階差分比 ≤ 1.5）', cr <= 1.5, `${f2(cr)}（フェードなしで途切れた場合 ${f2(clickRatio(abrupt.L, 440, 1.9, 2.1, 0.3))}）`)
  }

  group = '27. PAUSE（出力 20 ms で停止・残響を消去・同じ位置から再開）'
  if (want(27)) {
    const mix = programStereoMix(5)
    let resumeAt = 0
    const paused = await render(mix, hall({ tailMode: 'natural' }), {
      seconds: 5,
      actions: [
        [1.5, (e) => void ops.silence(e)],
        [
          2.0,
          (e) => {
            resumeAt = restoreOutput(e.ctx, e.gate, 1.5 + SILENCE_FADE_SECONDS)
            e.start(1.5, resumeAt)
          },
        ],
      ],
    })
    const quiet = Math.max(maxAbs(paused.L, 1.5 + SILENCE_FADE_SECONDS + 0.003, resumeAt), maxAbs(paused.R, 1.5 + SILENCE_FADE_SECONDS + 0.003, resumeAt))
    check('PAUSE 後は無音（直接音・余韻とも、20 ms 後から再開まで）', quiet <= 1e-6, `最大振幅 ${quiet.toExponential(2)}`)
    // 比較: 1.5 秒の位置から新しく再生した場合（前の残響なし）。再開後の音が一致すれば、前の残響が消えていて位置も同じ
    const fresh = await render(mix, hall({ tailMode: 'natural' }), { seconds: 5, startAt: { offset: 1.5, when: resumeAt } })
    const pk = peakOf([fresh.L, fresh.R])
    let m = 0
    for (const [x, y] of [
      [paused.L, fresh.L],
      [paused.R, fresh.R],
    ]) {
      for (let i = Math.round((resumeAt + 0.01) * RATE); i < Math.round((resumeAt + 2) * RATE); i++) m = Math.max(m, Math.abs(x[i] - y[i]))
    }
    const d = 20 * Math.log10(m / pk + 1e-30)
    check('再開後は同じ位置から・前の残響なし（新規再生との差 ≤ −60 dB）', d <= -60, `差 ${f1(d)} dB（再開 ${f2(resumeAt)} 秒 = PAUSE の ${ms(resumeAt - 1.5)} 後）`)
    const tone = toBuffer([sine(440, 0.3, 3), sine(440, 0.3, 3)])
    const tp = await render(tone, { ...DEFAULT_SPATIAL_PARAMS, mode: 'off' }, { actions: [[1.5, (e) => void ops.silence(e)]] })
    const cr = clickRatio(tp.L, 440, 1.4, 1.6, 0.3)
    check('PAUSE でクリックなし（440 Hz の 2 階差分比 ≤ 1.5）', cr <= 1.5, f2(cr))

    // Motion の時間軸: PAUSE → 再開後の動きが、同じ位置から新しく再生した場合と一致する
    const leftNoise = toBuffer([noise(6, 21, 0.25), zeros(6)])
    const mo = { ...DEFAULT_SPATIAL_PARAMS, mode: 'cinema', motionEnabled: true, motionPreset: 'sweep', motionSpeed: 80, motionDepth: 100, intensity: 0, depth: 0 } as SpatialParams
    let ra = 0
    const pm = await render(leftNoise, mo, {
      motion: true,
      seconds: 6,
      actions: [
        [
          2.0,
          (e) => {
            void ops.silence(e)
            e.graph.setTransport({ playing: false, startedAt: 0, pausedAt: 2.0 })
          },
        ],
        [
          2.5,
          (e) => {
            ra = restoreOutput(e.ctx, e.gate, 2.0 + SILENCE_FADE_SECONDS)
            e.start(2.0, ra)
          },
        ],
      ],
    })
    // 比較: 同じ ctx 時刻から 2.0 秒の位置を新しく再生した場合
    const fm = await render(leftNoise, mo, { motion: true, seconds: 6, startAt: { offset: 2.0, when: ra } })
    const ild = (r: Rendered, t: number) => linearToDb(Math.sqrt(energyLin(r.R, t, t + 0.1) / energyLin(r.L, t, t + 0.1)))
    const diffs = Array.from({ length: 20 }, (_, k) => {
      const t = ra + 0.3 + k * 0.1
      return ild(pm, t) - ild(fm, t)
    })
    check('PAUSE → 再開後の Motion の位置が再開位置の時刻と一致（ILD 差 ≤ 1 dB）', diffs.every((v) => Math.abs(v) <= 1), `最大 ${f2(Math.max(...diffs.map(Math.abs)))} dB`)
  }

  group = '28. CUT（直接音・余韻とも 20 ms で停止）'
  if (want(28)) {
    const mix = toBuffer(chansOf(programStereoMix(2.5)).map((x) => concat(x, zeros(3))))
    const c1 = await render(mix, hall({ tailMode: 'natural' }), { actions: [[1.5, (e) => void ops.silence(e)]] })
    const q1 = Math.max(maxAbs(c1.L, 1.5 + SILENCE_FADE_SECONDS + 0.003, 5.5), maxAbs(c1.R, 1.5 + SILENCE_FADE_SECONDS + 0.003, 5.5))
    check('再生中の CUT: 20 ms 後から無音', q1 <= 1e-6, `最大振幅 ${q1.toExponential(2)}`)
    const c2 = await render(mix, hall(), { actions: [[1.5, ops.stop], [1.9, (e) => void ops.silence(e)]] })
    const ringing = energyDb(c2.L, c2.R, 1.6, 1.9) - energyDb(c2.L, c2.R, 1.0, 1.5)
    const q2 = Math.max(maxAbs(c2.L, 1.9 + SILENCE_FADE_SECONDS + 0.003, 5.5), maxAbs(c2.R, 1.9 + SILENCE_FADE_SECONDS + 0.003, 5.5))
    check('STOP 後に鳴っている余韻を CUT で止める（HALL 既存の余韻も 20 ms 後から無音）', q2 <= 1e-6 && ringing > -60, `CUT 前の余韻 ${f1(ringing)} dB（演奏中比）、CUT 後の最大振幅 ${q2.toExponential(2)}`)
  }

  // ---------------- ループ ----------------
  const loopRender = async (sig: AudioBuffer, params: SpatialParams, type: 'normal' | 'spatial', passes: number, extra: RenderOpts = {}) => {
    const region = loopBounds(type, musicRegion(chansOf(sig), RATE), sig.duration)
    const period = region.end - region.start
    const boundaries = Array.from({ length: passes - 1 }, (_, k) => region.end + k * period)
    // 境界ごとに GC を促す（オフラインでは置き換えた畳み込みがレンダリング中に回収されず、ヘッドレスブラウザのメモリが膨らむため。
    // 実時間の再生では古い組はフェード後 0.15 秒で切り離され、通常の GC で回収される）
    const gc = () => (globalThis as { gc?: () => void }).gc?.()
    const actions: [number, (e: Env) => void][] = boundaries.map(
      (tb) =>
        [
          tb - 0.2,
          (e: Env) => {
            if (type === 'normal') e.graph.resetReverb(tb, NORMAL_LOOP_RESET_FADE_SECONDS)
            gc()
          },
        ] as [number, (e: Env) => void],
    )
    const r = await render(sig, params, { ...extra, loop: region, seconds: region.end + (passes - 1) * period, actions: [...actions, ...(extra.actions ?? [])] })
    return { r, region, period, boundaries }
  }

  group = '29. NORMAL LOOP（境界で前回の残響を 80 ms で消し、毎回同じ状態から）'
  if (want(29)) {
    const sig = programStereoMix(2)
    const { r, boundaries, period } = await loopRender(sig, hall({ tailMode: 'natural' }), 'normal', 5)
    const pk = peakOf([r.L, r.R])
    // 境界では入力を 10 ms で新しい畳み込みへ受け渡すため、2 周目以降は互いに一致し（毎回同じ状態）、
    // 1 周目（無音から始まる）とは境界付近 10 ms の音の残響の分だけ異なる
    const same = boundaries.slice(1).map((tb) => segmentDiffDb([r.L, r.R], boundaries[0], tb, period - 0.01, pk))
    const floor = await timeVarianceFloorDb(sig, hall({ tailMode: 'natural' }), period)
    check(
      `3 周目以降が 2 周目と一致（毎回同じ状態から、差 ≤ ${f1(sameLimit(floor))} dB = 実測の下限 ${f1(floor)} dB + 3 dB）`,
      same.every((v) => v <= sameLimit(floor)),
      same.map(f1).join(' / ') + ' dB',
    )
    const prev = boundaries.map((tb) => segmentEnergyRatioDb([r.L, r.R], tb + 0.12, 0.12, period - 0.13))
    check('前回の残響が残らない（境界 0.12 秒以降の 1 周目との差のエネルギー比 ≤ −30 dB。SPATIAL LOOP では約 −15 dB）', prev.every((v) => v <= -30), prev.map(f1).join(' / ') + ' dB')
    check('畳み込みの組が増え続けない（4 回の消去後 ≤ 3 組）', r.graph.debug.reverbSlots() <= 3, `${r.graph.debug.reverbSlots()} 組`)
    const tr: MotionTransport = { playing: true, startedAt: 10, pausedAt: 0, loopStart: 0, loopEnd: 2 }
    const ok = [
      [11.999, 1.999],
      [12.0, 0],
      [12.5, 0.5],
      [16.25, 0.25],
    ].every(([t, m]) => Math.abs(transportTime(tr, t) - m) < 1e-9)
    check('メディア時刻がループ区間で折り返す（Motion・再生位置の共通関数）', ok, `t=12.0 → ${transportTime(tr, 12)}、t=16.25 → ${transportTime(tr, 16.25)}`)
    // Motion の時間軸: ループ 2 周目の動き（左だけのノイズの ILD）が 1 周目と同じ
    const left = toBuffer([noise(3, 33, 0.25), zeros(3)])
    const mo = { ...DEFAULT_SPATIAL_PARAMS, mode: 'cinema', motionEnabled: true, motionPreset: 'sweep', motionSpeed: 70, motionDepth: 100, intensity: 0, depth: 0 } as SpatialParams
    const ml = await loopRender(left, mo, 'normal', 2, { motion: true })
    // ループ境界で位置は 0.15 秒の平滑化で新しい位置へ移るため、境界から 0.7 秒以降で比べる
    const d = Array.from({ length: 20 }, (_, k) => {
      const t = 0.7 + k * 0.1
      const a = linearToDb(Math.sqrt(energyLin(ml.r.R, t, t + 0.1) / energyLin(ml.r.L, t, t + 0.1)))
      const b = linearToDb(Math.sqrt(energyLin(ml.r.R, t + 3, t + 3.1) / energyLin(ml.r.L, t + 3, t + 3.1)))
      return a - b
    })
    check('Motion の動きもループする（2 周目の ILD が 1 周目と一致、差 ≤ 1 dB）', d.every((v) => Math.abs(v) <= 1), `最大 ${f2(Math.max(...d.map(Math.abs)))} dB`)
  }

  group = '30. SPATIAL LOOP（前回の余韻を残して次の冒頭を重ねる）'
  if (want(30)) {
    const music = programStereoMix(1.6)
    const sig = toBuffer(chansOf(music).map((x) => concat(zeros(0.3), x, zeros(1.1))))
    const region = musicRegion(chansOf(sig), RATE)
    check('音楽の区間を検出（先頭 0.3 秒・末尾 1.1 秒の無音を除く、誤差 ≤ 10 ms + 余裕）', !!region && Math.abs(region.start - 0.295) <= 0.01 && Math.abs(region.end - 1.92) <= 0.01, region ? `${region.start.toFixed(3)}〜${region.end.toFixed(3)} 秒` : 'なし')
    const passes = 8
    const sp = await loopRender(sig, hall({ tailMode: 'natural' }), 'spatial', passes)
    const nl = await loopRender(sig, hall({ tailMode: 'natural' }), 'normal', 3)
    const b0 = sp.boundaries[0]
    // 重なり: 2 周目の冒頭 0.5 秒には前回の余韻が入っている（1 周目の同じ区間との差のエネルギー比）
    const overlap = segmentEnergyRatioDb([sp.r.L, sp.r.R], b0, sp.region.start, 0.5)
    check('前回の余韻と次の冒頭が重なる（冒頭 0.5 秒の差のエネルギー ≥ −30 dB）', overlap >= -30, `${f1(overlap)} dB（NORMAL LOOP では境界でリセット）`)
    const irLen = tailSettings(hall({ tailMode: 'natural' })).rt60 * 1.3
    const k0 = Math.ceil(irLen / sp.period) + 1
    const pk = peakOf([sp.r.L, sp.r.R])
    const steady = sp.boundaries.slice(k0).map((tb) => segmentDiffDb([sp.r.L, sp.r.R], sp.boundaries[k0 - 1], tb, sp.period - 0.01, pk))
    const floor = await timeVarianceFloorDb(toBuffer(chansOf(sig).map((x) => x.subarray(Math.round(sp.region.start * RATE), Math.round(sp.region.end * RATE)))), hall({ tailMode: 'natural' }), sp.period)
    check(
      `残響が蓄積し続けない（${k0 + 1} 周目以降は毎回同じ、差 ≤ ${f1(sameLimit(floor))} dB = 実測の下限 ${f1(floor)} dB + 3 dB）`,
      steady.length > 0 && steady.every((v) => v <= sameLimit(floor)),
      steady.map(f1).join(' / ') + ' dB',
    )
    const loud = sp.boundaries.slice(1).map((tb) => integratedLoudness([sp.r.L.subarray(tb * RATE, (tb + sp.period) * RATE), sp.r.R.subarray(tb * RATE, (tb + sp.period) * RATE)], RATE))
    const spread = Math.max(...loud) - Math.min(...loud)
    check('ループごとの音量が増えない（3 周目以降のラウドネスの幅 ≤ 0.2 LU）', spread <= 0.2, loud.map(f1).join(' / ') + ' LUFS')
    const nlOverlap = segmentEnergyRatioDb([nl.r.L, nl.r.R], nl.boundaries[0] + 0.12, nl.region.start + 0.12, 0.5)
    check('比較: NORMAL LOOP は境界 0.12 秒以降に前回の余韻がない（1 周目との差のエネルギー比 ≤ −30 dB）', nlOverlap <= -30, `${f1(nlOverlap)} dB`)
  }

  group = '31. ループ境界のクリックノイズ（境界で連続する 440 Hz）'
  if (want(31)) {
    const tone = toBuffer([sine(440, 0.3, 2), sine(440, 0.3, 2)])
    for (const type of ['normal', 'spatial'] as const) {
      for (const params of [hall({ tailMode: 'natural' }), hall()]) {
        const { r, boundaries } = await loopRender(tone, params, type, 4)
        const crs = boundaries.map((tb) => clickRatio(r.L, 440, tb - 0.05, tb + 0.1, Math.max(maxAbs(r.L, tb - 0.3, tb - 0.05), 1e-9)))
        check(`${type.toUpperCase()} LOOP × HALL ${params.tailMode === 'off' ? '（Tail OFF）' : '× NATURAL'}: 境界でクリックなし（2 階差分比 ≤ 1.5）`, crs.every((v) => v <= 1.5), crs.map(f2).join(' / '))
      }
    }
  }

  group = '32. 長時間ループの安定性（2 秒 × 30 周 = 60 秒）'
  if (want(32)) {
    const sig = programStereoMix(2)
    const params = hall({ tailMode: 'ripple', dynamicTail: true })
    const floor = await timeVarianceFloorDb(sig, params, 2)
    const scenario = async (type: 'normal' | 'spatial') => {
      const { r, boundaries, period } = await loopRender(sig, params, type, 30)
      const pk = peakOf([r.L, r.R])
      const last = boundaries[boundaries.length - 1]
      const d = segmentDiffDb([r.L, r.R], boundaries[3], last, period - 0.01, pk)
      const finite = ![r.L, r.R].some((x) => x.some((v) => !Number.isFinite(v)))
      const pFirst = Math.max(maxAbs(r.L, boundaries[3], boundaries[4]), maxAbs(r.R, boundaries[3], boundaries[4]))
      const pLast = Math.max(maxAbs(r.L, last, last + period), maxAbs(r.R, last, last + period))
      check(
        `${type.toUpperCase()}: 30 周目が 5 周目と同じ（差 ≤ ${f1(sameLimit(floor))} dB = 実測の下限 + 3 dB）・ピーク変化 ≤ 0.1 dB・NaN なし・畳み込み ≤ 3 組`,
        d <= sameLimit(floor) && Math.abs(linearToDb(pLast / pFirst)) <= 0.1 && finite && r.graph.debug.reverbSlots() <= 3,
        `差 ${f1(d)} dB、ピーク ${f2(linearToDb(pFirst))} → ${f2(linearToDb(pLast))} dBFS、${r.graph.debug.reverbSlots()} 組`,
      )
    }
    for (const type of ['normal', 'spatial'] as const) await scenario(type)
  }

  group = '32b. 実時間の再生エンジンでの長時間ループ（2 秒の音源 × 約 60 秒、メモリ・ノード数・再生位置）'
  if (want(32)) {
    // メモリは実時間の再生エンジン（AudioEngine）で測る。オフラインの文脈は Chrome が AudioWorklet を読み込んだ
    // OfflineAudioContext を解放しないため（ブラウザの挙動）、ループ処理そのもののメモリを測れない
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))
    const engine = new AudioEngine(0)
    try {
      engine.setSpatialParams(hall({ tailMode: 'ripple', dynamicTail: true }))
      engine.setLoop(true, 'normal')
      engine.setBuffer(programStereoMix(2))
      await engine.play()
      const positions: number[] = []
      const slots: number[] = []
      const watch = async (ms: number) => {
        for (let t = 0; t < ms; t += 500) {
          await sleep(500)
          positions.push(engine.getPosition())
          slots.push(engine.debugReverbSlots())
        }
      }
      await watch(8000)
      const m1 = await browserMemoryMb()
      await watch(22000)
      const mN = await browserMemoryMb()
      engine.setLoop(true, 'spatial')
      await watch(30000)
      const m2 = await browserMemoryMb()
      console.info('MEMPHASE', m1, mN, m2)
      const wraps = positions.slice(1).filter((p, i) => p < positions[i]).length
      check(
        'NORMAL → SPATIAL LOOP で 60 秒再生し続ける（再生位置が 0〜2 秒で折り返し、止まらない）',
        positions.every((p) => p >= 0 && p <= 2) && wraps >= 20,
        `折り返し ${wraps} 回、位置の範囲 ${Math.min(...positions).toFixed(2)}〜${Math.max(...positions).toFixed(2)} 秒`,
      )
      check('畳み込みの組が増え続けない（実時間で古い組を切り離す、常に ≤ 3 組）', Math.max(...slots) <= 3, `最大 ${Math.max(...slots)} 組`)
      if (m1 === null || m2 === null) {
        check('メモリ: 約 50 秒のループ再生でブラウザのメモリ増加 ≤ 50 MB', false, '未実行: ブラウザのメモリを測れない環境（npm run test:spatial / --suite=tail で実行してください）')
      } else {
        check('メモリ: 約 50 秒のループ再生（境界 25 回の残響消去を含む）でブラウザのメモリ増加 ≤ 50 MB', m2 - m1 <= 50, `${m1.toFixed(0)} → ${m2.toFixed(0)} MB（${f1(m2 - m1)} MB）`)
      }
    } finally {
      engine.dispose()
    }
  }

  group = '33. Motion と Tail の同時使用（ステレオミックス、ラウドネス合わせ・リミッター ON）'
  if (want(33)) {
    const mix = programStereoMix(8)
    const before = stereoMetrics(chansOf(mix), RATE)
    const ex = buildSpatialExcerpt(mix)
    const src = await analyzeSpatialSource(ex)
    for (const params of [
      { ...DEFAULT_SPATIAL_PARAMS, mode: 'cinema', motionEnabled: true, motionPreset: 'orbit', tailMode: 'distance', dynamicTail: true },
      { ...DEFAULT_SPATIAL_PARAMS, mode: 'hall', motionEnabled: true, motionPreset: 'sweep', tailMode: 'ripple', dynamicTail: true },
      { ...DEFAULT_SPATIAL_PARAMS, mode: 'hall', motionEnabled: true, motionPreset: 'cinematic', tailMode: 'natural', tailLength: 100, tailIntensity: 100 },
    ] as SpatialParams[]) {
      const pl = await planSpatial(ex, src, params, { useWorklet: true, hrtfLatencySeconds: hrtfLatency })
      const r = await render(mix, params, { motion: true, limiter: true, trimDb: pl.trimDb })
      const m = stereoMetrics([r.L, r.R], RATE)
      const ok = m.peakDb <= -0.99 && m.correlation >= 0 && Math.abs(m.loudnessLufs - before.loudnessLufs) <= 1 && ![r.L, r.R].some((x) => x.some((v) => !Number.isFinite(v)))
      check(
        `${params.mode.toUpperCase()} × ${params.motionPreset.toUpperCase()} × ${params.tailMode.toUpperCase()}${params.dynamicTail ? ' + DYNAMIC' : ''}: ピーク ≤ −1 dBFS・相関 ≥ 0・ラウドネス ±1 LU`,
        ok,
        `ピーク ${f2(m.peakDb)} dBFS、相関 ${f2(m.correlation)}、ラウドネス ${f1(m.loudnessLufs - before.loudnessLufs)} LU、トリム ${f1(pl.trimDb)} dB`,
      )
    }
  }

  group = '34. CENTER LOCK（Tail 併用: 中央 1 kHz と 60 Hz の安定）'
  if (want(34)) {
    const c1 = sine(1000, 0.15, 8)
    const c60 = sine(60, 0.2, 8)
    const left = noise(8, 51, 0.15)
    const sig = toBuffer([Float32Array.from(c1, (v, i) => v + c60[i] + left[i]), Float32Array.from(c1, (v, i) => v + c60[i])])
    for (const tailMode of ['ripple', 'distance'] as const) {
      const params = { ...DEFAULT_SPATIAL_PARAMS, mode: 'cinema', motionEnabled: true, motionPreset: 'orbit', motionSpeed: 80, motionDepth: 100, centerLock: 100, tailMode } as SpatialParams
      const r = await render(sig, params, { motion: true })
      const n = Math.round(0.2 * RATE)
      const ild: number[] = []
      const lo: number[] = []
      for (let s = 2 * RATE; s + n <= 7.5 * RATE; s += n) {
        ild.push(linearToDb(toneAmp(r.R, 1000, s, n) / toneAmp(r.L, 1000, s, n)))
        lo.push(linearToDb(toneAmp(r.L, 60, s, n) + toneAmp(r.R, 60, s, n)))
      }
      check(`ORBIT × ${tailMode.toUpperCase()}: 中央 1 kHz の ILD の揺れ ≤ 1 dB・60 Hz のレベルの揺れ ≤ 0.5 dB（標準偏差）`, std(ild) <= 1 && std(lo) <= 0.5, `1 kHz ${f2(std(ild))} dB / 60 Hz ${f2(std(lo))} dB`)
    }
  }

  group = '35. モノラル互換性・ステレオ位相（ステレオミックス、Tail OFF との比較）'
  if (want(35)) {
    const mix = programStereoMix(8)
    for (const mode of ['hall', 'cinema'] as const) {
      const offR = await render(mix, { ...DEFAULT_SPATIAL_PARAMS, mode })
      const mOff = stereoMetrics([offR.L, offR.R], RATE)
      for (const tailMode of TAIL_MODES) {
        const r = await render(mix, { ...DEFAULT_SPATIAL_PARAMS, mode, tailMode })
        const m = stereoMetrics([r.L, r.R], RATE)
        const monoD = m.monoLoudnessLufs - m.loudnessLufs - (mOff.monoLoudnessLufs - mOff.loudnessLufs)
        check(
          `${mode.toUpperCase()} × ${tailMode.toUpperCase()}: モノラル和の低下の変化 ≤ 1 LU・位相相関 ≥ 0・低域の相関の変化 ≤ 0.05`,
          Math.abs(monoD) <= 1 && m.correlation >= 0 && Math.abs(m.bandCorrelation.low - mOff.bandCorrelation.low) <= 0.05,
          `モノラル ${f1(monoD)} LU、相関 ${f2(mOff.correlation)}→${f2(m.correlation)}、低域 ${f2(mOff.bandCorrelation.low)}→${f2(m.bandCorrelation.low)}`,
        )
      }
    }
  }

  group = '36. 出力ピーク（最大設定 LENGTH/INTENSITY 100、ラウドネス合わせ・リミッター ON）'
  if (want(36)) {
    const pop = programPop(8)
    const ex = buildSpatialExcerpt(pop)
    const src = await analyzeSpatialSource(ex)
    for (const mode of ['hall', 'cinema'] as const) {
      for (const tailMode of TAIL_MODES) {
        const params = { ...DEFAULT_SPATIAL_PARAMS, mode, tailMode, tailLength: 100, tailIntensity: 100, intensity: 100 } as SpatialParams
        const pl = await planSpatial(ex, src, params, { useWorklet: true, hrtfLatencySeconds: hrtfLatency })
        const r = await render(pop, params, { limiter: true, trimDb: pl.trimDb, seconds: 8 })
        const p = linearToDb(samplePeak([r.L, r.R]))
        check(`${mode.toUpperCase()} × ${tailMode.toUpperCase()}: ピーク ≤ −1 dBFS`, p <= -0.99, `${f2(p)} dBFS（トリム ${f1(pl.trimDb)} dB）`)
      }
    }
  }

  group = '37. 書き出し（Phase 06）に向けた再現性: 音源の終了後も余韻をレンダリングでき、同じ結果になる'
  if (want(37)) {
    const mix = programStereoMix(3)
    const params = hall({ tailMode: 'distance', dynamicTail: true })
    const a = await render(mix, params, { seconds: 7 })
    const b = await render(mix, params, { seconds: 7 })
    const t = stopDecaySeconds(new AudioBufferLike(a), 3)
    const pk = peakOf([a.L, a.R])
    let m = 0
    for (const [x, y] of [
      [a.L, b.L],
      [a.R, b.R],
    ]) {
      for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i]))
    }
    check('音源の終了後に余韻が残る（−60 dB まで ≥ 1 秒）', t >= 1, ms(t))
    check('2 回のオフラインレンダリングが一致（差 ≤ −120 dB、畳み込みの揺らぎのみ）', 20 * Math.log10(m / pk + 1e-30) <= -120, `${f1(20 * Math.log10(m / pk + 1e-30))} dB`)
  }

  group = '39. AudioParam のランプ（切替を繰り返しても、フェードが呼び出した時刻から始まる）'
  if (want(39)) {
    // linearRampToValueAtTime は直前のイベントから始まるため、2 回目以降の切替で値が飛ぶ不具合があった（Phase 04 で修正）
    const ctx = new OfflineAudioContext(1, 4 * RATE, RATE)
    const one = new ConstantSourceNode(ctx, { offset: 1 })
    const g = new GainNode(ctx, { gain: 1 })
    one.connect(g).connect(ctx.destination)
    one.start()
    for (const [t, v] of [
      [1, 0],
      [2, 1],
      [3, 0],
    ] as const) {
      void ctx.suspend(t).then(() => {
        linearRampAt(g.gain, ctx.currentTime, v, ctx.currentTime + 0.1)
        void ctx.resume()
      })
    }
    const r = (await ctx.startRendering()).getChannelData(0)
    const at = (t: number) => r[Math.round(t * RATE)]
    const ok = Math.abs(at(2) - 0) < 1e-3 && Math.abs(at(2.05) - 0.5) < 0.01 && Math.abs(at(3) - 1) < 1e-3 && Math.abs(at(3.05) - 0.5) < 0.01
    check('3 回続けたランプがそれぞれ呼び出し時刻から始まる', ok, `t=2.00: ${at(2).toFixed(3)}・2.05: ${at(2.05).toFixed(3)}・3.00: ${at(3).toFixed(3)}・3.05: ${at(3.05).toFixed(3)}`)
    // ORIGINAL/PROCESSED（空間・重低音の両段）を 4 回切り替えてもクリックなし（440 Hz、処理音と原音の差が大きい HALL）
    const tone = toBuffer([sine(440, 0.3, 5), sine(440, 0.3, 5)])
    const sw = await render(tone, hall({ depth: 100 }), {
      actions: [1, 2, 3, 4].map((t, k) => [t, (e: Env) => e.graph.setBypass(k % 2 === 0, true)] as [number, (e: Env) => void]),
    })
    const crs = [1, 2, 3, 4].map((t) => clickRatio(sw.L, 440, t - 0.01, t + 0.06, Math.max(maxAbs(sw.L, t - 0.3, t + 0.3), 1e-9)))
    check('空間: ORIGINAL/PROCESSED を 4 回切り替えてもクリックなし（2 階差分比 ≤ 1.5）', crs.every((v) => v <= 1.5), crs.map(f2).join(' / '))
    const bctx = new OfflineAudioContext(2, 5 * RATE, RATE)
    await loadDynamicsWorklet(bctx)
    const bg = createProcessingGraph(bctx, {
      params: { ...DEFAULT_BASS_PARAMS, mode: 'extreme' },
      scale: 1,
      bypass: false,
      dynamics: dynamicsSettingsFor('extreme', -20, 0),
      useWorklet: true,
    })
    const bs = new AudioBufferSourceNode(bctx, { buffer: toBuffer([sine(80, 0.3, 5), sine(80, 0.3, 5)]) })
    bs.connect(bg.input)
    bg.output.connect(bctx.destination)
    bs.start()
    ;[1, 2, 3, 4].forEach((t, k) => {
      void bctx.suspend(t).then(() => {
        bg.setBypass(k % 2 === 0, true)
        void bctx.resume()
      })
    })
    const bo = (await bctx.startRendering()).getChannelData(0)
    // 切替をまたぐ区間のサンプル間の最大変化が、切替前後の定常部分の最大変化の 1.5 倍以下 = 値が飛ばずにフェードしている
    const maxStepIn = (from: number, to: number) => {
      let m = 0
      for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) m = Math.max(m, Math.abs(bo[i] - bo[i - 1]))
      return m
    }
    const ratios = [2, 3, 4].map((t) => maxStepIn(t - 0.005, t + 0.06) / Math.max(maxStepIn(t - 0.3, t - 0.01), maxStepIn(t + 0.1, t + 0.3)))
    check('重低音: ORIGINAL/PROCESSED の 2〜4 回目の切替も値が飛ばない（切替区間のサンプル差 ≤ 定常部の 1.5 倍）', ratios.every((v) => v <= 1.5), ratios.map(f2).join(' / ') + ' 倍')
  }

  if (want(38)) results.push(...(await runTailCpuTest()))
  return results
}

/** 38. CPU 負荷（?suite=tailcpu でも単独実行） */
export async function runTailCpuTest(): Promise<TestResult[]> {
  const results: TestResult[] = []
  const group = '38. CPU 負荷（オフラインレンダリング速度、10 秒のステレオ、ウォームアップ後 3 回の中央値）'
  const check = (name: string, pass: boolean, detail: string) => {
    results.push({ group, name, pass, detail })
    console.info(`${pass ? 'PASS' : 'FAIL'} ${group} / ${name} :: ${detail}`)
  }
  if (!hrtfLatency) hrtfLatency = await measureHrtfLatency(RATE)
  const mix = programStereoMix(10)
  const once = async (params: SpatialParams, motion: boolean, allModes: boolean) => {
    const ctx = new OfflineAudioContext(2, mix.length, RATE)
    await loadDynamicsWorklet(ctx)
    await loadTailWorklet(ctx)
    await loadMotionWorklet(ctx)
    const g = createSpatialGraph(ctx, {
      params,
      bypass: false,
      trimDb: 0,
      useWorklet: true,
      hrtfLatencySeconds: hrtfLatency,
      modes: allModes ? undefined : [params.mode as ActiveSpatialMode],
      motion: motion ? {} : undefined,
    })
    const src = new AudioBufferSourceNode(ctx, { buffer: mix })
    src.connect(g.input)
    g.output.connect(ctx.destination)
    src.start()
    const t = performance.now()
    await ctx.startRendering()
    return performance.now() - t
  }
  const time = async (label: string, params: SpatialParams, motion: boolean, allModes: boolean) => {
    await once(params, motion, allModes)
    const runs = [await once(params, motion, allModes), await once(params, motion, allModes), await once(params, motion, allModes)]
    const med = [...runs].sort((a, b) => a - b)[1]
    const load = med / 1000 / mix.duration
    check(`${label}: 実時間比 ${(load * 100).toFixed(1)}%`, load < 0.5, `中央値 ${med.toFixed(0)} ms（3 回: ${runs.map((r) => r.toFixed(0)).join(' / ')} ms）。50% 未満を合格`)
  }
  await time('HALL（Tail OFF、既存）', hall(), false, false)
  await time('HALL × NATURAL', hall({ tailMode: 'natural' }), false, false)
  await time('HALL × RIPPLE + DYNAMIC（LENGTH 100）', hall({ tailMode: 'ripple', dynamicTail: true, tailLength: 100 }), false, false)
  await time('CINEMA × ORBIT × DISTANCE + DYNAMIC', { ...DEFAULT_SPATIAL_PARAMS, mode: 'cinema', motionEnabled: true, motionPreset: 'orbit', tailMode: 'distance', dynamicTail: true }, true, false)
  await time('再生時と同じ全チェーン構築（HALL × ORBIT × RIPPLE + DYNAMIC 使用中）', hall({ motionEnabled: true, motionPreset: 'orbit', tailMode: 'ripple', dynamicTail: true }), true, true)
  return results
}

// ---------------- 小物 ----------------

function energyLin(x: Float32Array, from: number, to: number): number {
  let e = 0
  for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) e += x[i] * x[i]
  return e + 1e-30
}

/** stopDecaySeconds（AudioBuffer を受け取る）に Rendered を渡すための薄い入れ物 */
class AudioBufferLike {
  private readonly ch: Float32Array[]
  constructor(r: Rendered) {
    this.ch = [r.L, r.R]
  }
  getChannelData(c: number): Float32Array {
    return this.ch[c]
  }
}
