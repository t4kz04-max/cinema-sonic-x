// Phase 09: 音響品質の最終測定（?suite=quality、npm run test:quality）。
// 4 プリセットを、アプリと同じ手順（再生エンジンで解析 → 書き出しの使い捨てフレームで描画）で処理した出力（量子化前）を測る。
// 判定するのは、これまでの Phase で決めた基準だけ（サンプルピーク ≤ −1 dBFS・ラウドネス ±1 LU・位相相関 ≥ 0・飽和 0・NaN なし）。
// それ以外（True Peak・周波数特性・幅・中央の安定・動きの連続性・余韻の減衰・低域）は INFO（合否なし）。
// 実際の楽曲・ヘッドホンでの聴感の評価ではない（合成した楽曲相当の信号での測定）。

import { AudioEngine } from '../audio/AudioEngine'
import type { DspConfig } from '../audio/dspConfig'
import { startExport } from '../audio/export/exportRunner'
import { linearToDb, samplePeak } from '../audio/loudness'
import { presetToDsp, SPATIAL_PRESETS } from '../audio/presets/spatialPresets'
import { averageSpectrum, bandLevelDb, thirdOctaveLevelsDb, THIRD_OCTAVE_CENTERS } from '../audio/spectrum'
import { stereoMetrics, type StereoMetrics } from '../audio/stereoMetrics'
import type { TestResult } from './dspSelfTest'
import { programAcoustic, programEdm, programStereoMix, TEST_RATE, toBuffer } from './testSignals'

