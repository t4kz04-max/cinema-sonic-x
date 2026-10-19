// Phase 06（書き出し: オフラインレンダリング・WAV・リアルタイムとの一致・メモリ・キャンセル）の自己診断。
// ?suite=export&groups=60-62 のように分けて実行する（npm run test:export が順に実行）。

import { AudioEngine, type ExportSnapshot } from '../audio/AudioEngine'
import { analysisStats } from '../audio/analysisStats'
import type { DspConfig } from '../audio/dspConfig'
import { estimateExportBytes, EXPORT_MAX_SECONDS, exportMemoryBudget, reverbTailSeconds, type ExportProgress, type ExportRequest } from '../audio/export/exportSpec'
import { ExportCancelledError, exportFrameCount, startExport } from '../audio/export/exportRunner'
import { renderExportFloat } from '../audio/export/renderExport'
import { encodeWav, wavHeader, wavSizeError } from '../audio/export/wavEncoder'
import { integratedLoudness, linearToDb, samplePeak } from '../audio/loudness'
import { presetToDsp, SPATIAL_PRESETS } from '../audio/presets/spatialPresets'
import { motionLayout } from '../audio/spatial/spatialSpec'
import { distanceDelaySeconds } from '../audio/spatial/motion'
import { DEFAULT_SPATIAL_PARAMS } from '../audio/spatial/spatialSpec'
import { averageSpectrum, thirdOctaveLevelsDb, THIRD_OCTAVE_CENTERS } from '../audio/spectrum'
import { stereoMetrics } from '../audio/stereoMetrics'
import { inspectAudioHeader } from '../utils/audioHeader'
import type { TestResult } from './dspSelfTest'
import { stopDecaySeconds } from './tailBaseline'
import { programStereoMix, TEST_RATE, toBuffer } from './testSignals'

