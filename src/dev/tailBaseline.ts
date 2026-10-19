// 既存 HALL の余韻のベースライン測定（?suite=baseline）。
// Phase 04 の変更前に一度実行して docs/hall-baseline.json に保存し、以降は Spatial Tail OFF・NATURAL の
// 回帰チェック（tailSelfTest.ts）で同じ値・同じハッシュになることを確認する。

import { loadDynamicsWorklet } from '../audio/processingGraph'
import { createSpatialGraph, loadMotionWorklet, measureHrtfLatency } from '../audio/spatial/spatialGraph'
import { loadTailWorklet } from '../audio/spatial/tailEngine'
import { DEFAULT_SPATIAL_PARAMS, hallSettings, type SpatialMode, type SpatialParams } from '../audio/spatial/spatialSpec'
import type { TestResult } from './dspSelfTest'
import { analyzeTail, energyDecayCurve, formatTail, sha256Hex, timeToLevel, type TailReport } from './tailMetrics'
import { programStereoMix, TEST_RATE, toBuffer } from './testSignals'

const RATE = TEST_RATE
export const IMPULSE_AT = 0.05

export interface BaselineCase {
  id: string
  params: SpatialParams
}

export const HALL_BASELINE_CASES: BaselineCase[] = [
  { id: 'hall-default', params: { ...DEFAULT_SPATIAL_PARAMS, mode: 'hall' } },
  { id: 'hall-room0', params: { ...DEFAULT_SPATIAL_PARAMS, mode: 'hall', roomSize: 0 } },
  { id: 'hall-room100', params: { ...DEFAULT_SPATIAL_PARAMS, mode: 'hall', roomSize: 100 } },
  { id: 'hall-int100-depth0', params: { ...DEFAULT_SPATIAL_PARAMS, mode: 'hall', intensity: 100, depth: 0 } },
]

/** 中央のインパルス（両チャンネル同じ）を入れた空間グラフの出力 */
export async function renderImpulse(params: SpatialParams, seconds: number, hrtfLatency: number, motion = false): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * RATE), RATE)
  await loadDynamicsWorklet(ctx)
  await loadTailWorklet(ctx)
  if (motion) await loadMotionWorklet(ctx)
  const imp = new Float32Array(Math.round(seconds * RATE))
  imp[Math.round(IMPULSE_AT * RATE)] = 0.5
  const src = new AudioBufferSourceNode(ctx, { buffer: toBuffer([imp, imp]) })
  const g = createSpatialGraph(ctx, {
    params,
    bypass: false,
    trimDb: 0,
    useWorklet: true,
    hrtfLatencySeconds: hrtfLatency,
    limiterEnabled: false,
    modes: params.mode === 'off' ? [] : [params.mode],
    motion: motion ? {} : undefined,
  })
  src.connect(g.input)
  g.output.connect(ctx.destination)
  src.start()
  return ctx.startRendering()
}

/** 音楽相当の信号が終わった後、出力が直前 1 秒の平均レベルから −60 dB に下がるまでの時間 */
export function stopDecaySeconds(out: { getChannelData(c: number): Float32Array }, stopAt: number): number {
  const L = out.getChannelData(0)
  const R = out.getChannelData(1)
  const s = Math.round(stopAt * RATE)
  let ref = 0
  for (let i = s - RATE; i < s; i++) ref += L[i] * L[i] + R[i] * R[i]
  ref /= RATE
  const win = Math.round(0.02 * RATE)
  for (let i = s; i + win < L.length; i += win / 2) {
    let e = 0
    for (let k = i; k < i + win; k++) e += L[k] * L[k] + R[k] * R[k]
    if (e / win < ref * 1e-6) return (i - s) / RATE
  }
  return NaN
}

/** 10 ms ごとのエネルギー（dB、チャンネル別）。再レンダリングでわずかに揺らぐため、回帰チェックはハッシュではなくこれで比べる */
export function blockEnergiesDb(buf: AudioBuffer, seconds = 3): number[][] {
  const n = Math.round(0.01 * RATE)
  return [0, 1].map((c) => {
    const x = buf.getChannelData(c)
    const out: number[] = []
    for (let i = 0; i + n <= Math.min(x.length, seconds * RATE); i += n) {
      let e = 0
      for (let k = i; k < i + n; k++) e += x[k] * x[k]
      out.push(Math.round(100 * 10 * Math.log10(e / n + 1e-20)) / 100)
    }
    return out
  })
}

export interface HallBaseline {
  id: string
  rt60: number
  hash: string
  report: TailReport
  blocks: number[][]
  buffer: AudioBuffer
}

