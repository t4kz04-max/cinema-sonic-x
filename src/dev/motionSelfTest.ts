// Dynamic Spatial Motion Engine の自己診断（test:spatial の一部として実行）。
// 動きを測定できるテスト信号（片側だけの純音・中央の純音・低域の純音）を使い、
// 出力の両耳間レベル差（ILD）の時間変化から、方向・距離が実際に変化していることを客観的に確認する。

import { integratedLoudness, linearToDb, samplePeak } from '../audio/loudness'
import { loadDynamicsWorklet } from '../audio/processingGraph'
import { createPositions, sourcePositions, SPEAKER_AZIMUTHS, SPEAKER_COUNT, SRC, type Envelope, type MotionPreset } from '../audio/spatial/motion'
import { computeEnvelope } from '../audio/spatial/motionEnvelope'
import { MOTION_FFT_SIZE, MOTION_HOP, type MotionWorkletOptions } from '../audio/spatial/motionTypes'
import { analyzeSpatialSource, buildSpatialExcerpt, planSpatial } from '../audio/spatial/spatialAnalysis'
import { createSpatialGraph, loadMotionWorklet, measureHrtfLatency } from '../audio/spatial/spatialGraph'
import { DEFAULT_SPATIAL_PARAMS, motionControl, motionLayout, type SpatialParams } from '../audio/spatial/spatialSpec'
import { monoColorationDb, stereoMetrics } from '../audio/stereoMetrics'
import type { TestResult } from './dspSelfTest'
import { programMono, programStereoMix, TEST_RATE, toBuffer } from './testSignals'

