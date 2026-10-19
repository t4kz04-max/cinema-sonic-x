// 空間音響プロトタイプの自己診断。tests/spatial-selftest.html から実行する（本番ビルドに含まれない）。

import { integratedLoudness, linearToDb, samplePeak } from '../audio/loudness'
import { DEFAULT_BASS_PARAMS } from '../audio/bassSpec'
import { createProcessingGraph, dynamicsSettingsFor, loadDynamicsWorklet } from '../audio/processingGraph'
import { analyzeSpatialSource, buildSpatialExcerpt, planSpatial, wideCapFor, type SpatialPlan } from '../audio/spatial/spatialAnalysis'
import { createSpatialGraph, measureHrtfLatency } from '../audio/spatial/spatialGraph'
import { DEFAULT_SPATIAL_PARAMS, hallSettings, MODE_DOCS, type ActiveSpatialMode, type SpatialParams } from '../audio/spatial/spatialSpec'
import { monoColorationDb, stereoColorationDb, stereoMetrics, type StereoMetrics } from '../audio/stereoMetrics'
import type { TestResult } from './dspSelfTest'
import { runMotionSelfTest } from './motionSelfTest'
import { programMono, programPop, programStereoMix, silence, TEST_RATE, toBuffer } from './testSignals'

const RATE = TEST_RATE
const MODES: ActiveSpatialMode[] = ['wide', 'cinema', 'hall']
const chans = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))
const f1 = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}` : String(v))
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : String(v))
const sp = (mode: ActiveSpatialMode, patch: Partial<SpatialParams> = {}): SpatialParams => ({ ...DEFAULT_SPATIAL_PARAMS, mode, ...patch })

let hrtfLatency = 0

async function render(
  buf: AudioBuffer,
  params: SpatialParams | null,
  opts: { bypass?: boolean; trimDb?: number; limiter?: boolean; tailSeconds?: number; wideCap?: number; schedule?: (ctx: OfflineAudioContext, g: ReturnType<typeof createSpatialGraph>) => void } = {},
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, buf.length + Math.round((opts.tailSeconds ?? 0) * RATE), RATE)
  const src = new AudioBufferSourceNode(ctx, { buffer: buf })
  if (params) {
    await loadDynamicsWorklet(ctx)
    const g = createSpatialGraph(ctx, {
      params,
      bypass: opts.bypass ?? false,
      trimDb: opts.trimDb ?? 0,
      useWorklet: true,
      hrtfLatencySeconds: hrtfLatency,
      limiterEnabled: opts.limiter ?? true,
      wideSideCapDb: opts.wideCap,
    })
    src.connect(g.input)
    g.output.connect(ctx.destination)
    opts.schedule?.(ctx, g)
  } else {
    src.connect(ctx.destination)
  }
  src.start()
  return ctx.startRendering()
}

async function plan(buf: AudioBuffer, params: SpatialParams): Promise<{ plan: SpatialPlan; before: StereoMetrics }> {
  const ex = buildSpatialExcerpt(buf)
  const before = await analyzeSpatialSource(ex)
  return { before, plan: await planSpatial(ex, before, params, { useWorklet: true, hrtfLatencySeconds: hrtfLatency }) }
}

function maxAbsDiff(a: AudioBuffer, b: AudioBuffer): number {
  let m = 0
  for (let c = 0; c < a.numberOfChannels; c++) {
    const x = a.getChannelData(c)
    const y = b.getChannelData(c)
    for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i]))
  }
  return m
}

const hasNaN = (b: AudioBuffer) => chans(b).some((x) => x.some((v) => !Number.isFinite(v)))

function noise(seconds: number, seed: number): Float32Array {
  let s = seed >>> 0
  const n = Math.round(seconds * RATE)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = (s / 0x100000000 - 0.5) * 0.5
  }
  return out
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, to - from))
}

/** L と R の相互相関のピーク遅延（ms、正 = R が遅れる） */
function interauralLagMs(L: Float32Array, R: Float32Array, maxMs = 1.5): number {
  const maxLag = Math.round((maxMs / 1000) * RATE)
  const from = Math.round(0.3 * RATE)
  const to = Math.min(L.length, from + RATE)
  let best = 0
  let bestVal = -Infinity
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0
    for (let i = from; i < to; i++) s += L[i] * (R[i + lag] ?? 0)
    if (s > bestVal) {
      bestVal = s
      best = lag
    }
  }
  return (best / RATE) * 1000
}

/** Schroeder 逆積分による T20 から RT60 を推定 */
function rt60FromImpulse(x: Float32Array, start: number): number {
  const e = new Float64Array(x.length - start)
  let acc = 0
  for (let i = x.length - 1; i >= start; i--) {
    acc += x[i] * x[i]
    e[i - start] = acc
  }
  const total = e[0]
  const db = (i: number) => 10 * Math.log10(e[i] / total)
  let i5 = 0
  while (i5 < e.length && db(i5) > -5) i5++
  let i25 = i5
  while (i25 < e.length && db(i25) > -25) i25++
  return (3 * (i25 - i5)) / RATE
}

function maxStep(x: Float32Array, from: number, to: number): number {
  let m = 0
  for (let i = Math.max(1, Math.round(from * RATE)); i < Math.min(x.length, Math.round(to * RATE)); i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]))
  return m
}

function describe(before: StereoMetrics, after: StereoMetrics): string {
  return (
    `相関 ${f2(before.correlation)}→${f2(after.correlation)}（低 ${f2(before.bandCorrelation.low)}→${f2(after.bandCorrelation.low)} / 中 ${f2(before.bandCorrelation.mid)}→${f2(after.bandCorrelation.mid)} / 高 ${f2(before.bandCorrelation.high)}→${f2(after.bandCorrelation.high)}）` +
    `、幅 S/M 低 ${f1(before.bandWidthDb.low)}→${f1(after.bandWidthDb.low)} / 中 ${f1(before.bandWidthDb.mid)}→${f1(after.bandWidthDb.mid)} / 高 ${f1(before.bandWidthDb.high)}→${f1(after.bandWidthDb.high)} dB` +
    `、ラウドネス ${before.loudnessLufs.toFixed(1)}→${after.loudnessLufs.toFixed(1)} LUFS、モノラル和 ${before.monoLoudnessLufs.toFixed(1)}→${after.monoLoudnessLufs.toFixed(1)} LUFS` +
    `、音色偏差 両耳 ${f1(stereoColorationDb(before, after))} / モノラル和 ${f1(monoColorationDb(before, after))} dB、ピーク ${f2(after.peakDb)} dBFS`
  )
}

export async function runSpatialSelfTest(): Promise<TestResult[]> {
  const results: TestResult[] = []
  let group = ''
  const add = (name: string, pass: boolean, detail: string) => results.push({ group, name, pass, detail })

  group = '0. 実行環境'
  {
    const ctx = new OfflineAudioContext(1, 128, RATE)
    const ok = await loadDynamicsWorklet(ctx)
    hrtfLatency = await measureHrtfLatency(RATE)
    add('AudioWorklet（出力リミッター）の読み込み', ok, ok ? '成功' : '失敗')
    add('HRTF PannerNode の処理遅延を実測', true, `${(hrtfLatency * 1000).toFixed(2)} ms（WET/DRY 混合時の原音側遅延補正に使用）`)
  }

  const mix = programStereoMix(10)
  const mixBefore = stereoMetrics(chans(mix), RATE)
  const mixCap = wideCapFor(mixBefore)
  const pop = programPop(10)
  const popBefore = stereoMetrics(chans(pop), RATE)

  group = '1. 各モードの総合測定（一般的なステレオミックス相当・既定値 INTENSITY 60 / ROOM 50 / DEPTH 40 / WET 100）'
  for (const mode of MODES) {
    const { plan: pl } = await plan(mix, sp(mode))
    const out = await render(mix, sp(mode), { trimDb: pl.trimDb, wideCap: mixCap })
    const after = stereoMetrics(chans(out), RATE)
    const popBefore = mixBefore
    const label = MODE_DOCS[mode].label
    add(`${label}: 測定値`, true, `${describe(popBefore, after)}、トリム ${f1(pl.trimDb)} dB`)
    add(`${label}: 出力ピーク ≤ -1 dBFS・NaN なし`, after.peakDb <= -0.99 && !hasNaN(out), `ピーク ${f2(after.peakDb)} dBFS`)
    add(`${label}: ラウドネスが原音と ±1 LU 以内（A/B 比較の公平性）`, Math.abs(after.loudnessLufs - popBefore.loudnessLufs) <= 1, `${f1(after.loudnessLufs - popBefore.loudnessLufs)} LU`)
    add(`${label}: 全体の位相相関が負にならない（逆相成分が支配的でない）`, after.correlation >= 0, `相関 ${f2(after.correlation)}`)
  }

  group = '2. WIDE（Mid/Side）'
  {
    const out = await render(mix, sp('wide', { intensity: 100, depth: 100 }), { limiter: false, wideCap: mixCap })
    const after = stereoMetrics(chans(out), RATE)
    const col = monoColorationDb(mixBefore, after)
    add(
      'INTENSITY/DEPTH 100%: モノラル和が原音と同じ（音色偏差 ≤ 0.1 dB・レベル差 ≤ 0.1 dB）',
      col <= 0.1 && Math.abs(after.monoLoudnessLufs - mixBefore.monoLoudnessLufs) <= 0.1,
      `音色偏差 ${f2(col)} dB、モノラル和ラウドネス差 ${f2(after.monoLoudnessLufs - mixBefore.monoLoudnessLufs)} LU`,
    )
    add(
      'INTENSITY 100%: 低域（20–200 Hz）の幅は変えず、中高域を +4 dB 以上広げる',
      Math.abs(after.bandWidthDb.low - mixBefore.bandWidthDb.low) <= 0.5 && after.bandWidthDb.high - mixBefore.bandWidthDb.high >= 4,
      `Side 上限 +${f1(mixCap)} dB ／ 幅 低 ${f1(mixBefore.bandWidthDb.low)}→${f1(after.bandWidthDb.low)} / 中 ${f1(mixBefore.bandWidthDb.mid)}→${f1(after.bandWidthDb.mid)} / 高 ${f1(mixBefore.bandWidthDb.high)}→${f1(after.bandWidthDb.high)} dB`,
    )
    add(
      'INTENSITY 100%: 中高域の位相相関 ≥ +0.25（逆相が支配的にならない）',
      after.bandCorrelation.mid >= 0.25 && after.bandCorrelation.high >= 0.25,
      `相関 中 ${f2(mixBefore.bandCorrelation.mid)}→${f2(after.bandCorrelation.mid)} / 高 ${f2(mixBefore.bandCorrelation.high)}→${f2(after.bandCorrelation.high)}`,
    )
    // すでに非常に広い音源（左右独立ノイズ主体）では上限により広げすぎない
    const popCap = wideCapFor(popBefore)
    const popOut = stereoMetrics(chans(await render(pop, sp('wide', { intensity: 100, depth: 100 }), { limiter: false, wideCap: popCap })), RATE)
    add(
      'すでに広い音源（中高域 S/M ≈ -1 dB）: Side ゲイン上限が働き、相関を大きく下げない',
      popOut.correlation >= 0 && popOut.bandCorrelation.high >= popBefore.bandCorrelation.high - 0.15,
      `Side 上限 +${f1(popCap)} dB ／ 相関 ${f2(popBefore.correlation)}→${f2(popOut.correlation)}（高 ${f2(popBefore.bandCorrelation.high)}→${f2(popOut.bandCorrelation.high)}）`,
    )
    const zero = await render(mix, sp('wide', { intensity: 0, depth: 0 }), { limiter: false })
    const orig = await render(mix, null)
    // ワークレットの先読み 5 ms 分ずらして比較
    const lag = Math.round(0.005 * RATE)
    let m = 0
    for (let c = 0; c < 2; c++) {
      const x = orig.getChannelData(c)
      const y = zero.getChannelData(c)
      for (let i = 0; i + lag < y.length; i++) m = Math.max(m, Math.abs(x[i] - y[i + lag]))
    }
    add('INTENSITY 0・DEPTH 0: 原音と一致（先読み遅延 5 ms を除く）', m < 1e-5, `最大差 ${m.toExponential(2)}`)
    const mono = programMono(6)
    const mBefore = stereoMetrics([mono.getChannelData(0), mono.getChannelData(0)], RATE)
    const mOut = stereoMetrics(chans(await render(mono, sp('wide', { intensity: 100, depth: 100 }), { limiter: false })), RATE)
    add(
      'モノラル音源: Side ゲインは効かないが、擬似アンビエンスで幅が生まれる（モノラル和は不変）',
      mOut.bandWidthDb.high > -20 && monoColorationDb(mBefore, mOut) <= 0.1,
      `高域の幅 ${f1(mBefore.bandWidthDb.high)} → ${f1(mOut.bandWidthDb.high)} dB、相関 ${f2(mOut.correlation)}`,
    )
  }

  group = '3. CINEMA（HRTF 仮想スピーカー）'
  {
    // 左チャンネルだけのノイズ → 仮想左スピーカーから両耳へ届く
    const left = toBuffer([noise(3, 5), new Float32Array(3 * RATE)])
    const direct = sp('cinema', { intensity: 0, depth: 0, roomSize: 0 })
    const out = await render(left, direct, { limiter: false })
    const L = out.getChannelData(0)
    const R = out.getChannelData(1)
    const ild = linearToDb(rms(R, RATE / 2) / rms(L, RATE / 2))
    const itd = interauralLagMs(L, R)
    add('左だけの入力が右耳にも届く（クロスフィード）: 両耳間レベル差 -20〜-2 dB', ild <= -2 && ild >= -20, `右/左 ${f1(ild)} dB（ヘッドホン直接再生なら −∞ dB）`)
    add('両耳間時間差（ITD）が生じる: 0.1〜0.8 ms', itd >= 0.1 && itd <= 0.8, `右耳の遅れ ${f2(itd)} ms`)
    const pl = (await plan(mix, sp('cinema'))).plan
    const after = stereoMetrics(chans(await render(mix, sp('cinema'), { trimDb: pl.trimDb })), RATE)
    const sc = stereoColorationDb(mixBefore, after)
    add('両耳で聞く音色の変化（HRTF＋補正 EQ）≤ 6 dB', sc <= 6, `両耳パワーの音色偏差 ${f1(sc)} dB（125 Hz〜8 kHz）`)
    add('モノラル互換性（参考: バイノーラルのため低い）', true, `モノラル和の音色偏差 ${f1(monoColorationDb(mixBefore, after))} dB、モノラル和ラウドネス ${f1(after.monoLoudnessLufs - mixBefore.monoLoudnessLufs)} LU`)
    // 距離感: 左チャンネルへのインパルスに対し、直接音（到達時刻 −1〜+0.8 ms）と
    // 反射音（+5 ms 以降。HRTF インパルス応答自体の尾を除くため）のエネルギー比を比べる。
    // 遠い設定では反射音が直接音より大きくなるため、到達時刻は直接音が支配的な DEPTH 0 のピークで決める
    let directAt = -1
    const cinemaDrr = async (depth: number) => {
      const imp = new Float32Array(Math.round(0.2 * RATE))
      imp[0] = 0.5
      const out = await render(toBuffer([imp, new Float32Array(imp.length)]), sp('cinema', { depth }), { limiter: false })
      const x = out.getChannelData(0)
      if (directAt < 0) {
        directAt = 0
        for (let i = 1; i < x.length; i++) if (Math.abs(x[i]) > Math.abs(x[directAt])) directAt = i
      }
      const peak = directAt
      const energy = (from: number, to: number) => {
        let e = 0
        for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) e += x[i] * x[i]
        return e
      }
      const ms = (v: number) => Math.round((v / 1000) * RATE)
      return 10 * Math.log10(energy(peak - ms(1), peak + ms(0.8)) / energy(peak + ms(5), x.length))
    }
    const near = await cinemaDrr(0)
    const far = await cinemaDrr(100)
    add('DEPTH: 遠いほど直接音/反射音比が下がる（6 dB 以上）', near - far >= 6, `直接音/反射音 DEPTH 0: ${f1(near)} dB → 100: ${f1(far)} dB`)
  }

  group = '4. HALL（初期反射＋後期残響）'
  {
    const imp = new Float32Array(Math.round(0.05 * RATE))
    imp[0] = 0.5
    const impBuf = toBuffer([imp, imp])
    for (const roomSize of [0, 50, 100]) {
      const params = sp('hall', { roomSize, depth: 0, intensity: 100 })
      const target = hallSettings(params).rt60
      const out = await render(impBuf, params, { limiter: false, tailSeconds: 5 })
      const rt = rt60FromImpulse(out.getChannelData(0), Math.round(0.15 * RATE))
      add(`ROOM ${roomSize}%: 実測 RT60 が設定値 ±25% 以内`, Math.abs(rt - target) / target <= 0.25, `設定 ${f2(target)} s → 実測 ${f2(rt)} s（T20 から推定）`)
    }
    const drr = async (depth: number) => {
      const out = await render(impBuf, sp('hall', { depth }), { limiter: false, tailSeconds: 4 })
      const x = out.getChannelData(0)
      const lag = Math.round(0.005 * RATE)
      const dEnd = lag + Math.round(0.003 * RATE)
      let d = 0
      let r = 0
      for (let i = 0; i < x.length; i++) {
        if (i < dEnd) d += x[i] * x[i]
        else r += x[i] * x[i]
      }
      return 10 * Math.log10(d / r)
    }
    const d0 = await drr(0)
    const d50 = await drr(50)
    const d100 = await drr(100)
    add('DEPTH を上げるほど直接音/残響比（DRR）が下がる', d0 > d50 && d50 > d100, `DRR DEPTH 0: ${f1(d0)} dB → 50: ${f1(d50)} dB → 100: ${f1(d100)} dB`)
    // 低域の濁り: 60 Hz と 1 kHz の残響量の比
    const tone = (f: number) => toBuffer([0, 1].map(() => Float32Array.from({ length: 2 * RATE }, (_, i) => 0.3 * Math.sin((2 * Math.PI * f * i) / RATE))))
    const revLevel = async (f: number) => {
      const params = sp('hall', { depth: 100, intensity: 100 })
      const wet = await render(tone(f), params, { limiter: false, tailSeconds: 1.5 })
      const x = wet.getChannelData(0)
      return rms(x, 2 * RATE + Math.round(0.3 * RATE), 2 * RATE + Math.round(0.8 * RATE))
    }
    const lowRev = linearToDb((await revLevel(60)) / (await revLevel(1000)))
    add('残響への送りを帯域制限（60 Hz の残響が 1 kHz より 10 dB 以上小さい）', lowRev <= -10, `60 Hz / 1 kHz の残響量 ${f1(lowRev)} dB`)
  }

  group = '5. BYPASS（各モード最大設定のまま BYPASS → 原音とサンプル一致）'
  for (const [name, buf] of [
    ['ステレオミックス相当', programStereoMix(4)],
    ['モノラル', programMono(4)],
    ['無音', silence(2)],
  ] as const) {
    const orig = await render(buf, null)
    for (const mode of MODES) {
      const params = sp(mode, { intensity: 100, roomSize: 100, depth: 100 })
      const diff = maxAbsDiff(orig, await render(buf, params, { bypass: true }))
      add(`${name} / ${MODE_DOCS[mode].label}`, diff === 0, `最大差 ${diff}`)
    }
  }

  {
    // 実際の再生経路と同じ直列構成（重低音グラフ → 空間グラフ）を両方 BYPASS → 原音と一致
    const buf = programStereoMix(4)
    const orig = await render(buf, null)
    const ctx = new OfflineAudioContext(2, buf.length, RATE)
    await loadDynamicsWorklet(ctx)
    const bassParams = { ...DEFAULT_BASS_PARAMS, bass: 100, sub: 100, mode: 'extreme' as const }
    const bass = createProcessingGraph(ctx, { params: bassParams, scale: 1, bypass: true, dynamics: dynamicsSettingsFor('extreme', -20, 0), useWorklet: true })
    const spatial = createSpatialGraph(ctx, { params: sp('cinema', { intensity: 100 }), bypass: true, trimDb: 3, useWorklet: true, hrtfLatencySeconds: hrtfLatency })
    const src = new AudioBufferSourceNode(ctx, { buffer: buf })
    src.connect(bass.input)
    bass.output.connect(spatial.input)
    spatial.output.connect(ctx.destination)
    src.start()
    const diff = maxAbsDiff(orig, await ctx.startRendering())
    add('直列（重低音 EXTREME 最大 → 空間 CINEMA）を両方 BYPASS（= ORIGINAL）', diff === 0, `最大差 ${diff}`)
  }

  group = '6. 無音・モノラル入力'
  for (const mode of MODES) {
    const out = await render(silence(3), sp(mode, { intensity: 100, roomSize: 100, depth: 100 }))
    add(`${MODE_DOCS[mode].label}: 無音 → 無音・NaN なし`, samplePeak(chans(out)) === 0 && !hasNaN(out), `出力ピーク ${samplePeak(chans(out))}`)
    const mono = programMono(4)
    const { plan: pl } = await plan(mono, sp(mode))
    const mout = await render(mono, sp(mode), { trimDb: pl.trimDb })
    const lufsIn = integratedLoudness([mono.getChannelData(0), mono.getChannelData(0)], RATE)
    add(
      `${MODE_DOCS[mode].label}: モノラル入力を L=R として処理・ピーク ≤ -1 dBFS`,
      !hasNaN(mout) && linearToDb(samplePeak(chans(mout))) <= -0.99,
      `ラウドネス ${lufsIn.toFixed(1)} → ${integratedLoudness(chans(mout), RATE).toFixed(1)} LUFS、相関 ${f2(stereoMetrics(chans(mout), RATE).correlation)}`,
    )
  }

  group = '7. 切替時のクリックノイズ（440 Hz 正弦波）'
  {
    const sine = toBuffer([0, 1].map(() => Float32Array.from({ length: 3 * RATE }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / RATE))))
    let baseline = maxStep(sine.getChannelData(0), 0.5, 2.5)
    for (const mode of MODES) baseline = Math.max(baseline, maxStep((await render(sine, sp(mode))).getChannelData(0), 0.5, 2.5))
    const switched = async (from: SpatialParams, to: SpatialParams | 'bypass-off', bypass = false) => {
      const out = await render(sine, from, {
        bypass,
        schedule: (ctx, g) => {
          void ctx.suspend(1.0).then(() => {
            if (to === 'bypass-off') g.setBypass(false, true)
            else g.setParams(to, true)
            void ctx.resume()
          })
        },
      })
      return maxStep(out.getChannelData(0), 0.95, 1.6)
    }
    for (const [label, from, to, bypass] of [
      ['ORIGINAL → PROCESSED（CINEMA）', sp('cinema'), 'bypass-off', true],
      ['WIDE → CINEMA', sp('wide'), sp('cinema'), false],
      ['CINEMA → HALL', sp('cinema'), sp('hall'), false],
      ['HALL ROOM 0% → 100%（IR 切替）', sp('hall', { roomSize: 0 }), sp('hall', { roomSize: 100 }), false],
    ] as const) {
      const s = await switched(from, to, bypass)
      add(label, s <= baseline * 1.25, `切替区間 ${s.toFixed(4)}（通常時 ${baseline.toFixed(4)}）`)
    }
  }

  results.push(...(await runMotionSelfTest()))
  return results
}