export async function measureHallBaseline(hrtfLatency: number): Promise<HallBaseline[]> {
  const out = []
  for (const c of HALL_BASELINE_CASES) {
    const buf = await renderImpulse(c.params, 5, hrtfLatency)
    const L = buf.getChannelData(0)
    const R = buf.getChannelData(1)
    out.push({ id: c.id, rt60: hallSettings(c.params).rt60, hash: await sha256Hex([L, R]), report: analyzeTail(L, R, RATE, Math.round(IMPULSE_AT * RATE)), blocks: blockEnergiesDb(buf), buffer: buf })
  }
  return out
}

export async function runTailBaseline(): Promise<TestResult[]> {
  const results: TestResult[] = []
  let group = '0. 既存 HALL の余韻（インパルス応答、5 秒、リミッター OFF・トリム 0）'
  const check = (name: string, pass: boolean, detail: string) => {
    results.push({ group, name, pass, detail })
    console.info(`${pass ? 'PASS' : 'FAIL'} ${group} / ${name} :: ${detail}`)
  }
  const hrtfLatency = await measureHrtfLatency(RATE)
  const base = await measureHallBaseline(hrtfLatency)
  for (const b of base) check(`${b.id}（設定 RT60 ${b.rt60.toFixed(2)} s）`, true, `${formatTail(b.report)} | sha256 ${b.hash}`)
  // 再レンダリングで同じハッシュになるか（ハッシュを回帰チェックに使えるか）
  const again = await measureHallBaseline(hrtfLatency)
  const diffs = again.map((a, i) => {
    let m = 0
    let pk = 0
    for (let c = 0; c < 2; c++) {
      const x = a.buffer.getChannelData(c)
      const y = base[i].buffer.getChannelData(c)
      for (let k = 0; k < x.length; k++) {
        m = Math.max(m, Math.abs(x[k] - y[k]))
        pk = Math.max(pk, Math.abs(y[k]))
      }
    }
    return 20 * Math.log10(m / pk + 1e-30)
  })
  // 参考: Chrome の ConvolverNode は内部の並列処理により再レンダリングでわずかに揺らぐ（ビット一致しない）
  check('参考: 再レンダリングの差（ピーク比）', true, diffs.map((d) => d.toFixed(1) + ' dB').join(' / ') + '（ハッシュ ' + again.map((a, i) => (a.hash === base[i].hash ? '一致' : '不一致')).join('/') + '）')
  console.info('BASELINE_JSON ' + JSON.stringify(base.map(({ buffer: _b, ...rest }) => rest)))

  group = '0b. 停止後の余韻（ステレオミックス 3 秒の後に無音 5 秒）: 直前 1 秒の平均から −60 dB までの時間'
  const mix = programStereoMix(3)
  const padded = toBuffer([0, 1].map((c) => {
    const x = new Float32Array(mix.length + 5 * RATE)
    x.set(mix.getChannelData(c))
    return x
  }))
  const cases: [string, SpatialMode, boolean][] = [
    ['OFF', 'off', false],
    ['WIDE', 'wide', false],
    ['CINEMA', 'cinema', false],
    ['HALL', 'hall', false],
    ['CINEMA × Motion', 'cinema', true],
    ['HALL × Motion', 'hall', true],
  ]
  for (const [label, mode, motion] of cases) {
    const ctx = new OfflineAudioContext(2, padded.length, RATE)
    await loadDynamicsWorklet(ctx)
    if (motion) await loadMotionWorklet(ctx)
    const params: SpatialParams = { ...DEFAULT_SPATIAL_PARAMS, mode, motionEnabled: motion }
    const g = createSpatialGraph(ctx, {
      params,
      bypass: mode === 'off',
      trimDb: 0,
      useWorklet: true,
      hrtfLatencySeconds: hrtfLatency,
      limiterEnabled: false,
      modes: mode === 'off' ? [] : [mode],
      motion: motion ? {} : undefined,
    })
    const src = new AudioBufferSourceNode(ctx, { buffer: padded })
    src.connect(g.input)
    g.output.connect(ctx.destination)
    src.start()
    const o = await ctx.startRendering()
    const t = stopDecaySeconds(o, 3)
    const edc = energyDecayCurve([o.getChannelData(0), o.getChannelData(1)], 3 * RATE)
    check(label, true, `−60 dB まで ${Number.isFinite(t) ? (t * 1000).toFixed(0) + ' ms' : '5 秒以上'}（停止後エネルギーの −60 dB 到達 ${(timeToLevel(edc, RATE, -60) * 1000).toFixed(0)} ms）`)
  }
  return results
}
