// DSP 自己診断。合成信号・楽曲相当信号を OfflineAudioContext で実際の処理グラフに通し、数値で検証する。
// 開発用ページ tests/dsp-selftest.html から実行する（本番ビルドには含まれない）。

import { analyzeSource, buildAnalysisExcerpt, planProcessing, type ProcessingPlan } from '../audio/analysis'
import { DEFAULT_BASS_PARAMS, FALLBACK_COMPRESSOR_SPEC, MODE_SPECS, type BassParams } from '../audio/bassSpec'
import { eqGainDb } from '../audio/biquadMath'
import { integratedLoudness, linearToDb, samplePeak } from '../audio/loudness'
import {
  createEqChain,
  createProcessingGraph,
  dynamicsSettingsFor,
  loadDynamicsWorklet,
  measureCompressorMakeup,
} from '../audio/processingGraph'
import { averageSpectrum, bandLevelDb, SUMMARY_BANDS, type Spectrum } from '../audio/spectrum'
import { programAcoustic, programEdm, programMono, programPop, silence, TEST_RATE, toBuffer } from './testSignals'

export interface TestResult {
  group: string
  name: string
  pass: boolean
  detail: string
  /** 合否を判定しない測定値（原因調査など）。PASS / FAIL の件数に含めない */
  info?: boolean
}

const RATE = TEST_RATE
const p = (bass: number, sub: number, mode: BassParams['mode'], compensation: BassParams['compensation'] = 'mid-anchor'): BassParams => ({
  ...DEFAULT_BASS_PARAMS,
  bass,
  sub,
  mode,
  compensation,
})

type Fn = (t: number) => number
const sine = (f: number, a: number): Fn => (t) => a * Math.sin(2 * Math.PI * f * t)
const mix = (...fns: Fn[]): Fn => (t) => fns.reduce((s, fn) => s + fn(t), 0)

function makeBuffer(channels: Fn[], seconds = 3): AudioBuffer {
  const length = Math.round(seconds * RATE)
  return toBuffer(
    channels.map((fn) => {
      const d = new Float32Array(length)
      for (let i = 0; i < length; i++) d[i] = fn(i / RATE)
      return d
    }),
  )
}