const RATE = TEST_RATE
const PRESETS: MotionPreset[] = ['cinematic', 'orbit', 'sweep', 'pulse']
const chans = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))
const f1 = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}` : String(v))
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : String(v))
const mp = (patch: Partial<SpatialParams> = {}): SpatialParams => ({
  ...DEFAULT_SPATIAL_PARAMS,
  mode: 'cinema',
  motionEnabled: true,
  motionPreset: 'sweep',
  motionSpeed: 60,
  motionDepth: 100,
  centerLock: 100,
  ...patch,
})

let hrtfLatency = 0
const latencySamples = () => MOTION_FFT_SIZE + Math.round(hrtfLatency * RATE)

const sine = (f: number, a: number, seconds: number) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / RATE))
const zeros = (seconds: number) => new Float32Array(Math.round(seconds * RATE))
const add = (...xs: Float32Array[]) => Float32Array.from(xs[0], (_, i) => xs.reduce((s, x) => s + x[i], 0))
function noise(seconds: number, seed: number, amp = 0.2): Float32Array {
  let s = seed >>> 0
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s / 0x100000000 - 0.5) * 2 * amp
  })
}

interface RenderOpts {
  /** 開始位置（秒）。ソースもこの位置から再生する */
  t0?: number
  bypass?: boolean
  withMotion?: boolean
  envelope?: Envelope | null
  limiter?: boolean
  trimDb?: number
  schedule?: (ctx: OfflineAudioContext, g: ReturnType<typeof createSpatialGraph>) => void
}

async function render(buf: AudioBuffer, params: SpatialParams | null, o: RenderOpts = {}): Promise<AudioBuffer> {
  const t0 = o.t0 ?? 0
  const length = buf.length - Math.round(t0 * RATE)
  const ctx = new OfflineAudioContext(2, length, RATE)
  const src = new AudioBufferSourceNode(ctx, { buffer: buf })
  if (params) {
    await loadDynamicsWorklet(ctx)
    const withMotion = o.withMotion ?? true
    if (withMotion) await loadMotionWorklet(ctx)
    const g = createSpatialGraph(ctx, {
      params,
      bypass: o.bypass ?? false,
      trimDb: o.trimDb ?? 0,
      useWorklet: true,
      hrtfLatencySeconds: hrtfLatency,
      limiterEnabled: o.limiter ?? false,
      motion: withMotion ? { transport: { playing: true, startedAt: -t0, pausedAt: t0 }, envelope: o.envelope ?? null } : undefined,
    })
    src.connect(g.input)
    g.output.connect(ctx.destination)
    o.schedule?.(ctx, g)
  } else {
    src.connect(ctx.destination)
  }
  src.start(0, t0)
  return ctx.startRendering()
}

/** 帯域ノイズ（ランダム位相の正弦波の和、決定的） */
function bandNoise(lo: number, hi: number, seconds: number, seed: number, amp = 0.25): Float32Array {
  let s = seed >>> 0
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000)
  const comps = 48
  const freqs = Array.from({ length: comps }, (_, k) => lo * Math.pow(hi / lo, (k + rnd()) / comps))
  const phases = freqs.map(() => rnd() * 2 * Math.PI)
  const n = Math.round(seconds * RATE)
  const out = new Float32Array(n)
  for (let k = 0; k < comps; k++) {
    const w = (2 * Math.PI * freqs[k]) / RATE
    for (let i = 0; i < n; i++) out[i] += Math.sin(w * i + phases[k])
  }
  const g = amp / Math.sqrt(comps / 2)
  for (let i = 0; i < n; i++) out[i] *= g
  return out
}

/** RBJ バンドパス（0 dB ピーク）を JS で適用 */
function bandpass(x: Float32Array, lo: number, hi: number): Float32Array {
  const f0 = Math.sqrt(lo * hi)
  const q = f0 / (hi - lo)
  const w0 = (2 * Math.PI * f0) / RATE
  const alpha = Math.sin(w0) / (2 * q)
  const a0 = 1 + alpha
  const b0 = alpha / a0
  const b2 = -alpha / a0
  const a1 = (-2 * Math.cos(w0)) / a0
  const a2 = (1 - alpha) / a0
  const y = new Float32Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x[i]
    y2 = y1
    y1 = v
    y[i] = v
  }
  return y
}

/** 帯域エネルギーによる時間ごとの ILD（右 − 左、dB） */
function bandIldTrack(out: AudioBuffer, lo: number, hi: number, from: number, to: number, win = 0.1): { t: number[]; ild: number[] } {
  const L = bandpass(out.getChannelData(0), lo, hi)
  const R = bandpass(out.getChannelData(1), lo, hi)
  const n = Math.round(win * RATE)
  const t: number[] = []
  const ild: number[] = []
  for (let s = Math.round(from * RATE); s + n <= Math.round(to * RATE); s += n) {
    let el = 0
    let er = 0
    for (let i = s; i < s + n; i++) {
      el += L[i] * L[i]
      er += R[i] * R[i]
    }
    t.push((s + n / 2 - latencySamples()) / RATE)
    ild.push(10 * Math.log10(er / el))
  }
  return { t, ild }
}

/** 窓ごとの指定周波数の振幅（Goertzel） */
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

/** 出力の時間ごとの ILD（右 − 左、dB）。latency を引いたメディア時刻に対応づける */
function ildTrack(out: AudioBuffer, f: number, from: number, to: number, win = 0.1): { t: number[]; ild: number[] } {
  const L = out.getChannelData(0)
  const R = out.getChannelData(1)
  const n = Math.round(win * RATE)
  const t: number[] = []
  const ild: number[] = []
  for (let s = Math.round(from * RATE); s + n <= Math.round(to * RATE); s += n) {
    t.push((s + n / 2 - latencySamples()) / RATE)
    ild.push(linearToDb(toneAmp(R, f, s, n) / toneAmp(L, f, s, n)))
  }
  return { t, ild }
}

function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n
  const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb)
    saa += (a[i] - ma) ** 2
    sbb += (b[i] - mb) ** 2
  }
  return sab / Math.sqrt(saa * sbb + 1e-30)
}

const std = (a: number[]) => {
  const m = a.reduce((s, v) => s + v, 0) / a.length
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length)
}
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length

/** 純音のクリック指標: 2 階差分の最大値 ÷ 純音として期待される値（1 前後が正常、クリックがあると大きくなる） */
function clickRatio(x: Float32Array, f: number, from: number, to: number): number {
  let maxD2 = 0
  let maxAmp = 0
  for (let i = Math.max(2, Math.round(from * RATE)); i < Math.min(x.length, Math.round(to * RATE)); i++) {
    maxD2 = Math.max(maxD2, Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]))
    maxAmp = Math.max(maxAmp, Math.abs(x[i]))
  }
  const w = (2 * Math.PI * f) / RATE
  return maxD2 / (maxAmp * w * w + 1e-12)
}

/**
 * ILD の較正表: Motion ワークレット＋12 方向 HRTF（再生時と同じ構成）で、
 * LEFT レイヤーを −X°、RIGHT レイヤーを +X° に静止させたときの帯域 ILD を X = 0〜180°（10° ごと）で実測する。
 */
async function calibrateIld(signal: AudioBuffer): Promise<{ left: number[]; right: number[] }> {
  const left: number[] = []
  const right: number[] = []
  const seconds = 1.2
  const part = toBuffer(chans(signal).map((x) => x.slice(0, Math.round(seconds * RATE))))
  for (let az = 0; az <= 180; az += 10) {
    const ctx = new OfflineAudioContext(2, part.length, RATE)
    await loadMotionWorklet(ctx)
    const options: MotionWorkletOptions = {
      layout: { lrAzimuth: az, ambienceAzimuth: 110, baseDistance: 1.5 },
      control: { enabled: true, preset: 'cinematic', speed: 0, depth: 0, centerLock: 1 },
      transport: { playing: true, startedAt: 0, pausedAt: 0 },
      envelope: null,
      reportIntervalMs: 0,
    }
    const node = new AudioWorkletNode(ctx, 'csx-motion', {
      numberOfInputs: 1,
      numberOfOutputs: 2,
      outputChannelCount: [SPEAKER_COUNT, 2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: options,
    })
    const split = new ChannelSplitterNode(ctx, { numberOfOutputs: SPEAKER_COUNT })
    node.connect(split, 0)
    SPEAKER_AZIMUTHS.forEach((sa, i) => {
      const r = (sa * Math.PI) / 180
      const pn = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'linear', rolloffFactor: 0, positionX: Math.sin(r), positionY: 0, positionZ: -Math.cos(r) })
      split.connect(pn, i)
      pn.connect(ctx.destination)
    })
    const src = new AudioBufferSourceNode(ctx, { buffer: part })
    src.connect(node)
    src.start()
    const out = await ctx.startRendering()
    const mean = (track: { ild: number[] }) => track.ild.reduce((sum, v) => sum + v, 0) / track.ild.length
    left.push(mean(bandIldTrack(out, 1000, 2500, 0.3 + MOTION_FFT_SIZE / RATE, seconds)))
    right.push(-mean(bandIldTrack(out, 3000, 6000, 0.3 + MOTION_FFT_SIZE / RATE, seconds)))
  }
  // left[i]: −(i·10)° の音源の ILD、right[i]: +(i·10)° の音源の ILD の符号反転（どちらも「左側にあるときの ILD」に正規化）
  return { left, right }
}

/** 較正表から、その時刻の方位で観測されるはずの ILD（左右対称を仮定） */
function expectedIld(params: SpatialParams, source: number, times: number[], table: number[]): number[] {
  const pos = createPositions()
  const lookup = (x: number) => {
    const f = Math.min(Math.max(x / 10, 0), table.length - 1)
    const i = Math.floor(f)
    const j = Math.min(i + 1, table.length - 1)
    return table[i] + (table[j] - table[i]) * (f - i)
  }
  return times.map((t) => {
    sourcePositions(t, motionLayout(params), motionControl(params), null, pos)
    const az = pos[source].azimuth
    return az <= 0 ? lookup(-az) : -lookup(az)
  })
}

export async function runMotionSelfTest(): Promise<TestResult[]> {
  const results: TestResult[] = []
  let group = ''
  const started = performance.now()
  const check = (name: string, pass: boolean, detail: string) => {
    results.push({ group, name, pass, detail })
    // 進行状況（長い試験のため、ヘッドレス実行時にコンソールで途中経過を確認できるようにする）
    console.info(`[${((performance.now() - started) / 1000).toFixed(1)}s] ${pass ? 'PASS' : 'FAIL'} ${group} / ${name} :: ${detail}`)
  }

  hrtfLatency = await measureHrtfLatency(RATE)
  group = '8. Motion: 実行環境'
  {
    const ctx = new OfflineAudioContext(1, 128, RATE)
    const ok = await loadMotionWorklet(ctx)
    check('Motion AudioWorklet の読み込み', ok, ok ? `成功（STFT ${MOTION_FFT_SIZE} / ホップ ${MOTION_HOP}、遅延 ${((MOTION_FFT_SIZE / RATE) * 1000).toFixed(1)} ms）` : '失敗')
    if (!ok) return results
  }

  group = '9. Motion OFF で既存の空間音響と一致'
  {
    const mix = programStereoMix(4)
    for (const mode of ['cinema', 'hall'] as const) {
      const params = { ...mp({ mode, motionEnabled: false }) }
      const a = await render(mix, params, { withMotion: false, limiter: true })
      const a2 = await render(mix, params, { withMotion: false, limiter: true })
      const b = await render(mix, params, { withMotion: true, limiter: true })
      const maxDiff = (x: AudioBuffer, y: AudioBuffer) => {
        let m = 0
        for (let c = 0; c < 2; c++) {
          const u = x.getChannelData(c)
          const v = y.getChannelData(c)
          for (let i = 0; i < u.length; i++) m = Math.max(m, Math.abs(u[i] - v[i]))
        }
        return m
      }
      // Chrome/Edge の HRTF 処理は同じグラフでも再レンダリングごとに浮動小数点の最下位桁が揺れる（決定的でない）。
      // そのため「同一グラフを 2 回レンダリングした差」を基準に、それを超える差がないことを確認する
      const floor = maxDiff(a, a2)
      const m = maxDiff(a, b)
      check(
        `${mode.toUpperCase()}: Motion チェーンを構築したまま OFF ＝ Motion なしのグラフ（差 ≤ 再レンダリング差×2 かつ ≤ 1e-6）`,
        m <= Math.max(2 * floor, 1e-12) && m <= 1e-6,
        `最大差 ${m.toExponential(2)}（同一グラフの再レンダリング差 ${floor.toExponential(2)}）`,
      )
    }
  }

  group = '10. レイヤー分解（CENTER / LEFT / RIGHT / AMBIENCE / BED）'
  {
    const layers = async (L: Float32Array, R: Float32Array, centerLock = 1) => {
      const ctx = new OfflineAudioContext(7, L.length, RATE)
      await loadMotionWorklet(ctx)
      const p = mp({ centerLock: centerLock * 100 })
      const options: MotionWorkletOptions = {
        layout: motionLayout(p),
        control: motionControl(p),
        transport: { playing: true, startedAt: 0, pausedAt: 0 },
        envelope: null,
        reportIntervalMs: 0,
        debugLayers: true,
      }
      const node = new AudioWorkletNode(ctx, 'csx-motion', {
        numberOfInputs: 1,
        numberOfOutputs: 2,
        outputChannelCount: [12, 7],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: options,
      })
      const merger = new ChannelMergerNode(ctx, { numberOfInputs: 7 })
      const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 7 })
      node.connect(split, 1)
      for (let i = 0; i < 7; i++) split.connect(merger, i, i)
      merger.connect(ctx.destination)
      const src = new AudioBufferSourceNode(ctx, { buffer: toBuffer([L, R]) })
      src.connect(node)
      src.start()
      return chans(await ctx.startRendering())
    }
    const mix = programStereoMix(4)
    const [L, R] = chans(mix)
    const ly = await layers(L, R)
    let err = 0
    let peak = 0
    for (let i = MOTION_FFT_SIZE; i < L.length; i++) {
      const recL = ly[0][i] + ly[1][i] + ly[3][i] + ly[5][i]
      const recR = ly[0][i] + ly[2][i] + ly[4][i] + ly[6][i]
      err = Math.max(err, Math.abs(recL - L[i - MOTION_FFT_SIZE]), Math.abs(recR - R[i - MOTION_FFT_SIZE]))
      peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]))
    }
    const errDb = linearToDb(err / peak)
    check('全レイヤーの再合成が原音と一致（L = C+LEFT+AMB L+BED L、R = C+RIGHT+AMB R+BED R）', errDb < -80, `最大誤差 ${f1(errDb)} dB（ピーク比）`)

    const energy = (x: Float32Array) => x.slice(MOTION_FFT_SIZE * 2).reduce((s, v) => s + v * v, 0)
    const share = (ly2: Float32Array[]) => {
      const e = ly2.map(energy)
      const total = e.reduce((s, v) => s + v, 0)
      return e.map((v) => v / total)
    }
    const names = ['CENTER', 'LEFT', 'RIGHT', 'AMB L', 'AMB R', 'BED L', 'BED R']
    const fmt = (s: number[]) => s.map((v, i) => `${names[i]} ${(v * 100).toFixed(0)}%`).join(' / ')
    const cases: [string, Float32Array, Float32Array, number][] = [
      ['左だけの 1 kHz → LEFT', sine(1000, 0.3, 3), zeros(3), SRC.left],
      ['右だけの 1 kHz → RIGHT', zeros(3), sine(1000, 0.3, 3), SRC.right],
      ['中央（L=R）の 1 kHz → CENTER', sine(1000, 0.3, 3), sine(1000, 0.3, 3), SRC.center],
      ['左右無相関ノイズ → AMBIENCE', noise(3, 1), noise(3, 2), -1],
      ['60 Hz（左右とも）→ BED', sine(60, 0.3, 3), sine(60, 0.3, 3), -2],
    ]
    for (const [label, l, r, expect] of cases) {
      const s = share(await layers(l, r))
      const got = expect === -1 ? s[3] + s[4] : expect === -2 ? s[5] + s[6] : s[expect]
      check(`分類: ${label}`, got >= 0.8, `${fmt(s)}`)
    }
  }

  group = '11. LEFT / RIGHT の独立した移動（左 1–2.5 kHz・右 3–6 kHz の帯域ノイズ）'
  // 測定条件: 反射音は静止しているため、動く直接音の方向は反射の少ない設定（INTENSITY 0・DEPTH 0）で測る。
  // 期待値: HRTF の ILD は方位に対して単調でない（特に高域）ため、静止音源を 10° ごとに置いて実測した ILD 表で
  // 「その時刻の方位なら観測されるはずの ILD」を求め、実際の ILD と比べる
  const lrSignal = toBuffer([bandNoise(1000, 2500, 26, 21), bandNoise(3000, 6000, 26, 22)])
  const dry = { intensity: 0, depth: 0 }
  const sweep = mp({ motionPreset: 'sweep', ...dry })
  const ildTables = await calibrateIld(lrSignal)
  for (const preset of ['sweep', 'cinematic', 'orbit'] as const) {
    const params = mp({ motionPreset: preset, ...dry })
    const out = await render(lrSignal, params)
    const a = bandIldTrack(out, 1000, 2500, 1.5, 25)
    const b = bandIldTrack(out, 3000, 6000, 1.5, 25)
    const expLforA = expectedIld(params, SRC.left, a.t, ildTables.left)
    const expRforA = expectedIld(params, SRC.right, a.t, ildTables.left)
    const expRforB = expectedIld(params, SRC.right, b.t, ildTables.right)
    const expLforB = expectedIld(params, SRC.left, b.t, ildTables.right)
    const own = [corr(a.ild, expLforA), corr(b.ild, expRforB)]
    const other = [corr(a.ild, expRforA), corr(b.ild, expLforB)]
    const need = preset === 'sweep' ? 0.9 : 0.8
    const rA = Math.max(...a.ild) - Math.min(...a.ild)
    const rB = Math.max(...b.ild) - Math.min(...b.ild)
    check(
      `${preset.toUpperCase()}: LEFT/RIGHT の ILD が期待される方位の変化に追従（相関 ≥ ${need}）`,
      own[0] >= need && own[1] >= need,
      `LEFT ${f2(own[0])}（ILD 変化幅 ${f1(rA)} dB）/ RIGHT ${f2(own[1])}（${f1(rB)} dB）`,
    )
    check(
      `${preset.toUpperCase()}: LEFT と RIGHT が独立して動く（自分の軌道との相関が相手の軌道より 0.1 以上高い）`,
      own[0] >= other[0] + 0.1 && own[1] >= other[1] + 0.1,
      `LEFT: 自分 ${f2(own[0])} / RIGHT の軌道 ${f2(other[0])}、RIGHT: 自分 ${f2(own[1])} / LEFT の軌道 ${f2(other[1])}`,
    )
  }
  {
    // 参考: 既定値（INTENSITY 60・DEPTH 40）では静止した反射音と混ざり、方向の変化は小さく測定される
    const params = mp({ motionPreset: 'sweep' })
    const out = await render(lrSignal, params)
    const a = bandIldTrack(out, 1000, 2500, 1.5, 25)
    const b = bandIldTrack(out, 3000, 6000, 1.5, 25)
    // Phase 04: 反射音への送りが音源位置に追従するようにした（Phase 03 では反射音が固定で、既定値の変化幅は約 11 dB）
    const cA = corr(a.ild, expectedIld(params, SRC.left, a.t, ildTables.left))
    const cB = corr(b.ild, expectedIld(params, SRC.right, b.t, ildTables.right))
    const rA = Math.max(...a.ild) - Math.min(...a.ild)
    const rB = Math.max(...b.ild) - Math.min(...b.ild)
    check('Phase 04: 既定値（反射あり）でも動きが埋もれない（ILD 変化幅 ≥ 15 dB・追従相関 ≥ 0.8）', Math.min(rA, rB) >= 15 && Math.min(cA, cB) >= 0.8, `LEFT ${f1(rA)} dB・相関 ${f2(cA)} / RIGHT ${f1(rB)} dB・相関 ${f2(cB)}`)
    check(
      '参考: 既定値（反射あり）での SWEEP の追従',
      true,
      `LEFT 相関 ${f2(corr(a.ild, expectedIld(params, SRC.left, a.t, ildTables.left)))}・変化幅 ${f1(Math.max(...a.ild) - Math.min(...a.ild))} dB / RIGHT 相関 ${f2(corr(b.ild, expectedIld(params, SRC.right, b.t, ildTables.right)))}・変化幅 ${f1(Math.max(...b.ild) - Math.min(...b.ild))} dB`,
    )
  }

  group = '12. 距離の変化（左だけのノイズ、CINEMATIC DEPTH 100%）'
  {
    const params = mp({ motionPreset: 'cinematic', motionSpeed: 80 })
    const sig = toBuffer([noise(20, 7), zeros(20)])
    const out = await render(sig, params)
    const L = out.getChannelData(0)
    const pos = createPositions()
    const win = Math.round(0.2 * RATE)
    const lvl: number[] = []
    const dist: number[] = []
    for (let s = Math.round(1.5 * RATE); s + win <= L.length; s += win) {
      const t = (s + win / 2 - latencySamples()) / RATE
      sourcePositions(t, motionLayout(params), motionControl(params), null, pos)
      let e = 0
      for (let i = s; i < s + win; i++) e += L[i] * L[i]
      lvl.push(10 * Math.log10(e / win))
      dist.push(-20 * Math.log10(pos[SRC.left].distance))
    }
    const c = corr(lvl, dist)
    check('左耳レベルが LEFT の距離（逆距離則）に追従', c >= 0.6, `相関 ${f2(c)}（距離 ${f2(Math.min(...dist.map((d) => 10 ** (-d / 20))))}〜${f2(Math.max(...dist.map((d) => 10 ** (-d / 20))))} m、レベル変化幅 ${f1(Math.max(...lvl) - Math.min(...lvl))} dB）`)
  }

  group = '13. CENTER LOCK と低域の安定'
  {
    // 中央の 1 kHz（L=R）＋左右無相関ノイズ
    const sig = toBuffer([add(sine(1000, 0.2, 14), noise(14, 3, 0.05)), add(sine(1000, 0.2, 14), noise(14, 4, 0.05))])
    const locked = ildTrack(await render(sig, mp({ motionPreset: 'sweep', centerLock: 100 })), 1000, 1.5, 13.5)
    const free = ildTrack(await render(sig, mp({ motionPreset: 'sweep', centerLock: 0 })), 1000, 1.5, 13.5)
    check(
      'CENTER LOCK 100%: 中央の音の ILD がほぼ一定（標準偏差 < 0.5 dB・平均 |ILD| < 1 dB）',
      std(locked.ild) < 0.5 && Math.abs(mean(locked.ild)) < 1,
      `標準偏差 ${f2(std(locked.ild))} dB、平均 ${f2(mean(locked.ild))} dB`,
    )
    check('CENTER LOCK 0%: 中央の音も左右レイヤーと一緒に動く（標準偏差 > 1 dB）', std(free.ild) > 1, `標準偏差 ${f2(std(free.ild))} dB`)
    // 左だけの 60 Hz と 1 kHz: 低域は BED として固定され、1 kHz だけが動く
    const low = toBuffer([add(sine(60, 0.2, 14), sine(1000, 0.2, 14)), zeros(14)])
    const out = await render(low, mp({ motionPreset: 'sweep' }))
    const l60 = ildTrack(out, 60, 1.5, 13.5, 0.2)
    const l1k = ildTrack(out, 1000, 1.5, 13.5, 0.2)
    check('低域（60 Hz）は動かない（ILD 標準偏差 < 0.5 dB）、同じ側の 1 kHz は動く（> 2 dB）', std(l60.ild) < 0.5 && std(l1k.ild) > 2, `60 Hz ${f2(std(l60.ild))} dB / 1 kHz ${f2(std(l1k.ild))} dB`)
  }

  group = '14. PULSE（音楽の強弱 → 広がり）'
  {
    // 3 秒ごとに大小を繰り返す左右無相関ノイズ＋中央成分
    const n = 24 * RATE
    const amp = Float32Array.from({ length: n }, (_, i) => (Math.floor(i / (3 * RATE)) % 2 === 0 ? 1 : 0.15))
    const a = noise(24, 11, 0.2)
    const b = noise(24, 12, 0.2)
    const c = noise(24, 13, 0.2)
    const L = Float32Array.from(a, (v, i) => (v + c[i]) * amp[i])
    const R = Float32Array.from(b, (v, i) => (v + c[i]) * amp[i])
    const params = mp({ motionPreset: 'pulse', motionSpeed: 50 })
    const env = computeEnvelope([L, R], RATE, 0.5)
    const out = await render(toBuffer([L, R]), params, { envelope: env })
    const oL = out.getChannelData(0)
    const oR = out.getChannelData(1)
    const win = Math.round(0.25 * RATE)
    const width: number[] = []
    const e: number[] = []
    for (let s = Math.round(2 * RATE); s + win <= oL.length; s += win) {
      let m = 0
      let sd = 0
      for (let i = s; i < s + win; i++) {
        m += (oL[i] + oR[i]) ** 2
        sd += (oL[i] - oR[i]) ** 2
      }
      width.push(10 * Math.log10(sd / m))
      const t = (s + win / 2 - latencySamples()) / RATE
      e.push(env.data[Math.min(env.data.length - 1, Math.round(t * env.rate))])
    }
    const cw = corr(width, e)
    check('包絡が大きいほど出力のステレオ幅（S/M）が大きい', cw >= 0.6, `相関 ${f2(cw)}、幅の変化 ${f1(Math.min(...width))}〜${f1(Math.max(...width))} dB`)
  }

  group = '15. シーク・再開時の再現性'
  {
    const full = await render(lrSignal, sweep)
    for (const t0 of [5.12, 6.3]) {
      const part = await render(lrSignal, sweep, { t0 })
      // 統計の平滑化が収束する 1 秒後から 3 秒間を比較
      const off = Math.round(t0 * RATE)
      const from = Math.round(1 * RATE)
      const len = 3 * RATE
      let err = 0
      let ref = 0
      for (let c = 0; c < 2; c++) {
        const x = full.getChannelData(c)
        const y = part.getChannelData(c)
        for (let i = from; i < from + len; i++) {
          err += (x[off + i] - y[i]) ** 2
          ref += x[off + i] ** 2
        }
      }
      const diffDb = 10 * Math.log10(err / ref)
      const ta = bandIldTrack(full, 1000, 2500, t0 + 1, t0 + 4)
      const tb = bandIldTrack(part, 1000, 2500, 1, 4)
      const maxIldDiff = Math.max(...ta.ild.map((v, i) => Math.abs(v - (tb.ild[i] ?? v))))
      const aligned = (t0 * RATE) % MOTION_HOP === 0
      check(
        `${t0} 秒から再生（${aligned ? 'STFT のホップ境界' : 'ホップ境界外'}）: 通し再生と同じ位置・同じ音`,
        aligned ? diffDb < -60 && maxIldDiff < 0.1 : diffDb < -20 && maxIldDiff < 0.5,
        `差分 ${f1(diffDb)} dB（信号比）、ILD 最大差 ${f2(maxIldDiff)} dB`,
      )
    }
    // 一時停止 → 再開: transport を止めた位置から再開しても、同じ時刻なら同じ位置
    const pos = createPositions()
    const pos2 = createPositions()
    sourcePositions(7.25, motionLayout(sweep), motionControl(sweep), null, pos)
    sourcePositions(7.25, motionLayout(sweep), motionControl(sweep), null, pos2)
    check('同じメディア時刻 → 同じ位置（乱数なし・決定的）', pos.every((p, i) => p.azimuth === pos2[i].azimuth && p.distance === pos2[i].distance), 'sourcePositions は時刻とパラメーターだけで決まる')
  }

  group = '16. クリックノイズ（左だけの 440 Hz）'
  {
    const sig = toBuffer([sine(440, 0.3, 6), zeros(6)])
    const base = clickRatio((await render(sig, mp({ motionEnabled: false }))).getChannelData(0), 440, 1, 5.5)
    const fast = clickRatio((await render(sig, mp({ motionPreset: 'sweep', motionSpeed: 100 }))).getChannelData(0), 440, 1, 5.5)
    check('最速の SWEEP で移動中もクリックなし', fast <= Math.max(1.5, base * 1.25), `2 階差分比 ${f2(fast)}（静止時 ${f2(base)}、純音のみなら 1 付近）`)
    const switched = async (label: string, from: SpatialParams, to: SpatialParams) => {
      const out = await render(sig, from, {
        schedule: (ctx, g) => {
          void ctx.suspend(2.0).then(() => {
            g.setParams(to, true)
            void ctx.resume()
          })
        },
      })
      const r = clickRatio(out.getChannelData(0), 440, 1, 5.5)
      check(label, r <= Math.max(1.5, base * 1.25), `2 階差分比 ${f2(r)}（静止時 ${f2(base)}）`)
    }
    await switched('プリセット切替（SWEEP → ORBIT）', mp({ motionPreset: 'sweep' }), mp({ motionPreset: 'orbit' }))
    await switched('Motion OFF → ON', mp({ motionEnabled: false }), mp({ motionPreset: 'orbit' }))
    await switched('SPEED 急変（10% → 100%）', mp({ motionPreset: 'orbit', motionSpeed: 10 }), mp({ motionPreset: 'orbit', motionSpeed: 100 }))
  }

  group = '17. 総合（ステレオミックス相当: ピーク・ラウドネス・位相・モノラル）'
  {
    const mix = programStereoMix(10)
    const before = stereoMetrics(chans(mix), RATE)
    const env = computeEnvelope(chans(mix), RATE, 0.4)
    for (const mode of ['cinema', 'hall'] as const) {
      for (const preset of PRESETS) {
        const params = mp({ mode, motionPreset: preset, motionSpeed: 40, motionDepth: 60, centerLock: 80 })
        const ex = buildSpatialExcerpt(mix)
        const pl = await planSpatial(ex, await analyzeSpatialSource(ex), params, { useWorklet: true, hrtfLatencySeconds: hrtfLatency, envelope: env })
        const out = await render(mix, params, { limiter: true, trimDb: pl.trimDb, envelope: env })
        const m = stereoMetrics(chans(out), RATE)
        const ok = m.peakDb <= -0.99 && !chans(out).some((x) => x.some((v) => !Number.isFinite(v))) && m.correlation >= 0 && Math.abs(m.loudnessLufs - before.loudnessLufs) <= 1
        check(
          `${mode.toUpperCase()} × ${preset.toUpperCase()}: ピーク ≤ -1 dBFS・相関 ≥ 0・ラウドネス ±1 LU`,
          ok,
          `ピーク ${f2(m.peakDb)} dBFS、相関 ${f2(before.correlation)}→${f2(m.correlation)}（低 ${f2(m.bandCorrelation.low)}）、ラウドネス ${f1(m.loudnessLufs - before.loudnessLufs)} LU、モノラル和 ${f1(m.monoLoudnessLufs - before.monoLoudnessLufs)} LU、音色偏差 モノラル ${f1(monoColorationDb(before, m))} dB、トリム ${f1(pl.trimDb)} dB`,
        )
      }
    }
    const mono = programMono(6)
    for (const preset of PRESETS) {
      const params = mp({ motionPreset: preset })
      const out = await render(mono, params, { limiter: true })
      const [oL, oR] = chans(out)
      const ild = linearToDb(Math.sqrt(oR.reduce((s, v) => s + v * v, 0) / oL.reduce((s, v) => s + v * v, 0)))
      check(
        `モノラル音源 × ${preset.toUpperCase()}: NaN なし・左右の偏り |ILD| < 1.5 dB`,
        !chans(out).some((x) => x.some((v) => !Number.isFinite(v))) && Math.abs(ild) < 1.5 && Number.isFinite(integratedLoudness(chans(out), RATE)),
        `平均 ILD ${f2(ild)} dB、ピーク ${f2(linearToDb(samplePeak(chans(out))))} dBFS`,
      )
    }
  }

  group = '18. BYPASS（Motion ON のまま ORIGINAL → 原音とサンプル一致）'
  {
    const mix = programStereoMix(4)
    const orig = await render(mix, null)
    for (const preset of PRESETS) {
      for (const mode of ['cinema', 'hall'] as const) {
        const out = await render(mix, mp({ mode, motionPreset: preset }), { bypass: true, limiter: true, trimDb: 3 })
        let m = 0
        for (let c = 0; c < 2; c++) {
          const x = orig.getChannelData(c)
          const y = out.getChannelData(c)
          for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i]))
        }
        check(`${mode.toUpperCase()} × ${preset.toUpperCase()}`, m === 0, `最大差 ${m}`)
      }
    }
  }

  results.push(...(await runMotionCpuTest()))

  return results
}

/** 19. CPU 負荷だけを実行する（?suite=cpu。重い試験を避けて負荷だけを再測定するため） */
export async function runMotionCpuTest(): Promise<TestResult[]> {
  const results: TestResult[] = []
  let group = ''
  const check = (name: string, pass: boolean, detail: string) => {
    results.push({ group, name, pass, detail })
    console.info(`${pass ? 'PASS' : 'FAIL'} ${group} / ${name} :: ${detail}`)
  }
  if (!hrtfLatency) hrtfLatency = await measureHrtfLatency(RATE)
  group = '19. CPU 負荷（オフラインレンダリング速度、10 秒のステレオ、ウォームアップ後 3 回の中央値）'
  {
    const mix = programStereoMix(10)
    const renderOnce = async (params: SpatialParams | null, withMotion: boolean, allModes: boolean) => {
      const ctx = new OfflineAudioContext(2, mix.length, RATE)
      const src = new AudioBufferSourceNode(ctx, { buffer: mix })
      if (params) {
        await loadDynamicsWorklet(ctx)
        await loadMotionWorklet(ctx)
        const g = createSpatialGraph(ctx, {
          params,
          bypass: false,
          trimDb: 0,
          useWorklet: true,
          hrtfLatencySeconds: hrtfLatency,
          modes: allModes ? undefined : params.mode === 'off' ? [] : [params.mode],
          motion: withMotion ? {} : undefined,
        })
        src.connect(g.input)
        g.output.connect(ctx.destination)
      } else src.connect(ctx.destination)
      src.start()
      const t = performance.now()
      await ctx.startRendering()
      return performance.now() - t
    }
    // 単発の計測は JIT・CPU クロックの影響でばらつくため、ウォームアップ後に 3 回計測して中央値を使う
    const time = async (label: string, params: SpatialParams | null, withMotion: boolean, allModes: boolean) => {
      await renderOnce(params, withMotion, allModes)
      const runs = [await renderOnce(params, withMotion, allModes), await renderOnce(params, withMotion, allModes), await renderOnce(params, withMotion, allModes)]
      const ms = [...runs].sort((x, y) => x - y)[1]
      const load = ms / 1000 / mix.duration
      check(
        `${label}: 実時間比 ${(load * 100).toFixed(1)}%`,
        load < 0.5,
        `10 秒の処理に中央値 ${ms.toFixed(0)} ms（3 回: ${runs.map((r) => r.toFixed(0)).join(' / ')} ms）。リアルタイム再生の CPU 負荷の目安、50% 未満を合格`,
      )
    }
    await time('原音のみ（基準）', null, false, false)
    await time('CINEMA（Motion OFF、既存）', mp({ motionEnabled: false }), false, false)
    await time('CINEMA × ORBIT（Motion ON）', mp({ motionPreset: 'orbit' }), true, false)
    await time('HALL × ORBIT（Motion ON）', mp({ mode: 'hall', motionPreset: 'orbit' }), true, false)
    await time('再生時と同じ全チェーン構築（WIDE/CINEMA/HALL/MOTION、CINEMA × ORBIT 使用中）', mp({ motionPreset: 'orbit' }), true, true)
  }

  return results
}
