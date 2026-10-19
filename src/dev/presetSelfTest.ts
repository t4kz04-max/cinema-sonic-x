// Phase 05（空間音響プリセット・ORIGINAL/PROCESSED 比較・CUSTOM・解析の最適化）の自己診断。
// ?suite=preset で実行する（?groups=40-44 のように分けて実行できる）。CPU は ?suite=presetcpu。
// プリセットの音は、再生エンジンと同じ createOutputChain（重低音 → 空間）と、同じ処理計画（planProcessing / planSpatial）で
// オフラインレンダリングして測る。

import { AudioEngine } from '../audio/AudioEngine'
import { loadAlignWorklet } from '../audio/alignDelay'
import { analyzeSource, buildAnalysisExcerpt, planProcessing } from '../audio/analysis'
import { analysisStats } from '../audio/analysisStats'
import { DEFAULT_BASS_THRESHOLD_DB } from '../audio/bassSpec'
import { eqCapScale } from '../audio/biquadMath'
import { dspEquals, parseDspConfig, type DspConfig } from '../audio/dspConfig'
import type { DynamicsSettings } from '../audio/dynamicsTypes'
import { blockPeakPercentileDb, integratedLoudness, linearToDb, samplePeak } from '../audio/loudness'
import { applyDspToChain, createOutputChain, type OutputChain } from '../audio/outputChain'
import { getPreset, matchPreset, presetToDsp, SPATIAL_PRESETS, type SpatialPreset } from '../audio/presets/spatialPresets'
import { dynamicsSettingsFor, loadDynamicsWorklet } from '../audio/processingGraph'
import type { Envelope } from '../audio/spatial/motion'
import { computeEnvelope } from '../audio/spatial/motionEnvelope'
import type { MotionTransport } from '../audio/spatial/motionTypes'
import { analyzeSpatialSource, buildSpatialExcerpt, planSpatial } from '../audio/spatial/spatialAnalysis'
import { createSpatialGraph, loadMotionWorklet, measureHrtfLatency } from '../audio/spatial/spatialGraph'
import { DEFAULT_SPATIAL_PARAMS, isMotionActive, isTailActive, type SpatialParams } from '../audio/spatial/spatialSpec'
import { loadTailWorklet } from '../audio/spatial/tailEngine'
import { stereoMetrics, type StereoMetrics } from '../audio/stereoMetrics'
import { NORMAL_LOOP_RESET_FADE_SECONDS } from '../audio/transportOps'
import { deleteCustom, loadCustom, saveCustom } from '../utils/customPresetStorage'
import type { TestResult } from './dspSelfTest'
import { stopDecaySeconds } from './tailBaseline'
import { programAcoustic, programPop, programStereoMix, TEST_RATE, toBuffer } from './testSignals'