const chans = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))
const db = linearToDb
const f1 = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}` : String(v))
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : String(v))

/** 指定周波数の振幅（過渡部分を除いた from 秒以降で計算） */
function toneAmplitude(x: Float32Array, freq: number, from = 0.5): number {
  const start = Math.round(from * RATE)
  const n = x.length - start
  let re = 0
  let im = 0
  for (let i = 0; i < n; i++) {
    const w = (2 * Math.PI * freq * i) / RATE
    re += x[start + i] * Math.cos(w)
    im -= x[start + i] * Math.sin(w)
  }
  return (2 * Math.hypot(re, im)) / n
}

async function render(
  buf: AudioBuffer,
  build: (ctx: OfflineAudioContext, src: AudioBufferSourceNode) => Promise<AudioNode> | AudioNode,
  schedule?: (ctx: OfflineAudioContext) => void,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(buf.numberOfChannels, buf.length, RATE)
  const src = new AudioBufferSourceNode(ctx, { buffer: buf })
  ;(await build(ctx, src)).connect(ctx.destination)
  src.start()
  schedule?.(ctx)
  return ctx.startRendering()
}

async function plan(buf: AudioBuffer, params: BassParams): Promise<ProcessingPlan> {
  const excerpt = buildAnalysisExcerpt(buf)
  return planProcessing(excerpt, await analyzeSource(excerpt), params, { useWorklet: true, makeupCancel: 1 })
}

/** 計画どおりの設定でリアルタイム再生と同じグラフを 48 kHz でレンダリング */
async function renderPlan(buf: AudioBuffer, pl: ProcessingPlan, bypass = false): Promise<AudioBuffer> {
  return render(buf, async (ctx, src) => {
    await loadDynamicsWorklet(ctx)
    const g = createProcessingGraph(ctx, { params: pl.params, scale: pl.scale, bypass, dynamics: pl.dynamics, useWorklet: true })
    src.connect(g.input)
    return g.output
  })
}

const spec = (b: AudioBuffer): Spectrum => averageSpectrum(chans(b), RATE, 32768)
const bandDelta = (a: Spectrum, b: Spectrum, lo: number, hi: number) => bandLevelDb(b, lo, hi) - bandLevelDb(a, lo, hi)

function maxAbsDiff(a: AudioBuffer, b: AudioBuffer): number {
  let m = 0
  for (let c = 0; c < a.numberOfChannels; c++) {
    const x = a.getChannelData(c)
    const y = b.getChannelData(c)
    for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i]))
  }
  return m
}

const countOver = (b: AudioBuffer, limit: number) => chans(b).reduce((n, x) => n + x.filter((v) => Math.abs(v) > limit).length, 0)
const hasNaN = (b: AudioBuffer) => chans(b).some((x) => x.some((v) => !Number.isFinite(v)))

function maxStep(x: Float32Array, from: number, to: number): number {
  let m = 0
  for (let i = Math.max(1, Math.round(from * RATE)); i < Math.min(x.length, Math.round(to * RATE)); i++) {
    m = Math.max(m, Math.abs(x[i] - x[i - 1]))
  }
  return m
}

/**
 * Phase 02 の実装をそのまま再現した比較基準:
 * HPF 22 Hz(2次) → シェルフ 120 Hz +6 → ピーク 80 Hz +3 → ピーク 45 Hz +9 → トリム → DynamicsCompressor → メイクアップ打消し
 * トリム = -max(ラウドネス増加, ピーク増加×0.5)、下限 -15 dB（24 kHz の EQ 単体レンダリングで計測）
 */
async function renderLegacyPhase02(buf: AudioBuffer): Promise<{ out: AudioBuffer; trimDb: number }> {
  const qButter = 20 * Math.log10(Math.SQRT1_2)
  const legacyEq = (ctx: BaseAudioContext) => {
    const nodes = [
      new BiquadFilterNode(ctx, { type: 'highpass', frequency: 22, Q: qButter }),
      new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 120, gain: 6 }),
      new BiquadFilterNode(ctx, { type: 'peaking', frequency: 80, Q: 1, gain: 3 }),
      new BiquadFilterNode(ctx, { type: 'peaking', frequency: 45, Q: 1.4, gain: 9 }),
    ]
    for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i])
    return { input: nodes[0], output: nodes[3] }
  }
  const measure = async (withEq: boolean) => {
    const rate = 24000
    const ctx = new OfflineAudioContext(Math.min(2, buf.numberOfChannels), Math.ceil(buf.duration * rate), rate)
    const src = new AudioBufferSourceNode(ctx, { buffer: buf })
    if (withEq) {
      const eq = legacyEq(ctx)
      src.connect(eq.input)
      eq.output.connect(ctx.destination)
    } else src.connect(ctx.destination)
    src.start()
    const r = chans(await ctx.startRendering())
    return { lufs: integratedLoudness(r, rate), peak: db(samplePeak(r)) }
  }
  const a = await measure(false)
  const b = await measure(true)
  const trimDb = Math.max(-Math.max(b.lufs - a.lufs, (b.peak - a.peak) * 0.5, 0), -15)
  const makeup = await measureCompressorMakeup()
  const out = await render(buf, (ctx, src) => {
    const eq = legacyEq(ctx)
    src.connect(eq.input)
    return eq.output
      .connect(new GainNode(ctx, { gain: Math.pow(10, trimDb / 20) }))
      .connect(new DynamicsCompressorNode(ctx, { ...FALLBACK_COMPRESSOR_SPEC }))
      .connect(new GainNode(ctx, { gain: 1 / makeup }))
  })
  return { out, trimDb }
}

export async function runDspSelfTest(): Promise<TestResult[]> {
  const results: TestResult[] = []
  let group = ''
  const add = (name: string, pass: boolean, detail: string) => results.push({ group, name, pass, detail })

  group = '0. 実行環境'
  {
    const ctx = new OfflineAudioContext(1, 128, RATE)
    const ok = await loadDynamicsWorklet(ctx)
    add('AudioWorklet（低域コンプ＋リミッター）の読み込み', ok, ok ? '読み込み成功' : '読み込み失敗')
    if (!ok) return results
  }

  group = '1. 周波数応答（EQ 単体・正弦波を実レンダリング）'
  {
    const freqs = [25, 30, 40, 50, 63, 80, 100, 150, 250, 1000, 5000]
    const gainAt = async (params: BassParams, scale = 1) => {
      const out: Record<number, number> = {}
      for (const f of freqs) {
        const r = await render(makeBuffer([sine(f, 0.01)], 1.5), (ctx, src) => {
          const eq = createEqChain(ctx, params, scale)
          src.connect(eq.input)
          return eq.output
        })
        out[f] = db(toneAmplitude(r.getChannelData(0), f) / 0.01)
      }
      return out
    }
    const fmt = (g: Record<number, number>) => freqs.map((f) => `${f}Hz ${f1(g[f])}`).join(' ')
    for (const mode of ['normal', 'extreme'] as const) {
      const bass = await gainAt(p(100, 0, mode))
      const sub = await gainAt(p(0, 100, mode))
      const m = MODE_SPECS[mode]
      add(
        `${m.label} BASS 100%: パンチ帯域を持ち上げ、1 kHz 以上は不変`,
        bass[m.punch.frequency] > m.shelf.maxGainDb * 0.9 && Math.abs(bass[1000]) < 0.1 && Math.abs(bass[5000]) < 0.05,
        fmt(bass),
      )
      add(
        `${m.label} SUB 100%: 超低域に集中（150 Hz 以上への影響は小さい）`,
        sub[50] > m.sub.maxGainDb * 0.75 && sub[150] < 1 && Math.abs(sub[1000]) < 0.05,
        fmt(sub),
      )
      const both = p(100, 100, mode)
      const capScale = (await plan(silence(1), both)).capScale
      const all = await gainAt(both, capScale)
      const maxRendered = Math.max(...freqs.map((f) => all[f]))
      const analyticErr = Math.max(...freqs.map((f) => Math.abs(eqGainDb(both, capScale, f) - all[f])))
      add(
        `${m.label} BASS+SUB 100%: EQ 合成の上限 ${m.eqCapDb} dB を守る`,
        maxRendered <= m.eqCapDb + 0.3 && analyticErr < 0.2,
        `${fmt(all)}（上限倍率 ${f2(capScale)}、上限計算と実ノードの差 最大 ${analyticErr.toFixed(3)} dB）`,
      )
    }
  }

  group = '2. 楽曲相当信号: 低域の増幅量・中高域の変化・出力ピーク・クリップ（Phase 02 方式との比較）'
  // 目標値 [低域(20–120 Hz)の絶対変化 下限, 低域−中域の相対変化 下限, 中域変化 下限, 60–120 Hz の絶対変化 下限]
  // - 低音の少ない曲・一般的な曲: 低域が絶対値で明確に増え、中域の低下は安全予算（トリム下限＋リミッター）以内
  // - 低域がすでに飽和している曲: 天井 -1 dBFS の下では低域の絶対値はほぼ増やせない（物理的制約）ため、
  //   低域を減らさず、相対バランスが変わることを目標とする
  const programs = [
    { name: 'ポップス相当（標準的なバランス）', buf: programPop(), normal: [2, 5, -3, -0.5], extreme: [5, 8, -4, 2.5] },
    { name: 'アコースティック相当（低音少なめ）', buf: programAcoustic(), normal: [5, 5, -2.5, 3], extreme: [8, 9, -3, 6] },
    { name: 'EDM相当（低域飽和・極端に低音が多い）', buf: programEdm(), normal: [-0.5, 2.5, -3.5, -3.5], extreme: [-0.5, 3, -4, -1.5] },
  ] as const
  for (const prog of programs) {
    const buf = prog.buf
    const before = spec(await render(buf, (_, s) => s))
    const lufsIn = integratedLoudness(chans(buf), RATE)
    const legacy = await renderLegacyPhase02(buf)
    const lAfter = spec(legacy.out)
    const baselineLow = bandDelta(before, lAfter, 20, 120)
    const baselineMid = bandDelta(before, lAfter, 200, 2000)
    const baselineBass = bandDelta(before, lAfter, 60, 120)
    add(
      `${prog.name} / Phase 02 実装（再現）＝比較基準`,
      true,
      `低域(20–120) ${f1(baselineLow)} dB / 低域−中域 ${f1(baselineLow - baselineMid)} dB ｜ ` +
        SUMMARY_BANDS.map((b) => `${b.label} ${f1(bandDelta(before, lAfter, b.lo, b.hi))}`).join(' / ') +
        ` dB ｜ トリム ${f1(legacy.trimDb)} dB ｜ ${lufsIn.toFixed(1)} → ${integratedLoudness(chans(legacy.out), RATE).toFixed(1)} LUFS`,
    )
    for (const [mode, comp, bass, sub] of [
      ['normal', 'mid-anchor', 100, 100],
      ['extreme', 'mid-anchor', 100, 100],
      ['extreme', 'mid-anchor', 100, 0],
      ['extreme', 'loudness-match', 100, 100],
    ] as const) {
      const pl = await plan(buf, p(bass, sub, mode, comp))
      const out = await renderPlan(buf, pl)
      const after = spec(out)
      const d = Object.fromEntries(SUMMARY_BANDS.map((b) => [b.id, bandDelta(before, after, b.lo, b.hi)]))
      const low = bandDelta(before, after, 20, 120)
      const peak = db(samplePeak(chans(out)))
      const over = countOver(out, 1)
      const ceiling = MODE_SPECS[mode].limiter.ceilingDb
      const lufsOut = integratedLoudness(chans(out), RATE)
      const detail =
        `低域(20–120) ${f1(low)} dB / 低域−中域 ${f1(low - d.mid)} dB ｜ SUB ${f1(d.sub)} / BASS ${f1(d.bass)} / 120–200 ${f1(d.upperBass)} / 中域 ${f1(d.mid)} / 高域 ${f1(d.high)} dB` +
        ` ｜ トリム ${f1(pl.trim.trimDb)} dB（${pl.trim.reason}）、低域コンプしきい値 原音低域ピーク${f1(pl.thresholdOffsetDb)} dB、安全倍率 ${f2(pl.safetyScale)}` +
        ` ｜ ${lufsIn.toFixed(1)} → ${lufsOut.toFixed(1)} LUFS、ピーク ${f2(peak)} dBFS`
      if (comp === 'loudness-match' || sub === 0) {
        const what = comp === 'loudness-match' ? 'ラウドネス一致（A/B 比較用）' : 'BASS のみ 100%'
        add(`${prog.name} / EXTREME ${what}（参考）`, peak <= ceiling + 0.01 && over === 0, detail)
        continue
      }
      const label = `${prog.name} / ${MODE_SPECS[mode].label} 100%/100%`
      const [lowMin, relMin, midMin, bassMin] = prog[mode]
      add(
        `${label}: 低域の増幅`,
        low >= lowMin && low - d.mid >= relMin && d.bass >= bassMin,
        `目標 低域 ≥ ${f1(lowMin)}・低域−中域 ≥ ${f1(relMin)}・60–120 Hz ≥ ${f1(bassMin)} ／ ${detail}`,
      )
      add(`${label}: 中高域の変化が予算内`, d.mid >= midMin && d.high >= midMin - 0.5, `目標 中域 ≥ ${f1(midMin)} dB ／ 中域 ${f1(d.mid)}・高域 ${f1(d.high)} dB`)
      add(
        `${label}: 出力ピーク ≤ ${ceiling} dBFS・クリップなし`,
        peak <= ceiling + 0.01 && over === 0 && !hasNaN(out),
        `出力ピーク ${f2(peak)} dBFS、±1.0 超過 ${over} サンプル`,
      )
      add(
        `${label}: ラウドネス増加が上限内`,
        lufsOut - lufsIn <= MODE_SPECS[mode].budget.maxLoudnessIncreaseLu + 1,
        `${f1(lufsOut - lufsIn)} LU（上限 +${MODE_SPECS[mode].budget.maxLoudnessIncreaseLu} LU、24 kHz 解析との差 1 LU まで許容）`,
      )
      if (mode === 'extreme') {
        // Phase 02 の問題は「低域は上がるが中高域がそれ以上に下がる」ことだった。
        // 同じ天井（-1 dBFS 付近）の下で、低域を同等以上に保ちつつ中域の低下が明確に小さいことを確認する
        add(
          `${label}: Phase 02 実装との比較（低域は同等以上・中域の低下が 1 dB 以上小さい）`,
          low >= baselineLow - 1 && d.bass >= baselineBass && d.mid >= baselineMid + 1,
          `低域(20–120) ${f1(baselineLow)} → ${f1(low)} dB ／ 60–120 Hz ${f1(baselineBass)} → ${f1(d.bass)} dB ／ 中域 ${f1(baselineMid)} → ${f1(d.mid)} dB`,
        )
      }
    }
  }

  group = '3. ピーク・クリップの限界試験'
  {
    // 0 dBFS 近い低音正弦波（最悪ケース）
    const hot = makeBuffer([mix(sine(40, 0.55), sine(1000, 0.4)), mix(sine(40, 0.55), sine(2000, 0.4))])
    for (const mode of ['normal', 'extreme'] as const) {
      const pl = await plan(hot, p(100, 100, mode))
      const out = await renderPlan(hot, pl)
      const peak = db(samplePeak(chans(out)))
      add(
        `${MODE_SPECS[mode].label}: -0.4 dBFS の 40 Hz＋中域正弦波を最大設定`,
        peak <= MODE_SPECS[mode].limiter.ceilingDb + 0.01 && countOver(out, 1) === 0,
        `出力ピーク ${f2(peak)} dBFS、トリム ${f1(pl.trim.trimDb)} dB、安全倍率 ${f2(pl.safetyScale)}、40 Hz/1 kHz 比 ${f1(db(toneAmplitude(out.getChannelData(0), 40) / toneAmplitude(out.getChannelData(0), 1000)) - db(0.55 / 0.4))} dB`,
      )
    }
    // 計画前（トリム 0・安全制限なし）でもリミッターが天井を守るか
    const raw = programEdm(6)
    const out = await render(raw, async (ctx, src) => {
      await loadDynamicsWorklet(ctx)
      const params = p(100, 100, 'extreme')
      const g = createProcessingGraph(ctx, { params, scale: 1, bypass: false, dynamics: dynamicsSettingsFor('extreme', -40, 0), useWorklet: true })
      src.connect(g.input)
      return g.output
    })
    const peak = db(samplePeak(chans(out)))
    add('補正計測前の最悪ケース（EXTREME 最大・トリム 0・上限制限なし）でもリミッターが -1 dBFS を守る', peak <= -0.99, `出力ピーク ${f2(peak)} dBFS`)
  }

  group = '4. BYPASS（最大設定のまま BYPASS → 原音とサンプル一致）'
  for (const [name, buf] of [
    ['EDM相当', programEdm(4)],
    ['アコースティック相当', programAcoustic(4)],
    ['モノラル', programMono(4)],
    ['無音', silence(2)],
  ] as const) {
    const original = await render(buf, (_, s) => s)
    for (const mode of ['normal', 'extreme'] as const) {
      const pl = await plan(buf, p(100, 100, mode))
      const bypassed = await renderPlan(buf, pl, true)
      const diff = maxAbsDiff(original, bypassed)
      add(`${name} / ${MODE_SPECS[mode].label}`, diff === 0, `最大差 ${diff}`)
    }
  }

  group = '5. ステレオ維持'
  {
    // 低域は共通、中域は L=1 kHz / R=3 kHz のみ
    const buf = makeBuffer([mix(sine(50, 0.3), sine(1000, 0.2)), mix(sine(50, 0.3), sine(3000, 0.2))])
    for (const mode of ['normal', 'extreme'] as const) {
      const pl = await plan(buf, p(100, 100, mode))
      const out = await renderPlan(buf, pl)
      const L = out.getChannelData(0)
      const R = out.getChannelData(1)
      const leakR = db(toneAmplitude(L, 3000) / toneAmplitude(R, 3000))
      const leakL = db(toneAmplitude(R, 1000) / toneAmplitude(L, 1000))
      add(
        `${MODE_SPECS[mode].label}: L/R の独立性（片側だけの成分が反対側に漏れない）`,
        out.numberOfChannels === 2 && leakR < -60 && leakL < -60,
        `R→L 漏れ ${f1(leakR)} dB、L→R 漏れ ${f1(leakL)} dB`,
      )
    }
    const edm = programEdm(6)
    const pl = await plan(edm, p(100, 100, 'extreme'))
    const out = await renderPlan(edm, pl)
    const side = (b: AudioBuffer) => {
      const [l, r] = chans(b)
      return averageSpectrum([Float32Array.from(l, (v, i) => (v - r[i]) / 2)], RATE, 32768)
    }
    const widthChange = bandDelta(side(edm), side(out), 1000, 10000) - bandDelta(spec(edm), spec(out), 1000, 10000)
    add('EXTREME: 中高域のステレオ幅（Side/全体比）が変わらない', Math.abs(widthChange) < 0.5, `Side 成分の相対変化 ${f2(widthChange)} dB（1–10 kHz）`)
    const mono = programMono(4)
    const mpl = await plan(mono, p(100, 100, 'extreme'))
    const mout = await renderPlan(mono, mpl)
    const mlow = bandDelta(spec(mono), spec(mout), 20, 120)
    add('モノラル入力（ポップス相当）: 1ch で処理され低域の比率が上がる・NaN なし', mout.numberOfChannels === 1 && !hasNaN(mout) && mlow - bandDelta(spec(mono), spec(mout), 200, 2000) > 5, `低域(20–120) ${f1(mlow)} dB、中域 ${f1(bandDelta(spec(mono), spec(mout), 200, 2000))} dB`)
  }

  group = '6. 無音入力'
  for (const mode of ['normal', 'extreme'] as const) {
    const buf = silence(3)
    const pl = await plan(buf, p(100, 100, mode))
    const out = await renderPlan(buf, pl)
    add(
      `${MODE_SPECS[mode].label}: 出力も無音・NaN なし・計測は「無音」扱い`,
      samplePeak(chans(out)) === 0 && !hasNaN(out) && pl.result === null && pl.trim.trimDb === 0,
      `出力ピーク ${samplePeak(chans(out))}、トリム ${pl.trim.trimDb} dB`,
    )
  }

  group = '7. 切替時のクリックノイズ'
  {
    const buf = makeBuffer([mix(sine(50, 0.3), sine(1000, 0.2)), mix(sine(50, 0.3), sine(1000, 0.2))])
    const plN = await plan(buf, p(100, 100, 'normal'))
    const plX = await plan(buf, p(100, 100, 'extreme'))
    const steady = async (pl: ProcessingPlan, bypass = false) => maxStep((await renderPlan(buf, pl, bypass)).getChannelData(0), 0.5, 2.5)
    const baseline = Math.max(await steady(plN, true), await steady(plN), await steady(plX))

    const switched = async (setup: (g: ReturnType<typeof createProcessingGraph>) => void, start: ProcessingPlan, bypass: boolean) => {
      let graph: ReturnType<typeof createProcessingGraph> | null = null
      const out = await render(
        buf,
        async (ctx, src) => {
          await loadDynamicsWorklet(ctx)
          graph = createProcessingGraph(ctx, { params: start.params, scale: start.scale, bypass, dynamics: start.dynamics, useWorklet: true })
          src.connect(graph.input)
          return graph.output
        },
        (ctx) => {
          void ctx.suspend(1.0).then(() => {
            if (graph) setup(graph)
            void ctx.resume()
          })
        },
      )
      return maxStep(out.getChannelData(0), 0.95, 1.6)
    }
    const s1 = await switched((g) => g.setBypass(false, true), plX, true)
    add('BYPASS 解除（→ EXTREME 処理音）', s1 <= baseline * 1.25, `切替区間 ${s1.toFixed(4)}（通常時 ${baseline.toFixed(4)}）`)
    const zero = await plan(buf, p(0, 0, 'extreme'))
    const s2 = await switched(
      (g) => {
        g.setParams(plX.params, plX.scale, true)
        g.setDynamics(plX.dynamics)
      },
      zero,
      false,
    )
    add('スライダー急変（EXTREME 0% → 100%）', s2 <= baseline * 1.25, `変更区間 ${s2.toFixed(4)}（通常時 ${baseline.toFixed(4)}）`)
    const s3 = await switched(
      (g) => {
        g.setParams(plX.params, plX.scale, true)
        g.setDynamics(plX.dynamics)
      },
      plN,
      false,
    )
    add('モード切替（NORMAL 100% → EXTREME 100%）', s3 <= baseline * 1.25, `変更区間 ${s3.toFixed(4)}（通常時 ${baseline.toFixed(4)}）`)
  }

  return results
}