const RATE = TEST_RATE
const f1 = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}` : String(v))
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : String(v))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const chansOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))
const dspOf = (i: number) => presetToDsp(SPATIAL_PRESETS[i])
const gc = () => (globalThis as { gc?: () => void }).gc?.()

function noise(seconds: number, seed: number, amp = 0.2, rate = RATE): Float32Array {
  let s = seed >>> 0
  return Float32Array.from({ length: Math.round(seconds * rate) }, () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s / 0x100000000 - 0.5) * 2 * amp
  })
}
const zeros = (seconds: number, rate = RATE) => new Float32Array(Math.round(seconds * rate))

// ---------------- 書き出しの要求 ----------------

let shared: { engine: AudioEngine; buf: AudioBuffer } | null = null
/** 共有の再生エンジンを破棄する */
function releaseShared(): void {
  shared?.engine.dispose()
  shared = null
}

/**
 * 再生エンジンで解析を終えた設定から、書き出しの要求を作る（アプリと同じ手順）。
 * 同じ音源ならエンジンを使い回す（解析用の文脈が残るため、エンジンを増やさない）。fresh: 新しいエンジンを作る（呼び出し側が破棄）
 */
async function engineSnapshot(buf: AudioBuffer, dsp: DspConfig, fresh = false): Promise<{ engine: AudioEngine; snap: ExportSnapshot }> {
  let engine: AudioEngine
  if (fresh) {
    engine = new AudioEngine(1, { sampleRate: buf.sampleRate })
    engine.setBuffer(buf)
  } else {
    if (!shared || shared.buf !== buf) {
      releaseShared()
      shared = { engine: new AudioEngine(1, { sampleRate: buf.sampleRate }), buf }
      shared.engine.setBuffer(buf)
    }
    engine = shared.engine
  }
  engine.applyDsp(dsp)
  const snap = await engine.exportSnapshot()
  // アプリと同じ: 書き出しの前に再生側の AudioContext を止める（Chrome の HRTF の同時処理で結果が変わるため）
  await engine.suspendForExport()
  return { engine, snap }
}

function requestOf(buf: AudioBuffer, snap: ExportSnapshot, extra: Partial<ExportRequest> = {}): ExportRequest {
  return { channels: chansOf(buf).map((c) => c.slice()), sampleRate: buf.sampleRate, ...snap, bitDepth: 16, ditherSeed: 1, ...extra }
}

/**
 * 実際の書き出し経路（使い捨てフレーム）でレンダリングし、量子化前の浮動小数点の結果を受け取る。
 * ページ内で OfflineAudioContext を作ると Chrome が解放せず試験のメモリが増えるため、比較用のレンダリングもこの経路で行う
 */
async function exportFloat(req: ExportRequest): Promise<{ channels: Float32Array[]; tailSeconds: number; headTrimSeconds: number; sourceSeconds: number }> {
  const r = await startExport({ ...req, returnFloat: true }, () => {}).promise
  return { channels: r.float!, tailSeconds: r.tailSeconds, headTrimSeconds: r.headTrimSeconds, sourceSeconds: r.sourceSeconds }
}

/** 解析なしの要求（WAV・長さ・メモリなどの試験用。トリムは 0） */
function plainRequest(buf: AudioBuffer, dsp: DspConfig, extra: Partial<ExportRequest> = {}): ExportRequest {
  return {
    channels: chansOf(buf).map((c) => c.slice()),
    sampleRate: buf.sampleRate,
    dsp,
    bassScale: 1,
    bassDynamics: { bassThresholdDb: -12, bassRatio: 3, bassKneeDb: 6, bassAttackMs: 10, bassReleaseMs: 180, trimDb: 0, ceilingDb: -1, lookaheadMs: 5, limiterReleaseMs: 120, limiterEnabled: true, reportIntervalMs: 0 },
    spatialTrimDb: 0,
    wideSideCapDb: 9,
    bitDepth: 16,
    ditherSeed: 1,
    ...extra,
  }
}

const energyRatioDb = (a: Float32Array[], b: Float32Array[], from = 0) => {
  let d = 0
  let e = 0
  for (let c = 0; c < 2; c++) {
    const n = Math.min(a[c].length, b[c].length)
    for (let i = from; i < n; i++) {
      d += (a[c][i] - b[c][i]) ** 2
      e += a[c][i] ** 2
    }
  }
  return 10 * Math.log10(d / (e + 1e-30) + 1e-30)
}
const maxDiffDb = (a: Float32Array[], b: Float32Array[]) => {
  let m = 0
  let pk = 0
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < Math.min(a[c].length, b[c].length); i++) {
      m = Math.max(m, Math.abs(a[c][i] - b[c][i]))
      pk = Math.max(pk, Math.abs(a[c][i]))
    }
  }
  return 20 * Math.log10(m / (pk + 1e-30) + 1e-30)
}
const maxAbsRange = (x: Float32Array, from: number, to: number) => {
  let m = 0
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) m = Math.max(m, Math.abs(x[i]))
  return m
}

/** 区間ごとの ILD（右 − 左、dB） */
function ildTrack(L: Float32Array, R: Float32Array, from: number, to: number, step: number, rate: number): number[] {
  const out: number[] = []
  const n = Math.round(step * rate)
  for (let s = Math.round(from * rate); s + n <= Math.min(L.length, Math.round(to * rate)); s += n) {
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
/** b が a より何サンプル遅れているか（L+R の相互相関、粗 → 細） */
function lagOf(a: Float32Array[], b: Float32Array[], from: number, len: number, maxLag: number): number {
  const am = Float32Array.from({ length: len }, (_, i) => a[0][from + i] + a[1][from + i])
  const corr = (lag: number) => {
    let s = 0
    for (let i = 0; i < len; i++) {
      const j = from + i + lag
      if (j >= 0 && j < b[0].length) s += am[i] * (b[0][j] + b[1][j])
    }
    return s
  }
  let best = 0
  let bv = -Infinity
  for (let lag = -maxLag; lag <= maxLag; lag += 16) {
    const v = corr(lag)
    if (v > bv) {
      bv = v
      best = lag
    }
  }
  for (let lag = best - 16; lag <= best + 16; lag++) {
    const v = corr(lag)
    if (v > bv) {
      bv = v
      best = lag
    }
  }
  return best
}

/** テストを実行しているブラウザの物理メモリ（MB）。1 秒待って GC → 3 回の中央値。測れない環境では null */
async function settledMemoryMb(): Promise<number | null> {
  const w = window as unknown as { csxMemSample?: (id: string) => void; __csxMem?: Record<string, number | null> }
  if (!w.csxMemSample) return null
  await sleep(1000)
  gc()
  const xs: number[] = []
  for (let k = 0; k < 3; k++) {
    await sleep(500)
    const id = String(Math.random())
    w.csxMemSample(id)
    let v: number | null | undefined
    for (let i = 0; i < 100 && v === undefined; i++) {
      await sleep(100)
      if (w.__csxMem && id in w.__csxMem) v = w.__csxMem[id]
    }
    if (v === null || v === undefined) return null
    xs.push(v)
  }
  return xs.sort((a, b) => a - b)[1]
}

/**
 * 実時間の再生エンジンの出力を取り出す（AudioDestinationNode への接続を横取りして ScriptProcessorNode で記録する。試験専用）。
 * 録音は AudioContext の時刻つきで、再生開始の ctx 時刻からの位置に並べる
 */
function installRealtimeTap(): { start(): void; takeAll(): Float32Array[]; uninstall(): void } {
  const orig = AudioNode.prototype.connect
  const blocks: { t: number; L: Float32Array; R: Float32Array }[] = []
  let proc: ScriptProcessorNode | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(AudioNode.prototype as any).connect = function (this: AudioNode, dest: AudioNode | AudioParam, ...rest: number[]) {
    const r = (orig as (...a: unknown[]) => unknown).call(this, dest, ...rest)
    if (dest instanceof AudioDestinationNode && this.context instanceof AudioContext && !(this as unknown as { __tap?: boolean }).__tap && !(this instanceof ScriptProcessorNode)) {
      ;(this as unknown as { __tap?: boolean }).__tap = true
      const sp = this.context.createScriptProcessor(4096, 2, 2)
      sp.onaudioprocess = (e) => {
        blocks.push({ t: e.playbackTime, L: e.inputBuffer.getChannelData(0).slice(), R: e.inputBuffer.getChannelData(1).slice() })
      }
      ;(orig as (...a: unknown[]) => unknown).call(this, sp)
      ;(orig as (...a: unknown[]) => unknown).call(sp, this.context.destination)
      proc = sp
    }
    return r
  }
  return {
    start() {
      blocks.length = 0
    },
    /** 記録したブロックを AudioContext の時刻の順に並べる（途切れがあれば 0 で埋める） */
    takeAll() {
      if (blocks.length === 0) return [new Float32Array(0), new Float32Array(0)]
      const rate = proc?.context.sampleRate ?? RATE
      const t0 = blocks[0].t
      const last = blocks[blocks.length - 1]
      const n = Math.round((last.t - t0) * rate) + last.L.length
      const L = new Float32Array(n)
      const R = new Float32Array(n)
      for (const blk of blocks) {
        const o = Math.round((blk.t - t0) * rate)
        L.set(blk.L.subarray(0, Math.max(0, Math.min(blk.L.length, n - o))), o)
        R.set(blk.R.subarray(0, Math.max(0, Math.min(blk.R.length, n - o))), o)
      }
      return [L, R]
    },
    uninstall() {
      AudioNode.prototype.connect = orig
      if (proc) proc.onaudioprocess = null
    },
  }
}

function groupRange(): [number, number] {
  const m = /(?:^|[?&])groups=(\d+)-(\d+)/.exec(typeof location === 'undefined' ? '' : location.search)
  return m ? [Number(m[1]), Number(m[2])] : [0, Infinity]
}

// ---------------- 試験 ----------------

export async function runExportSelfTest(): Promise<TestResult[]> {
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
      gc()
    }
  }
  const check = (name: string, pass: boolean, detail: string) => record(name, pass, detail)
  const info = (name: string, detail: string) => record(name, true, detail, true)

  group = '60. WAV エンコード（ヘッダー・16 / 24-bit・リトルエンディアン・ディザ・ブラウザでのデコード）'
  if (want(60)) {
    const h = new DataView(wavHeader(1000, 2, 44100, 16))
    const s4 = (o: number) => String.fromCharCode(h.getUint8(o), h.getUint8(o + 1), h.getUint8(o + 2), h.getUint8(o + 3))
    const ok =
      s4(0) === 'RIFF' && h.getUint32(4, true) === 36 + 4000 && s4(8) === 'WAVE' && s4(12) === 'fmt ' && h.getUint32(16, true) === 16 && h.getUint16(20, true) === 1 &&
      h.getUint16(22, true) === 2 && h.getUint32(24, true) === 44100 && h.getUint32(28, true) === 44100 * 4 && h.getUint16(32, true) === 4 && h.getUint16(34, true) === 16 &&
      s4(36) === 'data' && h.getUint32(40, true) === 4000
    check('ヘッダー: RIFF / WAVE / fmt (PCM=1, 2ch, 44100 Hz, byteRate, blockAlign 4, 16-bit) / data 長（リトルエンディアン）', ok, `RIFF サイズ ${h.getUint32(4, true)}、data ${h.getUint32(40, true)} バイト`)
    // 16-bit: 既知の値（ディザなし）
    const vals = Float32Array.from([0, 0.5, -0.5, 1, -1, 1.5, -1.5, 1 / 32767])
    const e16 = encodeWav([vals, vals], { sampleRate: 48000, bitDepth: 16, dither: false })
    const b16 = new DataView(await e16.blob.arrayBuffer())
    const got16 = Array.from({ length: vals.length }, (_, i) => b16.getInt16(44 + i * 4, true))
    const exp16 = [0, 16384, -16384, 32767, -32767, 32767, -32768, 1]
    check('16-bit: 値の変換・リトルエンディアン・±1 を超える値の飽和を数える', got16.every((v, i) => Math.abs(v - exp16[i]) <= (i === 1 || i === 2 ? 1 : 0)) && e16.stats.clippedSamples === 4, `${got16.join(', ')}（飽和 ${e16.stats.clippedSamples}）`)
    const e24 = encodeWav([vals, vals], { sampleRate: 48000, bitDepth: 24 })
    const b24 = new Uint8Array(await e24.blob.arrayBuffer())
    const s24 = (i: number) => {
      const o = 44 + i * 6
      const v = b24[o] | (b24[o + 1] << 8) | (b24[o + 2] << 16)
      return v & 0x800000 ? v - 0x1000000 : v
    }
    check('24-bit: 3 バイトのリトルエンディアン（0.5 → 4194304、−1 → −8388607）', s24(1) === 4194304 && s24(4) === -8388607 && new DataView(b24.buffer).getUint16(34, true) === 24, `${s24(1)} / ${s24(4)}`)
    // ディザ: 同じシードで同じバイト列、別のシードで別、誤差は ±1 LSB 以内で平均 0
    const x = noise(1, 9, 0.3)
    const d1 = new Uint8Array(await encodeWav([x, x], { sampleRate: 48000, bitDepth: 16, seed: 7 }).blob.arrayBuffer())
    const d2 = new Uint8Array(await encodeWav([x, x], { sampleRate: 48000, bitDepth: 16, seed: 7 }).blob.arrayBuffer())
    const d3 = new Uint8Array(await encodeWav([x, x], { sampleRate: 48000, bitDepth: 16, seed: 8 }).blob.arrayBuffer())
    const same = d1.length === d2.length && d1.every((v, i) => v === d2[i])
    const dv = new DataView(d1.buffer)
    let errSum = 0
    let errMax = 0
    for (let i = 0; i < x.length; i++) {
      const e = dv.getInt16(44 + i * 4, true) - x[i] * 32767
      errSum += e
      errMax = Math.max(errMax, Math.abs(e))
    }
    check('TPDF ディザ: 同じシードで同じバイト列（再現性）・別のシードで別・誤差 ≤ 1.5 LSB・平均 ≈ 0', same && d1.some((v, i) => v !== d3[i]) && errMax <= 1.5 && Math.abs(errSum / x.length) < 0.02, `最大誤差 ${f2(errMax)} LSB、平均 ${(errSum / x.length).toFixed(4)} LSB`)
    const z = new Uint8Array(await encodeWav([zeros(0.1), zeros(0.1)], { sampleRate: 48000, bitDepth: 16 }).blob.arrayBuffer())
    check('デジタル無音はディザを加えず 0 のまま', z.subarray(44).every((v) => v === 0), `${z.length - 44} バイト`)
    check('RIFF の 4 GiB 制限: 超える長さは確保前に拒否', wavSizeError(2 ** 30, 2, 16) !== null && wavSizeError(48000 * 600, 2, 24) === null, wavSizeError(2 ** 30, 2, 16) ?? '')
    // ブラウザで読める（decodeAudioData）
    const tone = Float32Array.from({ length: 48000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000))
    for (const bitDepth of [16, 24] as const) {
      const blob = encodeWav([tone, tone.map((v) => -v)], { sampleRate: 48000, bitDepth, dither: false }).blob
      const ctx = new OfflineAudioContext(2, 1, 48000)
      const dec = await ctx.decodeAudioData(await blob.arrayBuffer())
      const err = Math.max(...Array.from({ length: 1000 }, (_, i) => Math.abs(dec.getChannelData(0)[i * 40] - tone[i * 40])))
      check(
        `${bitDepth}-bit の WAV をブラウザがデコードできる（2ch・48 kHz・長さ・値が一致）`,
        dec.numberOfChannels === 2 && dec.sampleRate === 48000 && dec.length === 48000 && err <= (bitDepth === 16 ? 1 / 32767 : 1e-6) && Math.abs(dec.getChannelData(1)[1000] + tone[1000]) < 1e-3,
        `誤差 ${err.toExponential(1)}`,
      )
    }
  }

  group = '61. オフラインレンダリングの基本（ステレオ・入力と同じレート・長さ・先頭の時刻合わせ）'
  if (want(61)) {
    for (const rate of [44100, 48000]) {
      const mono = toBuffer([noise(2, 3, 0.3)])
      const src = new AudioBuffer({ length: Math.round(2 * rate), numberOfChannels: 1, sampleRate: rate })
      src.copyToChannel(noise(2, 3, 0.3, rate) as Float32Array<ArrayBuffer>, 0)
      void mono
      const dsp = dspOf(1)
      const r = await exportFloat(plainRequest(src, dsp))
      const expectTail = reverbTailSeconds(dsp.spatial)
      check(
        `${rate} Hz のモノラル音源 → ${rate} Hz のステレオ・長さ = 音源 + 余韻（LIVE ARENA、余韻の上限 ${expectTail.toFixed(2)} 秒）`,
        r.channels.length === 2 && r.channels[0].length > src.length && r.tailSeconds > 0.5 && r.tailSeconds <= expectTail + 0.36,
        `${r.channels[0].length} フレーム（音源 ${r.sourceSeconds.toFixed(2)} 秒 + 余韻 ${r.tailSeconds.toFixed(2)} 秒）、先頭の切り捨て ${(r.headTrimSeconds * 1000).toFixed(1)} ms`,
      )
    }
    // 先頭の時刻合わせ: L=R のインパルスの直接音が、元の時刻 + Motion の CENTER の伝搬遅延（距離による意図した遅れ）に来る
    const imp = new Float32Array(Math.round(3 * RATE))
    imp[RATE] = 0.5
    for (const i of [0, 1, 3]) {
      const dsp = dspOf(i)
      const r = await exportFloat(plainRequest(toBuffer([imp, imp.slice()]), dsp))
      let mx = 0
      for (let k = 0; k < r.channels[0].length; k++) mx = Math.max(mx, Math.abs(r.channels[0][k]) + Math.abs(r.channels[1][k]))
      let onset = -1
      for (let k = 0; k < r.channels[0].length && onset < 0; k++) if (Math.abs(r.channels[0][k]) + Math.abs(r.channels[1][k]) >= mx * 0.25) onset = k
      const expected = RATE + (dsp.spatial.motionEnabled ? Math.round(distanceDelaySeconds(motionLayout(dsp.spatial).baseDistance) * RATE) : 0)
      check(
        `${SPATIAL_PRESETS[i].label}: 先頭の処理の遅延を切り捨て、直接音が元の時刻（+ 距離の伝搬遅延）から ±1 ms`,
        Math.abs(onset - expected) <= RATE * 0.001,
        `到達 ${((onset - RATE) / RATE * 1000).toFixed(2)} ms（期待 ${((expected - RATE) / RATE * 1000).toFixed(2)} ms）、切り捨て ${(r.headTrimSeconds * 1000).toFixed(1)} ms`,
      )
    }
  }

  group = '62. 余韻の書き出し（末尾まで保存・自然に無音へ・クリックなし・既存 HALL の余韻）'
  if (want(62)) {
    const mix = programStereoMix(3)
    const cases: [string, DspConfig][] = [
      ['HALL（既定値、Tail OFF）', { ...dspOf(1), bassEnabled: false, spatial: { ...DEFAULT_SPATIAL_PARAMS, mode: 'hall' } }],
      ...SPATIAL_PRESETS.map((p, i) => [p.label, dspOf(i)] as [string, DspConfig]),
      ['WIDE（残響なし）', { ...dspOf(1), bassEnabled: false, spatial: { ...DEFAULT_SPATIAL_PARAMS, mode: 'wide' } }],
    ]
    for (const [label, dsp] of cases) {
      const r = await exportFloat(plainRequest(mix, dsp))
      const [L, R] = r.channels
      const n = L.length
      const end = mix.length
      const t60 = stopDecaySeconds({ getChannelData: (c: number) => (c === 0 ? L : R) }, 3)
      const lastPeak = Math.max(maxAbsRange(L, n - Math.round(0.12 * RATE), n), maxAbsRange(R, n - Math.round(0.12 * RATE), n))
      let d2 = 0
      for (const x of [L, R]) for (let i = n - Math.round(0.05 * RATE); i < n; i++) d2 = Math.max(d2, Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]))
      check(
        `${label}: 余韻を末尾まで含む（−60 dB まで ${(t60 * 1000).toFixed(0)} ms を含む長さ）・最後の 120 ms ≤ −100 dBFS・最後のサンプルは 0`,
        r.tailSeconds >= Math.min(t60, reverbTailSeconds(dsp.spatial)) && linearToDb(lastPeak) <= -100 && L[n - 1] === 0 && R[n - 1] === 0 && d2 < 1e-5,
        `余韻 ${r.tailSeconds.toFixed(2)} 秒（上限 ${reverbTailSeconds(dsp.spatial).toFixed(2)} 秒）、末尾 ${f1(linearToDb(lastPeak))} dBFS、2 階差分 ${d2.toExponential(1)}`,
      )
      void end
    }
    // 既存 HALL の余韻（Phase 04 のベースライン 1680 ms と同じ測り方）が書き出しでも同じ
    const hallDsp: DspConfig = { ...dspOf(1), bassEnabled: false, spatial: { ...DEFAULT_SPATIAL_PARAMS, mode: 'hall' } }
    const r = await exportFloat(plainRequest(mix, hallDsp))
    const t60 = stopDecaySeconds({ getChannelData: (c: number) => r.channels[c] }, 3)
    check('既存 HALL（既定値）の停止後の余韻が Phase 04 のベースライン（1680 ms）と ±40 ms', Math.abs(t60 * 1000 - 1680) <= 40, `${(t60 * 1000).toFixed(0)} ms`)
  }

  group = '63. Motion の再現（曲の先頭から・シークやプレビューの履歴によらない）'
  if (want(63)) {
    const mix = programStereoMix(6)
    const dsp = dspOf(2)
    const a = await engineSnapshot(mix, dsp)
    const ra = await exportFloat(requestOf(mix, a.snap))
    const rb = await exportFloat(requestOf(mix, a.snap))
    check('同じ設定の書き出し 2 回が一致（差 ≤ −120 dB、畳み込みの揺らぎのみ）', maxDiffDb(ra.channels, rb.channels) <= -120, `${f1(maxDiffDb(ra.channels, rb.channels))} dB`)
    // 再生・シーク・一時停止・ループをしてから書き出しても同じ
    const e = a.engine
    await e.play()
    await sleep(700)
    e.seek(3.2)
    await sleep(500)
    e.setLoop(true, 'spatial')
    await sleep(300)
    e.pause()
    const snap2 = await e.exportSnapshot()
    await e.suspendForExport()
    const rc = await exportFloat(requestOf(mix, snap2))
    check('再生・シーク・ループ・一時停止の後に書き出しても、最初の書き出しと一致（≤ −120 dB）', maxDiffDb(ra.channels, rc.channels) <= -120, `${f1(maxDiffDb(ra.channels, rc.channels))} dB`)
    // Motion の動きが曲の先頭から: 先頭 1 秒の ILD の動きが、音源の先頭から 2 秒ずらして書き出した音の 2 秒以降と一致しない（時刻依存）ことの対照と、
    // ずらさない書き出しどうしでは一致すること
    const ta = ildTrack(ra.channels[0], ra.channels[1], 0.5, 5.5, 0.1, RATE)
    const tb = ildTrack(rc.channels[0], rc.channels[1], 0.5, 5.5, 0.1, RATE)
    check('Motion の左右の動き（ILD、0.1 秒ごと）が書き出しごとに同じ（相関 ≥ 0.999）', corrOf(ta, tb) >= 0.999, `相関 ${corrOf(ta, tb).toFixed(4)}`)
    releaseShared()
  }

  group = '64. プリセット・CUSTOM の反映'
  if (want(64)) {
    const mix = programStereoMix(4)
    const outs: Float32Array[][] = []
    for (let i = 0; i < 4; i++) {
      const { engine, snap } = await engineSnapshot(mix, dspOf(i))
      check(`${SPATIAL_PRESETS[i].label}: 書き出しに使う設定 = プリセットの設定`, JSON.stringify(snap.dsp) === JSON.stringify(dspOf(i)), `${snap.dsp.spatial.mode} / Motion ${snap.dsp.spatial.motionEnabled ? snap.dsp.spatial.motionPreset : 'OFF'} / Tail ${snap.dsp.spatial.tailMode}・トリム ${f1(snap.spatialTrimDb)} dB`)
      outs.push((await exportFloat(requestOf(mix, snap))).channels)
      void engine
    }
    const pairs: string[] = []
    let allDiff = true
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++) {
        const d = energyRatioDb(outs[i], outs[j], RATE)
        if (d < -20) allDiff = false
        pairs.push(`${i + 1}-${j + 1} ${f1(d)}`)
      }
    check('4 つのプリセットの書き出しがそれぞれ異なる（差のエネルギー比 ≥ −20 dB）', allDiff, pairs.join(' / ') + ' dB')
    // CUSTOM: DEPTH を変えると直接音が下がり、残響の比率が上がる
    const custom = dspOf(1)
    custom.spatial.depth = 90
    custom.spatial.tailLength = 30
    const { engine, snap } = await engineSnapshot(mix, custom)
    const rc = (await exportFloat(requestOf(mix, snap))).channels
    void engine
    releaseShared()
    const d = energyRatioDb(outs[1], rc, RATE)
    const tailOf = (x: Float32Array[]) => stopDecaySeconds({ getChannelData: (c: number) => x[c] }, 4)
    check('CUSTOM（LIVE ARENA の DEPTH 90・TAIL LENGTH 30）が書き出しに反映（元のプリセットとの差 ≥ −20 dB・余韻が短くなる）', snap.dsp.spatial.depth === 90 && d >= -20 && tailOf(rc) < tailOf(outs[1]) - 0.3, `差 ${f1(d)} dB、余韻 ${(tailOf(outs[1]) * 1000).toFixed(0)} → ${(tailOf(rc) * 1000).toFixed(0)} ms`)
  }

  group = '65. リアルタイム再生との一致（同じ音源・同じ設定、実時間の再生エンジンの出力を記録して比較）'
  if (want(65)) {
    const mix = programStereoMix(6)
    const which = new URLSearchParams(location.search).get('cases')
    const cases: [string, DspConfig][] = [
      ['CINEMA 3D', dspOf(0)],
      ['LIVE ARENA', dspOf(1)],
      ['360° MOTION', dspOf(2)],
      ['IMMERSIVE X', dspOf(3)],
      ['CUSTOM（CINEMA 3D・DEPTH 30・RIPPLE + DYNAMIC）', { ...dspOf(0), spatial: { ...dspOf(0).spatial, depth: 30, tailMode: 'ripple', dynamicTail: true } }],
      ['LIVE ARENA・重低音 OFF', { ...dspOf(1), bassEnabled: false }],
      ['360° MOTION・Motion OFF', { ...dspOf(2), spatial: { ...dspOf(2).spatial, motionEnabled: false } }],
      ['CINEMA 3D・Tail OFF', { ...dspOf(0), spatial: { ...dspOf(0).spatial, tailMode: 'off' } }],
    ]
    const sel = which ? cases.filter((_, k) => which.split(',').includes(String(k))) : cases
    for (const [label, dsp] of sel) {
      // 先に横取りを入れてから再生エンジンを作る（エンジンが AudioContext の出力へつなぐときに記録を挟む）
      const tap = installRealtimeTap()
      let rec: Float32Array[]
      let off: Float32Array[]
      try {
        const { engine, snap } = await engineSnapshot(mix, dsp, true)
        off = (await exportFloat(requestOf(mix, snap))).channels
        // 書き出しのために止めた AudioContext を再開し、設定の平滑化（トリム 80 ms・EQ など）が落ち着いてから再生する
        await engine.resumeAfterExport()
        await sleep(1500)
        tap.start()
        await engine.play()
        await sleep((off[0].length / RATE) * 1000 + 800)
        engine.stop()
        engine.dispose()
        rec = tap.takeAll()
      } finally {
        tap.uninstall()
      }
      // 再生開始の時刻は記録の外から分からないため、相互相関で書き出しと同じ時刻に並べる（1〜2 秒の区間で、最大 0.8 秒のずれ）
      const lag = lagOf(off, rec, RATE, RATE, Math.round(0.8 * RATE))
      const rt = rec.map((x) => {
        const y = new Float32Array(off[0].length)
        for (let k = 0; k < y.length; k++) {
          const m = k + lag
          if (m >= 0 && m < x.length) y[k] = x[m]
        }
        return y
      })
      const ro = compareOutputs(rt, off, mix.duration)
      const pass = ro.bandMax <= 0.5 && Math.abs(ro.loudDiff) <= 0.2 && ro.widthDiff <= 0.3 && ro.corrDiff <= 0.02 && ro.ildCorr >= 0.98 && ro.ildMad <= 0.5 && Math.abs(ro.decayDiffMs) <= 50 && Math.abs(ro.peakDiff) <= 0.2
      check(
        `${label}: 周波数特性 ±0.5 dB・ラウドネス ±0.2 LU・ステレオ幅 ±0.3 dB・相関 ±0.02・Motion の動き（相関 ≥ 0.98・平均差 ≤ 0.5 dB）・余韻 ±50 ms・ピーク ±0.2 dB`,
        pass,
        `帯域 最大 ${f2(ro.bandMax)} dB、ラウドネス ${f2(ro.loudDiff)} LU、幅 ${f2(ro.widthDiff)} dB、相関 ${ro.corrDiff.toFixed(3)}、ILD 相関 ${ro.ildCorr.toFixed(3)}・差 ${f2(ro.ildMad)} dB、余韻 ${ro.decayDiffMs.toFixed(0)} ms、ピーク ${f2(ro.peakDiff)} dB`,
      )
      {
        const seg = (t0: number, t1: number) => energyRatioDb(off.map((x) => x.subarray(Math.round(t0 * RATE), Math.round(t1 * RATE))), rt.map((x) => x.subarray(Math.round(t0 * RATE), Math.round(t1 * RATE))))
        const segs = [0, 0.1, 0.5, 1, 2, 3, 4, 5, 6, 7].map((t, k, arr) => (k + 1 < arr.length ? `${t}-${arr[k + 1]}s ${f1(seg(t, arr[k + 1]))}` : '')).filter(Boolean)
        let worst = 0
        let at = 0
        for (let k = 0; k < off[0].length; k++) {
          const d = Math.abs(off[0][k] - rt[0][k])
          if (d > worst) {
            worst = d
            at = k
          }
        }
        info(`${label}: 区間ごとの差（参考）`, segs.join(' / ') + ` / 最大差の位置 ${(at / RATE).toFixed(4)} 秒`)
      }
      info(`${label}: サンプル単位の差（参考）`, `最大差 ${f1(ro.sampleMaxDb)} dB（ピーク比）、差のエネルギー比 ${f1(ro.sampleEnergyDb)} dB、記録の中の再生開始 ${lag} サンプル`)
      gc()
    }
  }

  group = '65b. サンプル単位で一致しない理由の確認（オフラインどうしで開始位置だけをずらす）'
  if (want(65) && (!new URLSearchParams(location.search).get('cases') || new URLSearchParams(location.search).get('cases')!.includes('7'))) {
    // 実時間の再生は任意の時刻（128 サンプル単位）から始まり、Motion の STFT（ホップ 1024 サンプル）の区切りと音源の先頭の関係が
    // 書き出し（時刻 0 から）と変わる。オフラインどうしで、無音を 640 サンプル（128 × 5）前に足して同じことを起こし、差を測る
    const mix = programStereoMix(6)
    for (const [label, dsp] of [
      ['360° MOTION', dspOf(2)],
      ['LIVE ARENA（Motion なし）', dspOf(1)],
    ] as [string, DspConfig][]) {
      const a = (await exportFloat(plainRequest(mix, dsp))).channels
      const pad = 640
      const shifted = toBuffer(chansOf(mix).map((c) => {
        const y = new Float32Array(c.length + pad)
        y.set(c, pad)
        return y
      }))
      const b = (await exportFloat(plainRequest(shifted, dsp))).channels.map((x) => x.subarray(pad))
      info(`${label}: 開始を 640 サンプルずらしたオフラインどうしの差`, `差のエネルギー比 ${f1(energyRatioDb(a, b))} dB（最大差 ${f1(maxDiffDb(a, b))} dB）`)
    }
  }

  group = '66. 無音入力・短い音源'
  if (want(66)) {
    const silent = toBuffer([zeros(2), zeros(2)])
    for (const i of [0, 1]) {
      const { snap } = await engineSnapshot(silent, dspOf(i))
      const r = await exportFloat(requestOf(silent, snap))
      const wav = encodeWav(r.channels, { sampleRate: RATE, bitDepth: 16 })
      const bytes = new Uint8Array(await wav.blob.arrayBuffer())
      check(
        `${SPATIAL_PRESETS[i].label}: 無音の音源 → 無音の WAV（全サンプル 0・NaN なし・ヘッダー正常）`,
        r.channels.every((x) => x.every((v) => v === 0)) && bytes.subarray(44).every((v) => v === 0) && bytes.length === 44 + r.channels[0].length * 4,
        `${r.channels[0].length} フレーム、${bytes.length} バイト`,
      )
    }
    for (const [label, frames] of [
      ['1 サンプル', 1],
      ['10 ms', Math.round(0.01 * RATE)],
      ['0.3 秒', Math.round(0.3 * RATE)],
    ] as [string, number][]) {
      const x = noise(frames / RATE + 1e-9, 4, 0.3).subarray(0, frames)
      const buf = toBuffer([x.slice(), x.slice()])
      const r = await exportFloat(plainRequest(buf, dspOf(3)))
      const pk = linearToDb(samplePeak(r.channels))
      check(`短い音源（${label}）: 書き出せる・長さ ≥ 音源・有限・ピーク ≤ −1 dBFS`, r.channels[0].length >= frames && r.channels.every((c) => c.every((v) => Number.isFinite(v))) && pk <= -0.99, `${r.channels[0].length} フレーム（余韻 ${r.tailSeconds.toFixed(2)} 秒）、ピーク ${f2(pk)} dBFS`)
    }
  }

  group = '67. 実際の書き出し経路（使い捨てフレーム）: 長い音源・ピーク・ラウドネス・位相'
  if (want(67)) {
    const long = toBuffer([noise(180, 5, 0.12), noise(180, 6, 0.12)])
    const est = estimateExportBytes(long.length, 2, RATE, dspOf(3).spatial, 16)
    const m0 = await settledMemoryMb()
    const t0 = performance.now()
    const stages: string[] = []
    let lastRendered = 0
    const job = startExport(plainRequest(long, dspOf(3)), (p: ExportProgress) => {
      if (!stages.includes(p.stage)) stages.push(p.stage)
      if (p.rendered !== undefined) lastRendered = p.rendered
    })
    const res = await job.promise
    const ms = performance.now() - t0
    const m1 = await settledMemoryMb()
    const head = new DataView(await res.blob.slice(0, 44).arrayBuffer())
    check(
      '3 分のステレオ（IMMERSIVE X）を書き出せる・WAV（16-bit・2ch・48 kHz・data 長 = フレーム × 4）',
      head.getUint16(22, true) === 2 && head.getUint32(24, true) === RATE && head.getUint16(34, true) === 16 && head.getUint32(40, true) === res.frames * 4 && res.blob.size === 44 + res.frames * 4 && res.clippedSamples === 0,
      `${(res.blob.size / 2 ** 20).toFixed(1)} MB、${(res.frames / RATE).toFixed(2)} 秒、処理 ${(ms / 1000).toFixed(1)} 秒（実時間比 ${((ms / 1000 / 180) * 100).toFixed(0)}%）、段階 ${stages.join(' → ')}、最後の進捗 ${(lastRendered * 100).toFixed(0)}%`,
    )
    check('書き出し後にフレームが残らない', exportFrameCount() === 0, `${exportFrameCount()} 個`)
    check('ピーク ≤ −1 dBFS・飽和 0', res.peakDb <= -0.99 && res.clippedSamples === 0, `${f2(res.peakDb)} dBFS`)
    if (m0 !== null && m1 !== null) info('3 分の書き出しの前後のメモリ（フレーム破棄後）', `${m0.toFixed(0)} → ${m1.toFixed(0)} MB（${f1(m1 - m0)} MB）、見積もり ${(est / 2 ** 20).toFixed(0)} MB`)
    const huge = estimateExportBytes(6 * 3600 * RATE, 2, RATE, dspOf(3).spatial, 16)
    check('6 時間の音源はメモリの見積もりで書き出し前に止める（上限 30 分・メモリ上限）', huge > exportMemoryBudget(8) && 6 * 3600 > EXPORT_MAX_SECONDS, `見積もり ${(huge / 2 ** 30).toFixed(1)} GiB > 上限 ${(exportMemoryBudget(8) / 2 ** 30).toFixed(1)} GiB`)
    // 品質: 楽曲相当信号で位相・モノラル（16-bit の WAV をデコードして測る）
    const mix = programStereoMix(8)
    const before = stereoMetrics(chansOf(mix), RATE)
    for (const i of [0, 1, 2, 3]) {
      const { snap } = await engineSnapshot(mix, dspOf(i))
      const r = await startExport(requestOf(mix, snap), () => {}).promise
      const dec = await new OfflineAudioContext(2, 1, RATE).decodeAudioData(await r.blob.arrayBuffer())
      const m = stereoMetrics(chansOf(dec), RATE)
      const monoDrop = m.monoLoudnessLufs - m.loudnessLufs - (before.monoLoudnessLufs - before.loudnessLufs)
      const pk16 = linearToDb(samplePeak(chansOf(dec)))
      check(
        `${SPATIAL_PRESETS[i].label}（16-bit WAV をデコード）: ピーク ≤ −1 dBFS + 1 LSB・ラウドネス ±1 LU・相関 ≥ 0・低域の相関 ≥ 原音 − 0.05・モノラル和の低下の増分 ≥ −1.5 LU`,
        pk16 <= -1 + 0.01 && Math.abs(m.loudnessLufs - before.loudnessLufs) <= 1 && m.correlation >= 0 && m.bandCorrelation.low >= before.bandCorrelation.low - 0.05 && monoDrop >= -1.5,
        `ピーク ${f2(pk16)} dBFS、ラウドネス ${f1(m.loudnessLufs - before.loudnessLufs)} LU、相関 ${f2(m.correlation)}、低域 ${f2(m.bandCorrelation.low)}、モノラル ${f1(monoDrop)} LU`,
      )
    }
  }

  group = '68. メモリ（書き出しを繰り返しても増え続けない。使い捨てフレームの効果）'
  if (want(68)) {
    const buf = toBuffer([noise(60, 7, 0.12), noise(60, 8, 0.12)])
    const mem: (number | null)[] = [await settledMemoryMb()]
    for (let k = 0; k < 3; k++) {
      const r = await startExport(plainRequest(buf, dspOf(3)), () => {}).promise
      const url = URL.createObjectURL(r.blob)
      URL.revokeObjectURL(url)
      mem.push(await settledMemoryMb())
    }
    if (mem.some((m) => m === null)) check('60 秒の書き出し 3 回: 2〜3 回目の増加 ≤ 30 MB', false, '未実行: ブラウザのメモリを測れない環境（npm run test:export で実行してください）')
    else {
      const m = mem as number[]
      check('60 秒の書き出し 3 回（IMMERSIVE X）: 2〜3 回目の増加 ≤ 30 MB', m[3] - m[1] <= 30, `${m.map((v) => v.toFixed(0)).join(' → ')} MB`)
      // 参考: フレームを使わず同じページで書き出した場合（Chrome が文脈を解放しない）
      const w0 = analysisStats.workletRenders
      await renderExportFloat(plainRequest(buf, dspOf(3)))
      const m4 = await settledMemoryMb()
      void w0
      if (m4 !== null) info('参考: 使い捨てフレームを使わずにページ内で 1 回書き出した場合の増加', `${f1(m4 - m[3])} MB（この文脈はページを閉じるまで解放されない）`)
    }
  }

  group = '69. キャンセル'
  if (want(69)) {
    const buf = toBuffer([noise(60, 9, 0.12), noise(60, 10, 0.12)])
    let sawRendering = false
    const job = startExport(plainRequest(buf, dspOf(3)), (p) => {
      if (p.stage === 'rendering' && (p.rendered ?? 0) > 0.05 && !sawRendering) {
        sawRendering = true
        job.cancel()
      }
    })
    let cancelled = false
    let result: unknown = null
    try {
      result = await job.promise
    } catch (e) {
      cancelled = e instanceof ExportCancelledError
    }
    check('レンダリング中にキャンセル → 結果を返さず ExportCancelledError、フレームは削除', sawRendering && cancelled && result === null && exportFrameCount() === 0, `レンダリング中 ${sawRendering}、キャンセル ${cancelled}、フレーム ${exportFrameCount()}`)
    const job2 = startExport(plainRequest(toBuffer([noise(2, 11), noise(2, 12)]), dspOf(0)), () => {})
    job2.cancel()
    let c2 = false
    try {
      await job2.promise
    } catch (e) {
      c2 = e instanceof ExportCancelledError
    }
    const r3 = await startExport(plainRequest(toBuffer([noise(2, 11), noise(2, 12)]), dspOf(0)), () => {}).promise
    check('準備中のキャンセルも同様・キャンセル後の書き出しは正常に完了', c2 && r3.blob.size > 44, `${r3.blob.size} バイト`)
  }

  group = '70. 完成音声のプレビュー・ダウンロード'
  if (want(70)) {
    const mix = programStereoMix(3)
    const { snap } = await engineSnapshot(mix, dspOf(0))
    releaseShared()
    const r = await startExport(requestOf(mix, snap), () => {}).promise
    const url = URL.createObjectURL(r.blob)
    const audio = new Audio()
    audio.preload = 'auto'
    audio.src = url
    const loaded = await new Promise<boolean>((res) => {
      audio.oncanplaythrough = () => res(true)
      audio.onerror = () => res(false)
      setTimeout(() => res(false), 10000)
    })
    check('<audio> で書き出した WAV（Object URL）を読み込める・長さが一致（再生用の DSP は通らない）', loaded && Math.abs(audio.duration - r.frames / r.sampleRate) < 0.01, `読み込み ${loaded}、長さ ${f2(audio.duration)} / ${f2(r.frames / r.sampleRate)} 秒`)
    const a = document.createElement('a')
    a.href = url
    a.download = 'test.wav'
    check('ダウンロード用のリンク（blob: URL・download 属性）', a.href.startsWith('blob:') && a.download === 'test.wav' && r.blob.type === 'audio/wav', a.href.slice(0, 30))
    audio.src = ''
    URL.revokeObjectURL(url)
    const revoked = await fetch(url).then(
      () => false,
      () => true,
    )
    check('Object URL を解放すると読めなくなる（解放の確認）', revoked, revoked ? '解放済み' : 'まだ読める')
  }

  group = '71. 入力形式（ブラウザのデコーダー）'
  if (want(71)) {
    // WebM / Opus: MediaRecorder で作ってデコードできるか（Chrome / Edge の実装を確認）
    let webm: Blob | null = null
    try {
      const ctx = new AudioContext({ sampleRate: 48000 })
      const osc = new OscillatorNode(ctx, { frequency: 440 })
      const dest = new MediaStreamAudioDestinationNode(ctx)
      osc.connect(dest)
      osc.start()
      const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' })
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => chunks.push(e.data)
      const stopped = new Promise((r) => (rec.onstop = r))
      rec.start()
      await sleep(1200)
      rec.stop()
      await stopped
      osc.stop()
      await ctx.close()
      webm = new Blob(chunks, { type: 'audio/webm' })
    } catch {
      webm = null
    }
    if (!webm) check('WebM / Opus: 作成できない環境', false, '未実行')
    else {
      const bytes = new Uint8Array(await webm.arrayBuffer())
      const kind = inspectAudioHeader(bytes)?.format
      let decoded = 0
      try {
        decoded = (await new OfflineAudioContext(2, 1, 48000).decodeAudioData(bytes.buffer.slice(0))).duration
      } catch {
        decoded = -1
      }
      check('WebM / Opus（MediaRecorder で作成）: 形式を判定でき、デコードできる', kind === 'webm' && decoded > 0.5, `判定 ${kind}、デコード後 ${f2(decoded)} 秒`)
    }
    const flac = new Uint8Array(42)
    flac.set([0x66, 0x4c, 0x61, 0x43, 0x00, 0, 0, 34], 0)
    // STREAMINFO: 44100 Hz（20 bit: 0x0AC44）・2ch（3 bit: 1）・24-bit（5 bit: 23 = 0b10111）
    flac.set([0x0a, 0xc4, 0x43, 0x70], 18)
    const fh = inspectAudioHeader(flac)
    check('FLAC のヘッダー（STREAMINFO）からサンプルレート・チャンネル・ビット数を読む', fh?.format === 'flac' && fh.header.sampleRate === 44100 && fh.header.channels === 2 && fh.header.bitDepth === 24, JSON.stringify(fh?.header))
    info('未検証の形式', 'FLAC・Ogg（Vorbis / Opus）・M4A（AAC）は実ファイルでのデコードを試験していない（ブラウザが対応していれば読み込める。失敗時はデコードエラーを表示）。MP3 も Phase 06 では実ファイルで再確認していない')
  }

  releaseShared()
  return results
}

// ---------------- リアルタイムとの比較 ----------------

interface Compare {
  bandMax: number
  loudDiff: number
  widthDiff: number
  corrDiff: number
  ildCorr: number
  ildMad: number
  decayDiffMs: number
  peakDiff: number
  sampleMaxDb: number
  sampleEnergyDb: number
}

function compareOutputs(rt: Float32Array[], off: Float32Array[], sourceSeconds: number): Compare {
  const n = Math.min(rt[0].length, off[0].length)
  const a = rt.map((x) => x.subarray(0, n))
  const b = off.map((x) => x.subarray(0, n))
  const la = thirdOctaveLevelsDb(averageSpectrum(a, RATE, 8192))
  const lb = thirdOctaveLevelsDb(averageSpectrum(b, RATE, 8192))
  let bandMax = 0
  THIRD_OCTAVE_CENTERS.forEach((fc, k) => {
    if (fc >= 100 && fc <= 16000) bandMax = Math.max(bandMax, Math.abs(la[k] - lb[k]))
  })
  const ma = stereoMetrics(a, RATE)
  const mb = stereoMetrics(b, RATE)
  const ta = ildTrack(a[0], a[1], 0.3, n / RATE - 0.5, 0.1, RATE)
  const tb = ildTrack(b[0], b[1], 0.3, n / RATE - 0.5, 0.1, RATE)
  const ildMad = ta.reduce((s, v, i) => s + Math.abs(v - tb[i]), 0) / ta.length
  const da = stopDecaySeconds({ getChannelData: (c: number) => a[c] }, sourceSeconds)
  const db = stopDecaySeconds({ getChannelData: (c: number) => b[c] }, sourceSeconds)
  return {
    bandMax,
    loudDiff: integratedLoudness(a, RATE) - integratedLoudness(b, RATE),
    widthDiff: Math.max(Math.abs(ma.bandWidthDb.mid - mb.bandWidthDb.mid), Math.abs(ma.bandWidthDb.high - mb.bandWidthDb.high)),
    corrDiff: Math.abs(ma.correlation - mb.correlation),
    ildCorr: corrOf(ta, tb),
    ildMad,
    decayDiffMs: (da - db) * 1000,
    peakDiff: linearToDb(samplePeak(a)) - linearToDb(samplePeak(b)),
    sampleMaxDb: maxDiffDb(b, a),
    sampleEnergyDb: energyRatioDb(b, a),
  }
}