const RATE = TEST_RATE
const f1 = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}` : String(v))
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : String(v))
const chansOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const PRESETS = SPATIAL_PRESETS
const dspOf = (p: SpatialPreset) => presetToDsp(p)

let hrtfLatency = 0

// ---------------- 信号 ----------------

const sine = (f: number, a: number, seconds: number) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / RATE))
const zeros = (seconds: number) => new Float32Array(Math.round(seconds * RATE))
function noiseOf(seconds: number, seed: number, amp = 0.2): Float32Array {
  let s = seed >>> 0
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s / 0x100000000 - 0.5) * 2 * amp
  })
}
/** 1 次ローパス 2 段の差分による簡易ハイパス（測定用） */
function highpass(x: Float32Array, fc: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * fc) / RATE)
  let z1 = 0
  let z2 = 0
  return Float32Array.from(x, (v) => {
    z1 = (1 - a) * v + a * z1
    z2 = (1 - a) * z1 + a * z2
    return v - z2
  })
}
const concat = (...xs: Float32Array[]) => {
  const out = new Float32Array(xs.reduce((n, x) => n + x.length, 0))
  let o = 0
  for (const x of xs) {
    out.set(x, o)
    o += x.length
  }
  return out
}

// ---------------- 処理計画（再生エンジンと同じ手順） ----------------

interface ChainPlan {
  bassScale: number
  bassDynamics: DynamicsSettings
  spatialTrimDb: number
  envelope: Envelope | null
}

const planMemo = new Map<string, Promise<ChainPlan>>()

/** 再生エンジンと同じ解析: 重低音は 24 kHz の抜粋で planProcessing、空間は元のレートの抜粋で planSpatial */
function planFor(buf: AudioBuffer, label: string, dsp: DspConfig): Promise<ChainPlan> {
  const key = `${label}|${JSON.stringify(dsp)}`
  let p = planMemo.get(key)
  if (!p) {
    p = (async () => {
      const chans = chansOf(buf)
      const envelope = computeEnvelope(chans, RATE, dsp.spatial.motionSpeed / 100)
      let bassScale = eqCapScale(dsp.bass)
      let bassDynamics = dynamicsSettingsFor(dsp.bass.mode, DEFAULT_BASS_THRESHOLD_DB, 0)
      if (dsp.bassEnabled) {
        const ex = buildAnalysisExcerpt(buf)
        const src = await analyzeSource(ex)
        const plan = await planProcessing(ex, src, dsp.bass, { useWorklet: true, makeupCancel: 1 })
        bassScale = plan.scale
        bassDynamics = plan.dynamics
      }
      let spatialTrimDb = 0
      if (dsp.spatial.mode !== 'off') {
        // 再生エンジンと同じ: 重低音 ON なら重低音段を通した音で、チェーン全体を原音のラウドネスに合わせる
        const sx = buildSpatialExcerpt(buf)
        const before = await analyzeSpatialSource(sx)
        const bass = dsp.bassEnabled ? { params: dsp.bass, scale: bassScale, dynamics: bassDynamics } : undefined
        spatialTrimDb = (await planSpatial(sx, before, dsp.spatial, { useWorklet: true, hrtfLatencySeconds: hrtfLatency, envelope, bass })).trimDb
      }
      return { bassScale, bassDynamics, spatialTrimDb, envelope }
    })()
    planMemo.set(key, p)
  }
  return p
}

// ---------------- レンダリング ----------------

interface ChainEnv {
  ctx: OfflineAudioContext
  chain: OutputChain
}

interface RenderOpts {
  seconds?: number
  plan?: ChainPlan
  bypass?: boolean
  /** 時刻合わせ（再生エンジンと同じ。既定 true） */
  align?: boolean
  /** 全モードを構築する（再生エンジンと同じ。切替の試験用） */
  allModes?: boolean
  loop?: { start: number; end: number } | null
  /** 再生開始（ctx 時刻 when から位置 offset） */
  startAt?: { offset: number; when: number }
  actions?: [number, (e: ChainEnv) => void][]
}

interface Rendered {
  L: Float32Array
  R: Float32Array
  chain: OutputChain
}

async function renderChain(buf: AudioBuffer, dsp: DspConfig, o: RenderOpts = {}): Promise<Rendered> {
  const len = Math.round((o.seconds ?? buf.duration) * RATE)
  const ctx = new OfflineAudioContext(2, len, RATE)
  await loadDynamicsWorklet(ctx)
  await loadTailWorklet(ctx)
  await loadMotionWorklet(ctx)
  const align = (o.align ?? true) && (await loadAlignWorklet(ctx))
  const plan = o.plan
  const loop = o.loop ?? null
  const start = o.startAt ?? { offset: 0, when: 0 }
  const transport: MotionTransport = { playing: true, startedAt: start.when - start.offset, pausedAt: start.offset, loopStart: loop?.start ?? 0, loopEnd: loop?.end ?? 0 }
  const chain = createOutputChain(ctx, {
    dsp,
    bypass: o.bypass ?? false,
    useWorklet: true,
    bassScale: plan?.bassScale ?? eqCapScale(dsp.bass),
    bassDynamics: plan?.bassDynamics ?? dynamicsSettingsFor(dsp.bass.mode, DEFAULT_BASS_THRESHOLD_DB, 0),
    spatial: {
      trimDb: plan?.spatialTrimDb ?? 0,
      hrtfLatencySeconds: hrtfLatency,
      modes: o.allModes || dsp.spatial.mode === 'off' ? undefined : [dsp.spatial.mode],
      motion: { transport, envelope: plan?.envelope ?? null },
    },
    alignBypass: align,
  })
  const node = new AudioBufferSourceNode(ctx, { buffer: buf, loop: !!loop, loopStart: loop?.start ?? 0, loopEnd: loop?.end ?? 0 })
  node.connect(chain.input)
  chain.output.connect(ctx.destination)
  node.start(start.when, start.offset)
  const env: ChainEnv = { ctx, chain }
  for (const [t, fn] of o.actions ?? []) {
    void ctx.suspend(t).then(() => {
      fn(env)
      void ctx.resume()
    })
  }
  const r = await ctx.startRendering()
  return { L: r.getChannelData(0), R: r.getChannelData(1), chain }
}

// ---------------- 測定 ----------------

/** 純音のクリック指標: 2 階差分の最大値 ÷ 区間の最大振幅の純音として期待される値（1 前後が正常） */
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

/** 2 つの信号の相互相関が最大になるずれ（サンプル、b が a より遅れていれば正）。L+R のモノラル和で測る */
function bestLag(aL: Float32Array, aR: Float32Array, bL: Float32Array, bR: Float32Array, from: number, seconds: number, maxLagSeconds: number): number {
  const i0 = Math.round(from * RATE)
  const n = Math.round(seconds * RATE)
  const maxLag = Math.round(maxLagSeconds * RATE)
  const a = Float32Array.from({ length: n }, (_, i) => aL[i0 + i] + aR[i0 + i])
  const b = Float32Array.from({ length: n + 2 * maxLag }, (_, i) => bL[i0 - maxLag + i] + bR[i0 - maxLag + i])
  const corr = (lag: number) => {
    let s = 0
    for (let i = 0; i < n; i++) s += a[i] * b[i + maxLag + lag]
    return s
  }
  let best = 0
  let bestV = -Infinity
  // 粗く探してから細かく
  for (let lag = -maxLag; lag <= maxLag; lag += 8) {
    const v = corr(lag)
    if (v > bestV) {
      bestV = v
      best = lag
    }
  }
  for (let lag = Math.max(-maxLag, best - 8); lag <= Math.min(maxLag, best + 8); lag++) {
    const v = corr(lag)
    if (v > bestV) {
      bestV = v
      best = lag
    }
  }
  return best
}

/** 区間ごとの ILD（右 − 左、dB） */
function ildTrack(L: Float32Array, R: Float32Array, from: number, to: number, step: number): number[] {
  const out: number[] = []
  const n = Math.round(step * RATE)
  for (let s = Math.round(from * RATE); s + n <= Math.round(to * RATE); s += n) {
    let el = 0
    let er = 0
    for (let i = s; i < s + n; i++) {
      el += L[i] * L[i]
      er += R[i] * R[i]
    }
    out.push(10 * Math.log10((er + 1e-20) / (el + 1e-20)))
  }
  return out
}

function corrOf(a: number[], b: number[]): number {
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

const maxDiffDb = (a: Rendered, b: Rendered) => {
  let m = 0
  let pk = 0
  for (const [x, y] of [
    [a.L, b.L],
    [a.R, b.R],
  ]) {
    for (let i = 0; i < x.length; i++) {
      m = Math.max(m, Math.abs(x[i] - y[i]))
      pk = Math.max(pk, Math.abs(x[i]))
    }
  }
  return 20 * Math.log10(m / (pk + 1e-30) + 1e-30)
}

const metricsOf = (r: Rendered, from = 0, to?: number): StereoMetrics => {
  const a = Math.round(from * RATE)
  const b = to === undefined ? r.L.length : Math.round(to * RATE)
  return stereoMetrics([r.L.subarray(a, b), r.R.subarray(a, b)], RATE)
}

/** テストを実行しているブラウザの物理メモリ（MB）。実行スクリプト（CDP）が測って返す。測れない環境では null */
async function browserMemoryMb(): Promise<number | null> {
  const w = window as unknown as { csxMemSample?: (id: string) => void; __csxMem?: Record<string, number | null> }
  if (!w.csxMemSample) return null
  const id = String(Math.random())
  w.csxMemSample(id)
  for (let i = 0; i < 100; i++) {
    await sleep(100)
    if (w.__csxMem && id in w.__csxMem) return w.__csxMem[id]
  }
  return null
}

/**
 * メモリの測定値（MB）。ワーキングセットは GC の時期で数十 MB 揺れるため、1 秒待って GC してから
 * 0.5 秒おきに 3 回測った中央値を使う。測れない環境では null
 */
async function settledMemoryMb(): Promise<number | null> {
  const gc = () => (globalThis as { gc?: () => void }).gc?.()
  await sleep(1000)
  gc()
  const xs: number[] = []
  for (let k = 0; k < 3; k++) {
    await sleep(500)
    const m = await browserMemoryMb()
    if (m === null) return null
    xs.push(m)
  }
  return xs.sort((a, b) => a - b)[1]
}

/** 再生エンジンの解析（重低音・空間）が終わるまで待つ */
async function waitAnalysis(engine: AudioEngine, getStatus: () => { bass: string; spatial: string }, timeoutMs = 60000): Promise<boolean> {
  const t0 = performance.now()
  // デバウンス（250 ms）より長く待ってから判定する
  await sleep(400)
  while (performance.now() - t0 < timeoutMs) {
    const s = getStatus()
    if (s.bass !== 'measuring' && s.spatial !== 'measuring') {
      await sleep(300)
      const s2 = getStatus()
      if (s2.bass !== 'measuring' && s2.spatial !== 'measuring') return true
    }
    await sleep(100)
  }
  void engine
  return false
}

function groupRange(): [number, number] {
  const m = /(?:^|[?&])groups=(\d+)-(\d+)/.exec(typeof location === 'undefined' ? '' : location.search)
  return m ? [Number(m[1]), Number(m[2])] : [0, Infinity]
}

// ---------------- 試験 ----------------

export async function runPresetSelfTest(): Promise<TestResult[]> {
  const [g0, g1] = groupRange()
  const want = (n: number) => n >= g0 && n <= g1
  const results: TestResult[] = []
  let group = ''
  let lastGroup = ''
  const started = performance.now()
  const record = (name: string, pass: boolean, detail: string, info = false) => {
    results.push({ group, name, pass, detail, info })
    console.info(`[${((performance.now() - started) / 1000).toFixed(1)}s] ${info ? 'INFO' : pass ? 'PASS' : 'FAIL'} ${group} / ${name} :: ${detail}`)
    if (group !== lastGroup) {
      lastGroup = group
      ;(globalThis as { gc?: () => void }).gc?.()
    }
  }
  const check = (name: string, pass: boolean, detail: string) => record(name, pass, detail)
  const info = (name: string, detail: string) => record(name, true, detail, true)
  hrtfLatency = await measureHrtfLatency(RATE)

  group = '40. プリセットの定義（4 種・型付き設定・元データの保護・最大値の禁止）'
  if (want(40)) {
    check('4 つのプリセット（CINEMA 3D / LIVE ARENA / 360° MOTION / IMMERSIVE X）', PRESETS.map((p) => p.label).join(',') === 'CINEMA 3D,LIVE ARENA,360° MOTION,IMMERSIVE X', PRESETS.map((p) => `${p.id} v${p.version}`).join(' / '))
    check(
      '各プリセットに ID・表示名・説明・効果・版・Room/Motion/Tail/Bass の設定がある',
      PRESETS.every((p) => p.id && p.label && p.summary && p.description && p.effects.length > 0 && p.version >= 1 && p.dsp.room && p.dsp.motion && p.dsp.tail && p.dsp.bass),
      PRESETS.map((p) => `${p.label}: ${p.effects.length} 効果`).join(' / '),
    )
    const before = JSON.stringify(PRESETS)
    let threw = false
    try {
      ;(PRESETS[0].dsp.room as { intensity: number }).intensity = 100
    } catch {
      threw = true
    }
    const copy = dspOf(PRESETS[0])
    copy.spatial.intensity = 99
    copy.bass.bass = 99
    check('元データは凍結されていて書き換えられない（代入は例外、適用用のコピーを変えても元は不変）', threw && JSON.stringify(PRESETS) === before && dspOf(PRESETS[0]).spatial.intensity !== 99, `代入 ${threw ? '例外' : '通ってしまった'}`)
    const caps = PRESETS.map((p) => {
      const { room, motion, tail, bass } = p.dsp
      return Math.max(room.intensity, room.roomSize, room.depth, motion.speed, motion.depth, tail.length, tail.intensity, bass.bass, bass.sub)
    })
    check(
      'どのプリセットも最大値を使わない（INTENSITY・ROOM・DEPTH・Motion SPEED/DEPTH・Tail LENGTH/INTENSITY・BASS/SUB ≤ 70、EXTREME なし）',
      caps.every((c) => c <= 70) && PRESETS.every((p) => p.dsp.bass.mode === 'normal'),
      PRESETS.map((p, i) => `${p.label} 最大 ${caps[i]}`).join(' / '),
    )
    const bad = PRESETS.filter((p) => p.dsp.room.mode === 'hall' && p.dsp.motion.enabled)
    check('Phase 04 の既知 FAIL の組み合わせ（HALL × SWEEP × RIPPLE + DYNAMIC）と、その原因の HALL + Motion を使わない', bad.length === 0, bad.length ? bad.map((p) => p.label).join(', ') : '該当なし')
    const keys = PRESETS.map((p) => {
      const d = dspOf(p).spatial
      return `${d.mode}/${d.motionEnabled ? d.motionPreset : 'no-motion'}/${d.tailMode}${d.dynamicTail ? '+dyn' : ''}`
    })
    check('各プリセットで異なる DSP 構成（モード・Motion・Tail の組み合わせがすべて異なる）', new Set(keys).size === 4, keys.join(' / '))
    const required: [string, (p: SpatialPreset) => boolean][] = [
      ['CINEMA 3D: CINEMA・CINEMATIC・NATURAL・CENTER LOCK ≥ 80・Motion DEPTH ≤ 40', (p) => p.dsp.room.mode === 'cinema' && p.dsp.motion.enabled && p.dsp.motion.preset === 'cinematic' && p.dsp.tail.mode === 'natural' && p.dsp.motion.centerLock >= 80 && p.dsp.motion.depth <= 40],
      ['LIVE ARENA: HALL・NATURAL（既存 HALL の IR）・DYNAMIC TAIL・LENGTH > 50', (p) => p.dsp.room.mode === 'hall' && p.dsp.tail.mode === 'natural' && p.dsp.tail.dynamic && p.dsp.tail.length > 50],
      ['360° MOTION: ORBIT（レイヤーごとの移動）・CENTER LOCK ≥ 80', (p) => p.dsp.motion.enabled && p.dsp.motion.preset === 'orbit' && p.dsp.motion.centerLock >= 80],
      ['IMMERSIVE X: Motion（HRTF・レイヤー）・初期反射（CINEMA / HALL）・Spatial Tail・DYNAMIC TAIL', (p) => p.dsp.motion.enabled && p.dsp.room.mode !== 'wide' && p.dsp.tail.mode !== 'off' && p.dsp.tail.dynamic],
    ]
    required.forEach(([name, fn], i) => check(name, fn(PRESETS[i]), JSON.stringify(PRESETS[i].dsp)))
  }

  group = '41. プリセットの適用（再生エンジン: 設定値がそのまま DSP に渡る）'
  if (want(41)) {
    const engine = new AudioEngine(0)
    try {
      engine.setBuffer(programStereoMix(4))
      for (const p of PRESETS) {
        engine.applyDsp(dspOf(p))
        const got = engine.dspConfig()
        check(`${p.label}: 再生エンジンの DSP 設定 = プリセットの設定（全項目）`, dspEquals(got, dspOf(p)) && matchPreset(got) === p.id, `mode ${got.spatial.mode}・Motion ${got.spatial.motionEnabled ? got.spatial.motionPreset : 'OFF'}・Tail ${got.spatial.tailMode}${got.spatial.dynamicTail ? '+DYN' : ''}・重低音 ${got.bassEnabled ? `${got.bass.bass}/${got.bass.sub}` : 'OFF'}`)
      }
      const got = engine.dspConfig()
      got.spatial.mode = 'wide'
      check('返された設定を変更しても、エンジンとプリセットに影響しない（コピー）', engine.dspConfig().spatial.mode === dspOf(PRESETS[3]).spatial.mode, `エンジン ${engine.dspConfig().spatial.mode}`)
    } finally {
      engine.dispose()
    }
    // 処理後の音が実際に異なる（オフライン、同じ音源・処理計画）
    const mix = programStereoMix(6)
    const outs: Rendered[] = []
    for (const p of PRESETS) outs.push(await renderChain(mix, dspOf(p), { plan: await planFor(mix, 'mix6', dspOf(p)) }))
    const diffs: string[] = []
    let allDiff = true
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        let d = 0
        let e = 0
        for (const [x, y] of [
          [outs[i].L, outs[j].L],
          [outs[i].R, outs[j].R],
        ]) {
          for (let k = RATE; k < x.length; k++) {
            d += (x[k] - y[k]) ** 2
            e += x[k] ** 2
          }
        }
        const db = 10 * Math.log10(d / (e + 1e-30))
        if (db < -20) allDiff = false
        diffs.push(`${i + 1}-${j + 1}: ${f1(db)} dB`)
      }
    }
    check('4 つのプリセットの出力がそれぞれ異なる（差のエネルギー比 ≥ −20 dB）', allDiff, diffs.join(' / '))
    const ms = outs.map((o) => metricsOf(o, 1))
    info('プリセットごとのステレオ指標（ステレオミックス 6 秒）', PRESETS.map((p, i) => `${p.label}: 相関 ${f2(ms[i].correlation)}・中高域 S/M ${f1(ms[i].bandWidthDb.high)} dB`).join(' / '))
  }

  group = '42. プリセット切替のクリックノイズ（左だけの 440 Hz、全モード構築、5 回切替）'
  if (want(42)) {
    const tone = toBuffer([sine(440, 0.3, 9), zeros(9)])
    const seq = [PRESETS[0], PRESETS[1], PRESETS[2], PRESETS[3], PRESETS[0], PRESETS[2]]
    const base = clickRatio((await renderChain(tone, dspOf(PRESETS[0]), { allModes: true })).L, 440, 1, 8.5)
    const out = await renderChain(tone, dspOf(seq[0]), {
      allModes: true,
      actions: seq.slice(1).map((p, k) => [1.5 + k * 1.4, (e: ChainEnv) => applyDspToChain(e.chain, dspOf(p), false, eqCapScale(dspOf(p).bass))] as [number, (e: ChainEnv) => void]),
    })
    const crs = seq.slice(1).map((_, k) => clickRatio(out.L, 440, 1.5 + k * 1.4 - 0.01, 1.5 + k * 1.4 + 0.6))
    check(
      'プリセット切替（CINEMA 3D → LIVE ARENA → 360° → IMMERSIVE X → CINEMA 3D → 360°）でクリックなし（2 階差分比 ≤ max(1.5, 静止時 × 1.25)）',
      crs.every((r) => r <= Math.max(1.5, base * 1.25)),
      `${crs.map(f2).join(' / ')}（静止時 ${f2(base)}）`,
    )
    check('切替中も出力が有限・ピーク ≤ −1 dBFS（リミッター ON）', [out.L, out.R].every((x) => x.every((v) => Number.isFinite(v))) && linearToDb(samplePeak([out.L, out.R])) <= -0.99, `${f2(linearToDb(samplePeak([out.L, out.R])))} dBFS`)
  }

  group = '43. ORIGINAL / PROCESSED 比較（時刻合わせ・ビット一致・切替のクリック・再生位置）'
  if (want(43)) {
    const mix = programStereoMix(5)
    for (const p of PRESETS) {
      const dsp = dspOf(p)
      const orig = await renderChain(mix, dsp, { bypass: true })
      const n = Math.round(((orig.chain.spatial.bypassAlignSeconds() ?? 0) + orig.chain.bass.latencySeconds) * RATE)
      let exact = true
      const src = chansOf(mix)
      for (let c = 0; c < 2 && exact; c++) {
        const y = c === 0 ? orig.L : orig.R
        for (let i = 0; i < y.length; i++) {
          const x = i - n >= 0 && i - n < src[c].length ? src[c][i - n] : 0
          if (y[i] !== x) {
            exact = false
            break
          }
        }
      }
      const expected = Math.round((orig.chain.spatial.latencySeconds() + orig.chain.bass.latencySeconds) * RATE)
      check(`${p.label}: ORIGINAL = 原音を ${n} サンプル（${((n / RATE) * 1000).toFixed(1)} ms）遅らせたものとビット一致・遅延 = 処理経路の遅延`, exact && n === expected, `処理経路の遅延 ${expected} サンプル`)
      // 時間差は「中央の音の直接音の到達時刻」で測る（時刻合わせの目標。耳は最初に届く直接音で時刻を感じる）。
      // L=R のインパルスを通し、出力が最大値の −12 dB を最初に超えた時刻を直接音の到達とする。
      // 相互相関の最大位置は、反射音が直接音より強い設定（DEPTH が大きい）では反射音を指し、楽曲相当信号の全帯域では
      // 重低音段の低域の位相変化と周期的なベースで周期単位でずれるため、参考値（INFO）にとどめる
      const imp = new Float32Array(Math.round(2 * RATE))
      imp[RATE] = 0.5
      const ib = toBuffer([imp, imp.slice()])
      const plan = await planFor(mix, 'mix5', dsp)
      const io = await renderChain(ib, dsp, { bypass: true })
      const ip = await renderChain(ib, dsp, { plan })
      const onset = (r: Rendered) => {
        let mx = 0
        for (let i = 0; i < r.L.length; i++) mx = Math.max(mx, Math.abs(r.L[i]) + Math.abs(r.R[i]))
        for (let i = 0; i < r.L.length; i++) if (Math.abs(r.L[i]) + Math.abs(r.R[i]) >= mx * 0.25) return i
        return -1
      }
      const lag = onset(ip) - onset(io)
      check(`${p.label}: 中央の音の直接音の到達時刻が ORIGINAL と PROCESSED で 1 ms 以内`, Math.abs(lag) <= RATE * 0.001, `${lag} サンプル（${((lag / RATE) * 1000).toFixed(2)} ms）。時刻合わせなしの場合の遅延 ${((expected / RATE) * 1000).toFixed(1)} ms`)
      const center = toBuffer([noiseOf(5, 7), noiseOf(5, 7)])
      const co = await renderChain(center, dsp, { bypass: true })
      const cp = await renderChain(center, dsp, { plan })
      const lagC = bestLag(co.L, co.R, cp.L, cp.R, 1.5, 2, 0.08)
      const proc = await renderChain(mix, dsp, { plan })
      const lagMix = bestLag(orig.L, orig.R, proc.L, proc.R, 1.5, 2, 0.08)
      const hpMix = (x: Float32Array) => highpass(x, 300)
      const lagHigh = bestLag(hpMix(orig.L), hpMix(orig.R), hpMix(proc.L), hpMix(proc.R), 1.5, 2, 0.08)
      const ms2 = (v: number) => `${((v / RATE) * 1000).toFixed(2)} ms`
      info(`${p.label}: 相互相関の最大位置（参考）`, `中央のノイズ ${ms2(lagC)}・ステレオミックス全帯域 ${ms2(lagMix)}・300 Hz 以上 ${ms2(lagHigh)}`)
    }
    // 切替のクリック: 左だけの 440 Hz で ORIGINAL ⇄ PROCESSED を 6 回
    const tone = toBuffer([sine(440, 0.3, 8), zeros(8)])
    for (const p of [PRESETS[0], PRESETS[3]]) {
      const dsp = dspOf(p)
      const base = clickRatio((await renderChain(tone, dsp)).L, 440, 1, 7.5)
      const ts = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5]
      const sw = await renderChain(tone, dsp, {
        actions: ts.map((t, k) => [t, (e: ChainEnv) => applyDspToChain(e.chain, dsp, k % 2 === 0, eqCapScale(dsp.bass))] as [number, (e: ChainEnv) => void]),
      })
      const crs = ts.map((t) => clickRatio(sw.L, 440, t - 0.01, t + 0.2))
      check(`${p.label}: ORIGINAL ⇄ PROCESSED を 6 回切り替えてもクリックなし（2 階差分比 ≤ max(1.5, 処理音の静止時 × 1.25)）`, crs.every((r) => r <= Math.max(1.5, base * 1.25)), `${crs.map(f2).join(' / ')}（静止時 ${f2(base)}）`)
    }
    // 実時間の再生エンジン: 切替で再生位置が飛ばない・止まらない（音源は 1 つ）
    const engine = new AudioEngine(0)
    try {
      engine.setBuffer(programStereoMix(12))
      engine.applyDsp(dspOf(PRESETS[3]))
      await engine.play()
      await sleep(500)
      const pos: number[] = []
      const wall: number[] = []
      for (let k = 0; k < 8; k++) {
        engine.setBypass(k % 2 === 0)
        await sleep(300)
        pos.push(engine.getPosition())
        wall.push(performance.now() / 1000)
      }
      engine.setBypass(false)
      const steps = pos.slice(1).map((v, i) => v - pos[i] - (wall[i + 1] - wall[i]))
      check('実時間: ORIGINAL ⇄ PROCESSED を 8 回切り替えても再生位置が連続（経過時間との差 ≤ 50 ms）', steps.every((d) => Math.abs(d) <= 0.05), `差 ${steps.map((d) => (d * 1000).toFixed(0)).join(' / ')} ms`)
    } finally {
      engine.dispose()
    }
  }

  group = '44. CUSTOM（詳細設定の変更・元データ不変・設定の検証）'
  if (want(44)) {
    const before = JSON.stringify(PRESETS)
    const c = dspOf(PRESETS[1])
    c.spatial.tailLength = 80
    check('プリセット適用後に 1 項目変えると、どのプリセットにも一致しない（CUSTOM）', matchPreset(c) === null && matchPreset(dspOf(PRESETS[1])) === 'live-arena', `tailLength 65 → 80: 一致 ${matchPreset(c) ?? 'なし'}`)
    c.spatial.tailLength = 65
    check('同じ値に戻すと元のプリセットに一致する', matchPreset(c) === 'live-arena', matchPreset(c) ?? 'なし')
    check('CUSTOM の操作でプリセットの元データは変わらない', JSON.stringify(PRESETS) === before, '凍結 + コピー')
    const round = parseDspConfig(JSON.parse(JSON.stringify(dspOf(PRESETS[2]))))
    check('設定の検証: 正しい設定はそのまま読める（JSON の往復で同じ）', !!round && dspEquals(round, dspOf(PRESETS[2])), round ? 'OK' : 'null')
    const broken: [string, unknown][] = [
      ['不明なモード', { ...dspOf(PRESETS[0]), spatial: { ...dspOf(PRESETS[0]).spatial, mode: 'surround' } }],
      ['数値が NaN', { ...dspOf(PRESETS[0]), spatial: { ...dspOf(PRESETS[0]).spatial, depth: Number.NaN } }],
      ['項目の欠落', { spatial: dspOf(PRESETS[0]).spatial, bass: dspOf(PRESETS[0]).bass }],
      ['型の違い', 'cinema'],
    ]
    check('設定の検証: 壊れた設定は読み込まない（null）', broken.every(([, v]) => parseDspConfig(v) === null), broken.map(([k, v]) => `${k}: ${parseDspConfig(v) === null ? '拒否' : '受理'}`).join(' / '))
    const clamped = parseDspConfig({ ...dspOf(PRESETS[0]), spatial: { ...dspOf(PRESETS[0]).spatial, intensity: 250 } })
    check('設定の検証: 範囲外の数値は 0〜100 に丸める', clamped?.spatial.intensity === 100, `250 → ${clamped?.spatial.intensity}`)
  }

  group = '45. 設定の保存（ブラウザ内保存・失敗時も再生を壊さない）'
  if (want(45)) {
    deleteCustom()
    const cfg = dspOf(PRESETS[2])
    cfg.spatial.motionSpeed = 63
    const saved = saveCustom(cfg, 'motion-360')
    const loaded = loadCustom()
    check('保存 → 読み込みで同じ設定・元のプリセットと版', saved.ok && loaded.ok && !!loaded.value && dspEquals(loaded.value.dsp, cfg) && loaded.value.base?.id === 'motion-360' && loaded.value.base.version === getPreset('motion-360').version, loaded.ok ? `base ${loaded.value?.base?.id} v${loaded.value?.base?.version}` : loaded.message)
    let raw = ''
    try {
      raw = localStorage.getItem('cinema-sonic-x.custom-preset') ?? ''
    } catch {
      raw = ''
    }
    check('保存するのは DSP 設定の数値だけ（音声・ファイル名を含まない）', raw.length > 0 && raw.length < 2000 && !/fileName|\.wav|\.mp3/i.test(raw), `${raw.length} 文字`)
    // 失敗の再現: setItem が例外（容量超過・保存のブロック）
    const orig = Storage.prototype.setItem
    const engine = new AudioEngine(0)
    try {
      engine.setBuffer(programStereoMix(6))
      engine.applyDsp(dspOf(PRESETS[0]))
      await engine.play()
      await sleep(300)
      const p0 = engine.getPosition()
      Storage.prototype.setItem = function () {
        throw new DOMException('quota', 'QuotaExceededError')
      }
      let threw = false
      let r: ReturnType<typeof saveCustom> | null = null
      try {
        r = saveCustom(cfg, null)
      } catch {
        threw = true
      }
      Storage.prototype.setItem = orig
      await sleep(500)
      const p1 = engine.getPosition()
      check('保存に失敗しても例外を投げず、失敗理由を返す', !threw && !!r && !r.ok && r.message.includes('再生には影響しません'), r && !r.ok ? r.message : threw ? '例外' : '成功扱い')
      check('保存の失敗中も再生が続く（再生位置が進む）', p1 - p0 >= 0.3, `${p0.toFixed(2)} → ${p1.toFixed(2)} 秒`)
    } finally {
      Storage.prototype.setItem = orig
      engine.dispose()
    }
    try {
      localStorage.setItem('cinema-sonic-x.custom-preset', '{"schema":1,"dsp":{"spatial":{"mode":"x"}}}')
    } catch {
      // 保存できない環境
    }
    const bad = loadCustom()
    check('壊れた保存データは読み込まず、メッセージを返す', !bad.ok, bad.ok ? '読み込んでしまった' : bad.message)
    try {
      localStorage.setItem('cinema-sonic-x.custom-preset', '{not json')
    } catch {
      // 保存できない環境
    }
    const bad2 = loadCustom()
    check('JSON として壊れた保存データも同様', !bad2.ok, bad2.ok ? '読み込んでしまった' : bad2.message)
    deleteCustom()
    const none = loadCustom()
    check('削除後は保存なし', none.ok && none.value === null, none.ok ? String(none.value) : none.message)
  }

  group = '46. Motion の再現性（同じ設定・同じ時刻 → 同じ音、シーク後も同じ動き）'
  if (want(46)) {
    const mix = programStereoMix(8)
    for (const p of PRESETS.filter((x) => x.dsp.motion.enabled)) {
      const dsp = dspOf(p)
      const plan = await planFor(mix, 'mix8', dsp)
      const a = await renderChain(mix, dsp, { plan })
      const b = await renderChain(mix, dsp, { plan })
      const d = maxDiffDb(a, b)
      check(`${p.label}: 2 回のオフラインレンダリングが一致（差 ≤ −120 dB、畳み込みの揺らぎのみ）`, d <= -120, `${f1(d)} dB`)
      // シーク: 位置 4 秒から再生した音の ILD の動き = 最初から再生した音の 4 秒以降の動き
      const s = await renderChain(mix, dsp, { plan, startAt: { offset: 4, when: 0 }, seconds: 4 })
      const full = ildTrack(a.L, a.R, 5, 8, 0.1)
      const seek = ildTrack(s.L, s.R, 1, 4, 0.1)
      const mad = full.reduce((m, v, i) => m + Math.abs(v - seek[i]), 0) / full.length
      check(`${p.label}: 4 秒へシークした後の左右の動き（ILD、0.1 秒ごと）が通しの再生と一致（相関 ≥ 0.95・平均差 ≤ 1 dB）`, corrOf(full, seek) >= 0.95 && mad <= 1, `相関 ${f2(corrOf(full, seek))}・平均差 ${f2(mad)} dB（シーク前の残響の違いを含む）`)
    }
  }

  group = '47. Tail の再現性（停止後の余韻）'
  if (want(47)) {
    const mix = programStereoMix(3)
    const sig = toBuffer(chansOf(mix).map((c) => concat(c, zeros(4))))
    for (const p of PRESETS.filter((x) => x.dsp.tail.mode !== 'off')) {
      const dsp = dspOf(p)
      const plan = await planFor(mix, 'mix3', dsp)
      const a = await renderChain(sig, dsp, { plan })
      const b = await renderChain(sig, dsp, { plan })
      const t = stopDecaySeconds({ getChannelData: (c: number) => (c === 0 ? a.L : a.R) }, 3)
      check(`${p.label}: 音源の終了後に余韻が残る（−60 dB まで ≥ 1 秒）・2 回のレンダリングが一致（≤ −120 dB）`, t >= 1 && maxDiffDb(a, b) <= -120, `余韻 ${(t * 1000).toFixed(0)} ms、差 ${f1(maxDiffDb(a, b))} dB`)
    }
  }

  group = '48. ループ再生との連携（2 秒 × 6 周、NORMAL は境界で残響を消去・SPATIAL は重ねる）'
  if (want(48)) {
    const mix = programStereoMix(2)
    const loop = { start: 0, end: 2 }
    for (const p of PRESETS) {
      const dsp = dspOf(p)
      const plan = await planFor(mix, 'mix2', dsp)
      for (const type of ['normal', 'spatial'] as const) {
        const r = await renderChain(mix, dsp, {
          plan,
          loop,
          seconds: 12,
          actions: type === 'normal' ? [2, 4, 6, 8, 10].map((tb) => [tb - 0.4, (e: ChainEnv) => e.chain.spatial.resetReverb(tb, NORMAL_LOOP_RESET_FADE_SECONDS)] as [number, (e: ChainEnv) => void]) : [],
        })
        const loud = [2, 3, 4, 5].map((k) => integratedLoudness([r.L.subarray(k * 2 * RATE, (k + 1) * 2 * RATE), r.R.subarray(k * 2 * RATE, (k + 1) * 2 * RATE)], RATE))
        const spread = Math.max(...loud) - Math.min(...loud)
        const pk = linearToDb(samplePeak([r.L, r.R]))
        check(
          `${p.label} × ${type.toUpperCase()} LOOP: 3 周目以降のラウドネスの幅 ≤ 0.2 LU・ピーク ≤ −1 dBFS・有限`,
          spread <= 0.2 && pk <= -0.99 && [r.L, r.R].every((x) => x.every((v) => Number.isFinite(v))),
          `${loud.map(f1).join(' / ')} LUFS（幅 ${f2(spread)} LU）、ピーク ${f2(pk)} dBFS`,
        )
      }
    }
  }

  // 49: 音響品質（3 種の楽曲相当信号）。重いため、?groups=49-49&program=pop のように 1 曲ずつ分けて実行できる
  group = '49. 音響品質（ラウドネス・ピーク・位相・モノラル互換性。処理計画・リミッター ON、全チェーン）'
  if (want(49)) {
    const which = /(?:^|[?&])program=(\w+)/.exec(location.search)?.[1]
    const programs: [string, () => AudioBuffer][] = (
      [
        ['pop', () => programPop(10)],
        ['mix', () => programStereoMix(10)],
        ['acoustic', () => programAcoustic(10)],
      ] as [string, () => AudioBuffer][]
    ).filter(([k]) => !which || k === which)
    for (const [label, make] of programs) {
      const buf = make()
      const before = stereoMetrics(chansOf(buf), RATE)
      for (const p of PRESETS) {
        const dsp = dspOf(p)
        const plan = await planFor(buf, label, dsp)
        const r = await renderChain(buf, dsp, { plan })
        // 時刻合わせの遅延（最大 約 50 ms）だけ末尾が切れる分は、ラウドネスに影響しない程度
        const m = metricsOf(r)
        // 重低音 OFF にした場合（空間段だけ。計画も重低音なしで立て直す）
        const noBass = { ...dsp, bassEnabled: false }
        const spatialOnly = await renderChain(buf, noBass, { plan: await planFor(buf, label, noBass) })
        const ms = metricsOf(spatialOnly)
        const monoDrop = m.monoLoudnessLufs - m.loudnessLufs - (before.monoLoudnessLufs - before.loudnessLufs)
        const tag = `${p.label} × ${label}`
        check(`${tag}: ピーク ≤ −1 dBFS`, m.peakDb <= -0.99, `${f2(m.peakDb)} dBFS`)
        check(`${tag}: プリセットのまま（重低音 + 空間）のラウドネスが原音と ±1 LU 以内`, Math.abs(m.loudnessLufs - before.loudnessLufs) <= 1, `${f1(m.loudnessLufs - before.loudnessLufs)} LU（空間段のトリム ${f1(plan.spatialTrimDb)} dB）`)
        check(`${tag}: 重低音 OFF（空間段のみ）のラウドネスが原音と ±1 LU 以内`, Math.abs(ms.loudnessLufs - before.loudnessLufs) <= 1, `${f1(ms.loudnessLufs - before.loudnessLufs)} LU`)
        const mOnly = metricsOf(spatialOnly)
        check(`${tag}（重低音 OFF）: ピーク ≤ −1 dBFS`, mOnly.peakDb <= -0.99, `${f2(mOnly.peakDb)} dBFS`)
        check(
          `${tag}: 位相相関 ≥ 0・低域の相関が原音 − 0.05 以上・モノラル和の低下の増分 ≥ −1.5 LU`,
          m.correlation >= 0 && m.bandCorrelation.low >= before.bandCorrelation.low - 0.05 && monoDrop >= -1.5,
          `相関 ${f2(before.correlation)}→${f2(m.correlation)}、低域 ${f2(before.bandCorrelation.low)}→${f2(m.bandCorrelation.low)}、モノラル和 ${f1(monoDrop)} LU`,
        )
      }
    }
  }

  group = '50. 解析処理の最適化（文脈の数・キャッシュ・長時間使用のメモリ）'
  if (want(50)) {
    // (a) 空間解析の省略が結果を変えない: ワークレットなしの 1 回目・リミッターが働かない場合の 2 回目の省略
    const mix = programStereoMix(8)
    const ex = buildSpatialExcerpt(mix)
    const before = await analyzeSpatialSource(ex)
    for (const params of [
      { ...DEFAULT_SPATIAL_PARAMS, mode: 'wide' },
      { ...DEFAULT_SPATIAL_PARAMS, mode: 'cinema' },
      { ...DEFAULT_SPATIAL_PARAMS, mode: 'hall' },
      dspOf(PRESETS[1]).spatial,
      dspOf(PRESETS[3]).spatial,
    ] as SpatialParams[]) {
      const w0 = analysisStats.workletRenders
      const r0 = analysisStats.renders
      const pl = await planSpatial(ex, before, params, { useWorklet: true, hrtfLatencySeconds: hrtfLatency })
      const usedW = analysisStats.workletRenders - w0
      const used = analysisStats.renders - r0
      // 比較: 省略せずに実際のグラフ（ワークレット・リミッター込み）でレンダリング
      const ref = await renderSpatialOnly(ex, params, pl.trimDb, true, pl.wideSideCapDb)
      const mr = stereoMetrics(ref, RATE)
      const ok = !!pl.after && Math.abs(pl.after.loudnessLufs - mr.loudnessLufs) <= 0.05 && Math.abs(pl.after.correlation - mr.correlation) <= 0.005 && Math.abs(pl.after.peakDb - mr.peakDb) <= 0.1
      const label = `${params.mode.toUpperCase()}${isMotionActive(params) ? ` × ${params.motionPreset.toUpperCase()}` : ''}${isTailActive(params) ? ` × ${params.tailMode.toUpperCase()}` : ''}`
      check(
        `${label}: 省略した解析の測定値 = 省略しない場合（ラウドネス ±0.05 LU・相関 ±0.005・ピーク ±0.1 dB）`,
        ok,
        `文脈 ${used} 個（うちワークレット ${usedW}）。ラウドネス ${pl.after?.loudnessLufs.toFixed(2)} / ${mr.loudnessLufs.toFixed(2)} LUFS、相関 ${pl.after?.correlation.toFixed(3)} / ${mr.correlation.toFixed(3)}、ピーク ${pl.after?.peakDb.toFixed(2)} / ${mr.peakDb.toFixed(2)} dBFS`,
      )
    }
    // (b) 実時間の再生エンジン: プリセットを 5 周切り替えても、2 周目以降は解析しない（キャッシュ）・メモリが増え続けない
    const engine = new AudioEngine(0)
    let status = { bass: 'idle', spatial: 'idle' }
    let hits = 0
    engine.onDspStatusChange((s) => {
      status = { bass: s.analysis, spatial: s.spatial.analysis }
      hits = s.compare.analysis.cacheHits
    })
    try {
      engine.setBuffer(programStereoMix(20))
      await engine.play()
      await waitAnalysis(engine, () => status)
      const rounds: { renders: number; worklet: number; mem: number | null; hits: number }[] = []
      const m0 = await settledMemoryMb()
      const w0 = analysisStats.workletRenders
      for (let round = 0; round < 5; round++) {
        for (const p of PRESETS) {
          engine.applyDsp(dspOf(p))
          await waitAnalysis(engine, () => status)
        }
        rounds.push({ renders: analysisStats.renders, worklet: analysisStats.workletRenders - w0, mem: await settledMemoryMb(), hits })
      }
      const later = rounds[4].worklet - rounds[0].worklet
      check('プリセットを 5 周（20 回）切り替え: 2 周目以降は解析用の文脈を作らない（キャッシュから反映）', later === 0 && rounds[4].hits - rounds[0].hits >= 16, `1 周目 ワークレット文脈 ${rounds[0].worklet} 個 → 5 周目まで追加 ${later} 個、キャッシュ反映 ${rounds[4].hits - rounds[0].hits} 回`)
      if (m0 === null || rounds.some((r) => r.mem === null)) {
        check('長時間使用のメモリ: 2〜5 周目の増加 ≤ 30 MB', false, '未実行: ブラウザのメモリを測れない環境（npm run test:preset で実行してください）')
      } else {
        const mem = rounds.map((r) => r.mem!)
        check('長時間使用のメモリ: 2〜5 周目の増加 ≤ 30 MB（1 周目は解析分だけ増える）', mem[4] - mem[0] <= 30, `開始 ${m0.toFixed(0)} MB → 各周 ${mem.map((v) => v.toFixed(0)).join(' / ')} MB（1 周目 ${f1(mem[0] - m0)} MB、2〜5 周目 ${f1(mem[4] - mem[0])} MB）`)
        info('1 周目の増加（解析用の文脈。ブラウザが解放しない）', `${f1(mem[0] - m0)} MB ÷ ワークレット文脈 ${rounds[0].worklet} 個 ≒ ${f1((mem[0] - m0) / Math.max(1, rounds[0].worklet))} MB / 個（20 秒のステレオ音源、プリセット 4 種を初めて解析）`)
      }
      // (c) 同じ設定の重複実行の防止: 同じプリセットを続けて 5 回適用しても解析しない
      const r1 = analysisStats.renders
      for (let k = 0; k < 5; k++) engine.applyDsp(dspOf(PRESETS[3]))
      await waitAnalysis(engine, () => status)
      check('同じ設定を続けて適用しても解析しない（重複実行の防止）', analysisStats.renders === r1, `追加 ${analysisStats.renders - r1} 回`)
      // (d) スライダー操作相当: 30 ms ごとに 20 回変更 → 解析は最後の値で 1 回（デバウンス 250 ms）
      const r2 = analysisStats.renders
      const s0 = dspOf(PRESETS[1])
      for (let k = 0; k < 20; k++) {
        engine.applyDsp({ ...s0, spatial: { ...s0.spatial, intensity: 30 + k } })
        await sleep(30)
      }
      await waitAnalysis(engine, () => status)
      const spatialRenders = analysisStats.renders - r2
      check('スライダー操作相当（30 ms ごとに 20 回）: 空間の解析は 1 回分だけ（≤ 2 文脈）', spatialRenders <= 2, `${spatialRenders} 文脈`)
    } finally {
      engine.dispose()
    }
  }

  group = '51. Phase 04 の既知 FAIL の原因調査（HALL × SWEEP × RIPPLE + DYNAMIC、ステレオミックス 8 秒、空間段のみ）'
  if (want(51)) {
    const mix = programStereoMix(8)
    const before = stereoMetrics(chansOf(mix), RATE)
    const ex = buildSpatialExcerpt(mix)
    const src = await analyzeSpatialSource(ex)
    const hallP = (patch: Partial<SpatialParams>): SpatialParams => ({ ...DEFAULT_SPATIAL_PARAMS, mode: 'hall', motionEnabled: true, motionPreset: 'sweep', tailMode: 'ripple', dynamicTail: true, ...patch })
    const variants: [string, SpatialParams][] = [
      ['FAIL の組み合わせ', hallP({})],
      ['DYNAMIC TAIL なし', hallP({ dynamicTail: false })],
      ['Tail OFF（既存 HALL の残響）', hallP({ tailMode: 'off', dynamicTail: false })],
      ['NATURAL + DYNAMIC', hallP({ tailMode: 'natural' })],
      ['SWEEP → CINEMATIC', hallP({ motionPreset: 'cinematic' })],
      ['Motion OFF', hallP({ motionEnabled: false })],
      ['IMMERSIVE X の設定', dspOf(PRESETS[3]).spatial],
    ]
    for (const [label, params] of variants) {
      const probe = await renderSpatialOnly(mix, params, 0, false)
      const probeLufs = integratedLoudness(probe, RATE)
      const peak999 = blockPeakPercentileDb(probe, RATE, 0.999)
      const need = before.loudnessLufs - probeLufs
      const cap = -1 + 3 - peak999
      const pl = await planSpatial(ex, src, params, { useWorklet: true, hrtfLatencySeconds: hrtfLatency })
      const fin = stereoMetrics(await renderSpatialOnly(mix, params, pl.trimDb, true), RATE)
      info(
        label,
        `トリム前 ${f1(probeLufs - before.loudnessLufs)} LU・ブロックピーク(99.9%) ${f2(peak999)} dBFS・ピーク対ラウドネス比 ${f1(peak999 - probeLufs)} dB → 必要なトリム ${f1(need)} dB / 予算内の上限 ${f1(cap)} dB → 適用 ${f1(pl.trimDb)} dB → 結果 ${f1(fin.loudnessLufs - before.loudnessLufs)} LU`,
      )
    }
    info('原音', `${before.loudnessLufs.toFixed(1)} LUFS・ブロックピーク(99.9%) ${f2(blockPeakPercentileDb(chansOf(mix), RATE, 0.999))} dBFS・ピーク対ラウドネス比 ${f1(blockPeakPercentileDb(chansOf(mix), RATE, 0.999) - before.loudnessLufs)} dB`)
  }

  return results
}

/** 空間グラフだけを通す（既知 FAIL の調査・解析の省略の検証用。再生時と同じ出力段） */
async function renderSpatialOnly(buf: AudioBuffer, params: SpatialParams, trimDb: number, limiter = true, wideSideCapDb?: number): Promise<Float32Array[]> {
  const ctx = new OfflineAudioContext(2, buf.length + buf.sampleRate, buf.sampleRate)
  await loadDynamicsWorklet(ctx)
  await loadTailWorklet(ctx)
  const motion = isMotionActive(params) && (await loadMotionWorklet(ctx))
  const g = createSpatialGraph(ctx, {
    params,
    bypass: false,
    trimDb,
    useWorklet: true,
    hrtfLatencySeconds: hrtfLatency,
    modes: params.mode === 'off' ? [] : [params.mode],
    limiterEnabled: limiter,
    wideSideCapDb,
    motion: motion ? { envelope: null } : undefined,
  })
  const src = new AudioBufferSourceNode(ctx, { buffer: buf })
  src.connect(g.input)
  g.output.connect(ctx.destination)
  src.start()
  const r = await ctx.startRendering()
  return [r.getChannelData(0), r.getChannelData(1)]
}

/** 52. CPU 負荷（?suite=presetcpu） */
export async function runPresetCpuTest(): Promise<TestResult[]> {
  const results: TestResult[] = []
  const group = '52. CPU 負荷（再生時と同じ全チェーン: 重低音 + 全モード + Motion + 時刻合わせ、10 秒のステレオ、ウォームアップ後 3 回の中央値）'
  const check = (name: string, pass: boolean, detail: string) => {
    results.push({ group, name, pass, detail })
    console.info(`${pass ? 'PASS' : 'FAIL'} ${group} / ${name} :: ${detail}`)
  }
  if (!hrtfLatency) hrtfLatency = await measureHrtfLatency(RATE)
  const mix = programStereoMix(10)
  const once = async (dsp: DspConfig) => {
    const ctx = new OfflineAudioContext(2, mix.length, RATE)
    await loadDynamicsWorklet(ctx)
    await loadTailWorklet(ctx)
    await loadMotionWorklet(ctx)
    const align = await loadAlignWorklet(ctx)
    const chain = createOutputChain(ctx, {
      dsp,
      bypass: false,
      useWorklet: true,
      bassScale: eqCapScale(dsp.bass),
      bassDynamics: dynamicsSettingsFor(dsp.bass.mode, DEFAULT_BASS_THRESHOLD_DB, 0),
      spatial: { trimDb: 0, hrtfLatencySeconds: hrtfLatency, motion: {} },
      alignBypass: align,
    })
    const src = new AudioBufferSourceNode(ctx, { buffer: mix })
    src.connect(chain.input)
    chain.output.connect(ctx.destination)
    src.start()
    const t = performance.now()
    await ctx.startRendering()
    return performance.now() - t
  }
  for (const p of SPATIAL_PRESETS) {
    const dsp = presetToDsp(p)
    await once(dsp)
    const runs = [await once(dsp), await once(dsp), await once(dsp)]
    const med = [...runs].sort((a, b) => a - b)[1]
    const load = med / 1000 / mix.duration
    check(`${p.label}: 実時間比 ${(load * 100).toFixed(1)}%`, load < 0.5, `中央値 ${med.toFixed(0)} ms（3 回: ${runs.map((r) => r.toFixed(0)).join(' / ')} ms）。50% 未満を合格`)
  }
  return results
}