const RATE = TEST_RATE
const f1 = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}` : String(v))
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : String(v))
const chansOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c))

/** 音源の後ろに無音を足す（余韻の減衰を測るため） */
function withSilence(buf: AudioBuffer, seconds: number): AudioBuffer {
  const pad = Math.round(seconds * RATE)
  return toBuffer(chansOf(buf).map((c) => {
    const x = new Float32Array(c.length + pad)
    x.set(c)
    return x
  }))
}

/** 中央の声（L = R、ビブラートつきの倍音）だけの信号。CINEMA 3D などで中央の音が中央に残るかを測る */
function centerVoice(seconds: number): AudioBuffer {
  const n = Math.round(seconds * RATE)
  const x = new Float32Array(n)
  let ph = 0
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const f = 220 * (1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * t))
    ph += (2 * Math.PI * f) / RATE
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.4 * t) ** 2
    let v = 0
    for (let h = 1; h <= 8; h++) v += Math.sin(h * ph) / h
    x[i] = 0.25 * env * v
  }
  return toBuffer([x, x.slice()])
}

/**
 * True Peak（4 倍オーバーサンプリング、窓付き sinc 32 タップ。ITU-R BS.1770 の方式に近いが同一ではない）。dBTP
 */
function truePeakDb(channels: Float32Array[]): number {
  const TAPS = 16
  const phases = [0.25, 0.5, 0.75].map((frac) => {
    const h = new Float64Array(2 * TAPS)
    for (let j = -TAPS + 1; j <= TAPS; j++) {
      const x = j - frac
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (TAPS + 1))
      h[j + TAPS - 1] = sinc * w
    }
    return h
  })
  let peak = samplePeak(channels)
  for (const c of channels) {
    for (let n = TAPS; n < c.length - TAPS; n++) {
      // 隣り合うサンプルが小さければ間のピークも小さい（計算を省く）
      if (Math.abs(c[n]) < peak * 0.7 && Math.abs(c[n + 1]) < peak * 0.7) continue
      for (const h of phases) {
        let y = 0
        for (let j = -TAPS + 1; j <= TAPS; j++) y += c[n + j] * h[j + TAPS - 1]
        if (Math.abs(y) > peak) peak = Math.abs(y)
      }
    }
  }
  return linearToDb(peak)
}

/** 区間ごとの RMS レベル（dB、左右の平均パワー） */
function levelTrack(ch: Float32Array[], from: number, to: number, step: number): number[] {
  const out: number[] = []
  for (let s = from; s + step <= to; s += step) {
    let p = 0
    for (const c of ch) for (let i = s; i < s + step; i++) p += c[i] * c[i]
    out.push(10 * Math.log10(p / (step * ch.length) + 1e-20))
  }
  return out
}

/** 区間ごとの ILD（R − L、dB） */
function ildTrack(ch: Float32Array[], from: number, to: number, step: number): number[] {
  const out: number[] = []
  for (let s = from; s + step <= to; s += step) {
    let l = 0
    let r = 0
    for (let i = s; i < s + step; i++) {
      l += ch[0][i] ** 2
      r += ch[1][i] ** 2
    }
    out.push(10 * Math.log10((r + 1e-20) / (l + 1e-20)))
  }
  return out
}

/** クリックの指標: 2 階差分の最大値 ÷ RMS（大きいほど急な不連続がある） */
function clickIndex(ch: Float32Array[], from: number, to: number): number {
  let m = 0
  let p = 0
  let n = 0
  for (const c of ch) {
    for (let i = Math.max(from, 2); i < to; i++) {
      m = Math.max(m, Math.abs(c[i] - 2 * c[i - 1] + c[i - 2]))
      p += c[i] * c[i]
      n++
    }
  }
  return m / Math.sqrt(p / n + 1e-30)
}

const std = (a: number[]) => {
  const m = a.reduce((s, v) => s + v, 0) / a.length
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length)
}
const maxJump = (a: number[]) => a.slice(1).reduce((m, v, i) => Math.max(m, Math.abs(v - a[i])), 0)

let engine: AudioEngine | null = null
let engineBuf: AudioBuffer | null = null

/** アプリと同じ手順: 再生エンジンで解析 → 書き出しのスナップショット → 使い捨てフレームで描画（量子化前の浮動小数点） */
async function processLikeApp(buf: AudioBuffer, dsp: DspConfig): Promise<Float32Array[]> {
  if (!engine || engineBuf !== buf) {
    engine?.dispose()
    engine = new AudioEngine(1, { sampleRate: buf.sampleRate })
    engine.setBuffer(buf)
    engineBuf = buf
  }
  engine.applyDsp(dsp)
  const snap = await engine.exportSnapshot()
  engine.holdAnalysis(true)
  await engine.suspendForExport()
  try {
    const r = await startExport({ channels: chansOf(buf).map((c) => c.slice()), sampleRate: buf.sampleRate, ...snap, bitDepth: 16, ditherSeed: 1, returnFloat: true }, () => {}).promise
    return r.float!
  } finally {
    engine.holdAnalysis(false)
    await engine.resumeAfterExport()
  }
}

export async function runQualityReport(): Promise<TestResult[]> {
  const results: TestResult[] = []
  let group = ''
  const check = (name: string, pass: boolean, detail: string) => results.push({ group, name, pass, detail })
  const info = (name: string, detail: string) => results.push({ group, name, pass: true, detail, info: true })

  const programs: [string, AudioBuffer][] = [
    ['ステレオミックス相当', programStereoMix(12)],
    ['EDM 相当（低域が多い）', programEdm(12)],
    ['アコースティック相当', programAcoustic(12)],
  ]
  const TAIL_PAD = 4
  try {
    for (const [pname, prog] of programs) {
      const src = withSilence(prog, TAIL_PAD)
      const srcCh = chansOf(src)
      const end = prog.length
      const orig = stereoMetrics(chansOf(prog), RATE)
      const origSpec = thirdOctaveLevelsDb(averageSpectrum(chansOf(prog), RATE))
      const origLow = bandLevelDb(averageSpectrum(chansOf(prog), RATE), 20, 120)
      const origClick = clickIndex(srcCh, RATE, end)
      const origLevels = levelTrack(srcCh, 0, end, RATE / 20)
      group = `99. 音響品質（${pname} 12 秒 + 無音 ${TAIL_PAD} 秒、書き出しの経路、量子化前）`
      for (const preset of SPATIAL_PRESETS) {
        const out = await processLikeApp(src, presetToDsp(preset))
        const body = out.map((c) => c.subarray(0, end))
        const m: StereoMetrics = stereoMetrics(body, RATE)
        const lu = m.loudnessLufs - orig.loudnessLufs
        const sp = linearToDb(samplePeak(out))
        const tp = truePeakDb(out)
        let clipped = 0
        let nan = 0
        for (const c of out) for (const v of c) {
          if (!Number.isFinite(v)) nan++
          else if (Math.abs(v) >= 1) clipped++
        }
        const L = preset.label
        check(`${L}: サンプルピーク ≤ −1 dBFS・飽和 0・NaN なし`, sp <= -0.99 && clipped === 0 && nan === 0, `ピーク ${f2(sp)} dBFS、飽和 ${clipped}、NaN ${nan}`)
        check(`${L}: ラウドネス ±1 LU（原音にそろえる）`, Math.abs(lu) <= 1, `${f1(lu)} LU（原音 ${f1(orig.loudnessLufs)} LUFS → ${f1(m.loudnessLufs)} LUFS）`)
        check(`${L}: 位相相関 ≥ 0`, m.correlation >= 0, `全体 ${f2(m.correlation)}（原音 ${f2(orig.correlation)}）、低 ${f2(m.bandCorrelation.low)} / 中 ${f2(m.bandCorrelation.mid)} / 高 ${f2(m.bandCorrelation.high)}`)
        info(`${L}: True Peak（4 倍オーバーサンプリング）`, `${f2(tp)} dBTP（サンプルピーク ${f2(sp)} dBFS。リミッターはサンプルピークで制御するため、サンプル間のピークは天井を超えうる）`)
        const spec = thirdOctaveLevelsDb(averageSpectrum(body, RATE))
        const diff = spec.map((v, i) => v - origSpec[i])
        const idx = THIRD_OCTAVE_CENTERS.map((f, i) => [f, i] as const).filter(([f]) => f >= 63 && f <= 16000)
        const mean = idx.reduce((s, [, i]) => s + diff[i], 0) / idx.length
        const dev = idx.map(([f, i]) => [f, diff[i] - mean] as const)
        const worst = dev.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a))
        info(`${L}: 周波数特性（1/3 オクターブ、全体の差を除いた原音との差）`, `最大 ${f1(worst[1])} dB @ ${worst[0]} Hz、63 Hz ${f1(dev[0][1])} / 1 kHz ${f1(dev.find(([f]) => f === 1000)?.[1] ?? NaN)} / 8 kHz ${f1(dev.find(([f]) => f === 8000)?.[1] ?? NaN)} dB`)
        const low = bandLevelDb(averageSpectrum(body, RATE), 20, 120)
        info(`${L}: 低域（20〜120 Hz）の変化・過剰な増幅`, `${f1(low - origLow)} dB（全体のラウドネス差 ${f1(lu)} LU）`)
        info(
          `${L}: モノラル互換性・ステレオ幅`,
          `モノラル和のラウドネスの低下 原音 ${f1(orig.monoLoudnessLufs - orig.loudnessLufs)} → ${f1(m.monoLoudnessLufs - m.loudnessLufs)} LU、S/M 低 ${f1(orig.bandWidthDb.low)} → ${f1(m.bandWidthDb.low)} / 中 ${f1(orig.bandWidthDb.mid)} → ${f1(m.bandWidthDb.mid)} / 高 ${f1(orig.bandWidthDb.high)} → ${f1(m.bandWidthDb.high)} dB`,
        )
        // 動きの連続性: 50 ms ごとのレベルの最大の跳び（原音との差）・クリックの指標
        const levels = levelTrack(out, 0, end, RATE / 20)
        const ild = ildTrack(out, RATE, end, RATE / 10)
        info(`${L}: 動きの連続性（音量の急変・クリック）`, `50 ms ごとのレベルの最大の跳び ${f1(maxJump(levels))} dB（原音 ${f1(maxJump(origLevels))} dB）、2 階差分 / RMS ${f2(clickIndex(out, RATE, end))}（原音 ${f2(origClick)}）、0.1 秒ごとの ILD の幅 ${f1(Math.min(...ild))}〜${f1(Math.max(...ild))} dB・最大の跳び ${f1(maxJump(ild))} dB`)
        // 余韻: 音源の終わりからの減衰（100 ms ごとのレベル）
        const tail = levelTrack(out, end, out[0].length - RATE / 10, RATE / 10)
        const start = levelTrack(out, end - RATE / 2, end, RATE / 2)[0]
        const t60 = tail.findIndex((v) => v < start - 60)
        let bump = 0
        for (let i = 1; i < tail.length; i++) if (tail[i] > tail[i - 1]) bump = Math.max(bump, tail[i] - tail[i - 1])
        info(`${L}: 余韻の減衰（音源の終わりから）`, `−60 dB まで ${t60 >= 0 ? `${(t60 * 0.1).toFixed(1)} 秒` : `${TAIL_PAD} 秒以内に届かない`}、100 ms ごとの再上昇の最大 ${f1(bump)} dB、${TAIL_PAD} 秒後 ${f1(tail[tail.length - 1] - start)} dB`)
      }
    }

    // 中央の音（L = R の声）が中央に残るか
    group = '99. 音響品質: 中央の音の維持（L = R の声 10 秒）'
    const voice = centerVoice(10)
    for (const preset of SPATIAL_PRESETS) {
      const out = await processLikeApp(voice, presetToDsp(preset))
      const ild = ildTrack(out, RATE, voice.length, RATE / 10)
      const m = stereoMetrics(out.map((c) => c.subarray(0, voice.length)), RATE)
      const meanIld = ild.reduce((s, v) => s + v, 0) / ild.length
      info(`${preset.label}: 中央の声の左右差`, `ILD 平均 ${f1(meanIld)} dB・揺れ（標準偏差）${f2(std(ild))} dB・最大 ${f1(Math.max(...ild.map(Math.abs)))} dB、位相相関 ${f2(m.correlation)}（原音 1.00）`)
    }
  } finally {
    engine?.dispose()
    engine = null
    engineBuf = null
  }
  return results
}
