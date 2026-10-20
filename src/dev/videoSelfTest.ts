// Phase 07（動画: 読み込み・音声の抽出・立体音響化・音声の差し替え・同期）の自己診断。
// ?suite=video&groups=80-83 のように分けて実行する（npm run test:video が順に実行）。
// 試験用の動画は、この場で WebCodecs でエンコードして作る（videoFixtures.ts: 黒の映像に白いフラッシュ、同じ時刻に音声のクリック）。
// 実際のカメラ・編集ソフトで作った動画では確認していない。

import { canEncodeAudio, canEncodeVideo } from 'mediabunny'
import { AudioEngine } from '../audio/AudioEngine'
import { exportMemoryBudget } from '../audio/export/exportSpec'
import { exportFrameCount, ExportTimeoutError, RETAINED_RELEASE_IDLE_MS, startExport } from '../audio/export/exportRunner'
import { loadAudioFile } from '../audio/loadAudioFile'
import { presetToDsp, SPATIAL_PRESETS } from '../audio/presets/spatialPresets'
import { distanceDelaySeconds } from '../audio/spatial/motion'
import { motionLayout } from '../audio/spatial/spatialSpec'
import type { DspConfig } from '../audio/dspConfig'
import type { LoadedAudio } from '../types/audio'
import { startVideoExport, type VideoExportResult } from '../video/videoExport'
import { estimateVideoExportBytes, VideoCancelledError, VideoTimeoutError, type VideoTailMode } from '../video/videoSpec'
import type { TestResult } from './dspSelfTest'
import { makeFixtureVideo, type FixtureOptions } from './videoFixtures'
import { measureMarks, type MarkTimes } from './videoMeasure'

const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : String(v))
const ms = (s: number) => `${(s * 1000).toFixed(2)} ms`
const sleep = (t: number) => new Promise((r) => setTimeout(r, t))
const gc = () => (globalThis as { gc?: () => void }).gc?.()
const dspOf = (i: number) => presetToDsp(SPATIAL_PRESETS[i])

function groupRange(): [number, number] {
  const m = /(?:^|[?&])groups=(\d+)-(\d+)/.exec(typeof location === 'undefined' ? '' : location.search)
  return m ? [Number(m[1]), Number(m[2])] : [0, Infinity]
}

async function fixtureFile(o: FixtureOptions, name: string): Promise<{ file: File; marks: number[] }> {
  const { blob, marks } = await makeFixtureVideo(o)
  return { file: new File([blob], name, { type: blob.type }), marks }
}

/** アプリと同じ読み込み（音声ファイルは decodeAudioData、動画は mediabunny） */
async function load(file: File): Promise<Awaited<ReturnType<typeof loadAudioFile>>> {
  return loadAudioFile(file, async (data) => new OfflineAudioContext(2, 1, 48000).decodeAudioData(data))
}

let engine: AudioEngine | null = null
function releaseEngine() {
  engine?.dispose()
  engine = null
}

/** アプリと同じ手順: 再生エンジンで解析 → 処理計画 → 再生側を止めて動画を書き出す */
type VideoExportOpts = Parameters<typeof startVideoExport>[4]
async function exportVideo(
  audio: LoadedAudio,
  dsp: DspConfig,
  tailMode: VideoTailMode,
  onProgress: VideoExportOpts['onProgress'] = () => {},
  extra: Partial<Pick<VideoExportOpts, 'watchdog' | 'muxStallMs' | 'debugMuxStallAfterPackets' | 'debugStall'>> = {},
) {
  if (!engine) engine = new AudioEngine(0)
  // アプリと同じく、同じ音源なら読み込み直さない（読み込み直すと解析をやり直し、解析用の文脈が残る）
  if (engine.getBuffer() !== audio.buffer) engine.setBuffer(audio.buffer)
  engine.applyDsp(dsp)
  const snap = await engine.exportSnapshot()
  await engine.suspendForExport()
  const channels = Array.from({ length: audio.buffer.numberOfChannels }, (_, c) => audio.buffer.getChannelData(c))
  const inner = startVideoExport(audio.file, audio.video!.info, { channels, sampleRate: audio.buffer.sampleRate, startTime: audio.video!.audioStart }, snap, {
    tailMode,
    aacAvailable: await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: audio.buffer.sampleRate }),
    onProgress,
    ...extra,
  })
  // アプリと同じく、終わったら（失敗・キャンセルでも）再生側の AudioContext を再開する
  const e = engine
  const job = { promise: inner.promise.finally(() => e.resumeAfterExport()), cancel: inner.cancel }
  return { job, snap }
}

/** 同期の誤差: (出力のクリック − 出力のフラッシュ) − (入力のクリック − 入力のフラッシュ)、マークごと */
function syncErrors(input: MarkTimes, output: MarkTimes): number[] {
  const n = Math.min(input.flashes.length, input.clicks.length, output.flashes.length, output.clicks.length)
  return Array.from({ length: n }, (_, i) => output.clicks[i] - output.flashes[i] - (input.clicks[i] - input.flashes[i]))
}

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

export async function runVideoSelfTest(): Promise<TestResult[]> {
  const [g0, g1] = groupRange()
  const want = (n: number) => n >= g0 && n <= g1
  // 診断（グループ 98）は合否を判定しない測定。通常の test:video（グループ 80〜90）には含めず、groups=98-98 を指定したときだけ実行する
  // （npm run test:video:diagnostic）
  const wantDiagnostic = (n: number) => g0 === n && g1 === n
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

  // 4 種のコンテナの試験用動画
  const containers: { label: string; o: FixtureOptions; name: string }[] = [
    { label: 'MP4（H.264 + AAC）', o: { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', seconds: 6 }, name: 'test.mp4' },
    { label: 'WebM（VP9 + Opus）', o: { container: 'webm', videoCodec: 'vp9', audioCodec: 'opus', seconds: 6 }, name: 'test.webm' },
    { label: 'MKV（H.264 + Opus）', o: { container: 'mkv', videoCodec: 'avc', audioCodec: 'opus', seconds: 6 }, name: 'test.mkv' },
    { label: 'MP4（音声が 0.5 秒後に始まる）', o: { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', seconds: 6, audioStart: 0.5 }, name: 'offset.mp4' },
    { label: 'MOV（H.264 + AAC）', o: { container: 'mov', videoCodec: 'avc', audioCodec: 'aac', seconds: 6 }, name: 'test.mov' },
  ]

  group = '80. 実行環境（WebCodecs のエンコーダー・デコーダー）'
  if (want(80)) {
    const enc: string[] = []
    for (const c of ['aac', 'opus'] as const) enc.push(`${c} ${(await canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000 })) ? '○' : '×'}`)
    for (const c of ['avc', 'vp8', 'vp9', 'av1', 'hevc'] as const) enc.push(`${c} ${(await canEncodeVideo(c, { width: 320, height: 240 })) ? '○' : '×'}`)
    info('エンコードできるコーデック（試験用の動画の作成・出力の音声）', enc.join(' / '))
    check('出力の音声に使う AAC（MP4 / MOV）と Opus（WebM / MKV）をエンコードできる', (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000 })) && (await canEncodeAudio('opus', { numberOfChannels: 2, sampleRate: 48000 })), enc.slice(0, 2).join(' / '))
    check('WebCodecs が使える（AudioDecoder / VideoDecoder / AudioEncoder）', typeof AudioDecoder === 'function' && typeof VideoDecoder === 'function' && typeof AudioEncoder === 'function', '')
  }

  group = '81. 読み込み（コンテナ・コーデックの判定、音声の抽出）'
  if (want(81)) {
    for (const c of containers) {
      const { file, marks } = await fixtureFile(c.o, c.name)
      const r = await load(file)
      if (!r.ok) {
        check(`${c.label}: 読み込める`, false, `${r.error.kind}: ${r.error.message} ${r.error.detail ?? ''}`)
        continue
      }
      const v = r.audio.video!
      const t = v.info.audioTracks[0]
      check(
        `${c.label}: コンテナ・映像（コーデック・320×240・30 fps・6 秒）・音声（48 kHz・2ch・開始 ${c.o.audioStart ?? 0} 秒）を判定`,
        v.info.container === c.o.container && v.info.video.codec === c.o.videoCodec && v.info.video.width === 320 && v.info.video.height === 240 && Math.abs((v.info.video.fps ?? 0) - 30) < 0.5 &&
          Math.abs(v.info.duration - 6) < 0.05 && t.codec === c.o.audioCodec && t.sampleRate === 48000 && t.channels === 2 && Math.abs(v.audioStart - (c.o.audioStart ?? 0)) < 0.001,
        `${v.info.container}・${v.info.video.codec} ${v.info.video.width}×${v.info.video.height} ${f2(v.info.video.fps ?? NaN)} fps・${f2(v.info.duration)} 秒・音声 ${t.codec} ${t.sampleRate} Hz ${t.channels}ch 開始 ${v.audioStart.toFixed(4)} 秒`,
      )
      // 抽出した音声のクリックの位置（音声の開始時刻を足すと、映像の時刻と一致する）
      const x = r.audio.buffer.getChannelData(0)
      const sr = r.audio.buffer.sampleRate
      const errs = marks.map((m) => {
        const from = Math.round((m - v.audioStart - 0.05) * sr)
        let k = Math.max(0, from)
        while (k < x.length && Math.abs(x[k]) < 0.1) k++
        return v.audioStart + k / sr - m
      })
      check(`${c.label}: 抽出した音声のクリックが映像の時刻と一致（±1 ms、音声の開始時刻を含めて）`, errs.every((e) => Math.abs(e) <= 0.001), errs.map(ms).join(' / '))
    }
    // 音声ファイルとして読む: 映像のない WebM（音声だけ）は従来の音声の経路
    const { blob } = await makeFixtureVideo({ container: 'webm', videoCodec: 'vp9', audioCodec: 'opus', seconds: 2 })
    void blob
  }

  group = '82. 非対応・音声なし・壊れたファイル'
  if (want(82)) {
    const noAudio = await fixtureFile({ container: 'mp4', videoCodec: 'avc', audioCodec: null, seconds: 2 }, 'noaudio.mp4')
    const r1 = await load(noAudio.file)
    check('音声トラックのない動画 → 「音声トラックがありません」のエラー（no-audio）', !r1.ok && r1.error.kind === 'no-audio', r1.ok ? '読み込めてしまった' : `${r1.error.kind}: ${r1.error.message}`)
    const junk = new File([new Uint8Array(4096).map((_, i) => (i * 37) & 0xff)], 'junk.mp4', { type: 'video/mp4' })
    const r2 = await load(junk)
    check('中身が動画でない .mp4 → エラー（読み込めない旨）', !r2.ok, r2.ok ? '読み込めてしまった' : `${r2.error.kind}: ${r2.error.message}`)
    const avi = new Uint8Array(64)
    avi.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20], 0)
    const r3 = await load(new File([avi], 'clip.mp4'))
    check('AVI（RIFF AVI）の中身で拡張子 .mp4 → エラー（拡張子では判断しない）', !r3.ok, r3.ok ? '読み込めてしまった' : `${r3.error.kind}: ${r3.error.message}`)
    const r4 = await load(new File([new Uint8Array(10)], 'clip.avi'))
    check('対応しない拡張子（.avi）→ 非対応のエラー', !r4.ok && r4.error.kind === 'unsupported', r4.ok ? '' : r4.error.message)
    const full = await fixtureFile({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', seconds: 3 }, 'cut.mp4')
    const cut = new File([await full.file.slice(0, Math.floor(full.file.size * 0.4)).arrayBuffer()], 'cut.mp4')
    const r5 = await load(cut)
    // 合否は判定しない（例外で止まらずに結果が返ることだけを記録。読める範囲を読むかエラーかはファイル次第）
    info('途中で切れた MP4（先頭 40%）', r5.ok ? `読める範囲を読んだ（音声 ${f2(r5.audio.buffer.duration)} 秒）` : `エラー表示 ${r5.error.kind}: ${r5.error.message}`)
  }

  group = '83. 音声の WAV（元の音声 / 立体音響化）'
  if (want(83)) {
    const { file } = await fixtureFile(containers[0].o, 'wav.mp4')
    const r = await load(file)
    if (!r.ok) check('読み込み', false, r.error.message)
    else {
      // 元の音声: 処理なしでそのまま
      const { encodeWav } = await import('../audio/export/wavEncoder')
      const chs = [r.audio.buffer.getChannelData(0), r.audio.buffer.getChannelData(1)]
      const wav = encodeWav(chs, { sampleRate: 48000, bitDepth: 16, seed: 1 }).blob
      const dec = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(await wav.arrayBuffer())
      let err = 0
      for (let i = 0; i < dec.length; i += 7) err = Math.max(err, Math.abs(dec.getChannelData(0)[i] - chs[0][i]))
      check('ORIGINAL AUDIO: 抽出した音声そのもの（WAV をデコードして誤差 ≤ 2 LSB）', dec.length === chs[0].length && err <= 2 / 32767, `${dec.length} フレーム、誤差 ${err.toExponential(1)}`)
      // 立体音響化: Phase 06 の書き出しと同じ経路（余韻を含む）
      if (!engine) engine = new AudioEngine(0)
      engine.setBuffer(r.audio.buffer)
      engine.applyDsp(dspOf(1))
      const snap = await engine.exportSnapshot()
      await engine.suspendForExport()
      const res = await startExport({ channels: chs.map((c) => c.slice()), sampleRate: 48000, ...snap, bitDepth: 16, ditherSeed: 1 }, () => {}).promise
      check('SPATIAL AUDIO（LIVE ARENA）: WAV = 音声 + 余韻（Phase 06 の書き出し）', res.sourceSeconds > 5.9 && res.tailSeconds > 1 && res.blob.size === 44 + res.frames * 4 && res.peakDb <= -0.99, `音声 ${f2(res.sourceSeconds)} 秒 + 余韻 ${f2(res.tailSeconds)} 秒、${(res.blob.size / 2 ** 20).toFixed(1)} MB、ピーク ${f2(res.peakDb)} dBFS`)
    }
  }

  group = '84. 動画への音声の差し替え（映像のストリームコピー・プリセット・CUSTOM）'
  if (want(84)) {
    const cases: [string, number, DspConfig][] = [
      ['MP4 × LIVE ARENA', 0, dspOf(1)],
      ['WebM × CINEMA 3D', 1, dspOf(0)],
      ['MKV × 360° MOTION', 2, dspOf(2)],
      ['MP4 × CUSTOM（IMMERSIVE X・DEPTH 30・TAIL LENGTH 20）', 0, { ...dspOf(3), spatial: { ...dspOf(3).spatial, depth: 30, tailLength: 20 } }],
    ]
    for (const [label, ci, dsp] of cases) {
      const c = containers[ci]
      const { file } = await fixtureFile(c.o, c.name)
      const r = await load(file)
      if (!r.ok) {
        check(`${label}: 読み込み`, false, r.error.message)
        continue
      }
      const { job, snap } = await exportVideo(r.audio, dsp, 'trim')
      let res: VideoExportResult
      try {
        res = await job.promise
      } catch (e) {
        check(`${label}: 書き出せる`, false, e instanceof Error ? e.message : String(e))
        continue
      }
      const inp = await measureMarks(file, { decodeVideo: false })
      const out = await measureMarks(res.blob, { decodeVideo: false })
      const endOf = (m: typeof inp) => (m.videoStart ?? 0) + (m.videoDuration ?? 0)
      const same =
        inp.videoPackets.length === out.videoPackets.length &&
        Math.abs(endOf(inp) - endOf(out)) < 1e-6 &&
        inp.videoPackets.every((p, i) => {
          const q = out.videoPackets[i]
          return Math.abs(p.timestamp - q.timestamp) < 1e-6 && Math.abs(p.duration - q.duration) < 1e-6 && p.hash === q.hash && p.key === q.key
        })
      const diff = { ts: 0, dur: 0, hash: 0, key: 0 }
      let firstDur = ''
      inp.videoPackets.forEach((p, i) => {
        const q = out.videoPackets[i]
        if (!q) return
        if (Math.abs(p.timestamp - q.timestamp) >= 1e-6) diff.ts++
        if (Math.abs(p.duration - q.duration) >= 1e-6) {
          diff.dur++
          if (!firstDur) firstDur = `#${i} ${p.duration.toFixed(6)}→${q.duration.toFixed(6)}`
        }
        if (p.hash !== q.hash) diff.hash++
        if (p.key !== q.key) diff.key++
      })
      check(
        `${label}: 映像のパケット（${inp.videoPackets.length} 個）がタイムスタンプ・長さ・キーフレーム・中身・映像の終わりの時刻とも入力と同じ（再エンコードなし）`,
        same,
        `${out.videoPackets.length} 個、${(res.blob.size / 1024).toFixed(0)} KB、音声 ${res.audioCodec}。不一致: 時刻 ${diff.ts}・長さ ${diff.dur}${firstDur ? `（${firstDur}）` : ''}・中身 ${diff.hash}・キー ${diff.key}。映像の終わり ${endOf(out).toFixed(4)} 秒（入力 ${endOf(inp).toFixed(4)} 秒）、最後のパケットの長さ ${out.videoPackets[out.videoPackets.length - 1]?.duration.toFixed(4)}（入力 ${inp.videoPackets[inp.videoPackets.length - 1]?.duration.toFixed(4)}）`,
      )
      check(`${label}: 書き出しの設定 = 選択中の設定・音声の開始時刻 = 入力の音声の開始時刻`, JSON.stringify(snap.dsp) === JSON.stringify(dsp) && Math.abs((out.audioStart ?? -1) - (inp.audioStart ?? 0)) < 0.001, `設定 ${snap.dsp.spatial.mode}/${snap.dsp.spatial.tailMode}・音声の開始 ${out.audioStart?.toFixed(4)} 秒（入力 ${inp.audioStart?.toFixed(4)} 秒）`)
      info(`${label}: 処理時間`, `音声のレンダリング ${(res.renderMs / 1000).toFixed(2)} 秒・動画の書き込み ${(res.muxMs / 1000).toFixed(2)} 秒`)
    }
  }

  group = '85. 音声・映像の同期（フラッシュとクリックの時刻差の変化）'
  if (want(85)) {
    const cases: [string, number, DspConfig, number][] = [
      ['MP4 × LIVE ARENA（Motion なし）', 0, dspOf(1), 0],
      ['WebM × LIVE ARENA', 1, dspOf(1), 0],
      ['MKV × LIVE ARENA', 2, dspOf(1), 0],
      ['MP4（音声 0.5 秒遅れで開始）× LIVE ARENA', 3, dspOf(1), 0],
      ['MP4 × IMMERSIVE X（Motion: CENTER は距離の伝搬遅延だけ遅れる）', 0, dspOf(3), distanceDelaySeconds(motionLayout(dspOf(3).spatial).baseDistance)],
      ['WebM × CINEMA 3D（Motion）', 1, dspOf(0), distanceDelaySeconds(motionLayout(dspOf(0).spatial).baseDistance)],
    ]
    for (const [label, ci, dsp, expected] of cases) {
      const c = containers[ci]
      const { file } = await fixtureFile(c.o, c.name)
      const r = await load(file)
      if (!r.ok) {
        check(`${label}: 読み込み`, false, r.error.message)
        continue
      }
      const { job } = await exportVideo(r.audio, dsp, 'trim')
      const res = await job.promise
      const inp = await measureMarks(file)
      const out = await measureMarks(res.blob)
      const errs = syncErrors(inp, out)
      check(
        `${label}: 同期の誤差（クリック − フラッシュの変化 − 意図した遅れ ${ms(expected)}）≤ ±1 ms、3 か所とも`,
        errs.length === 3 && errs.every((e) => Math.abs(e - expected) <= 0.001),
        `誤差 ${errs.map(ms).join(' / ')}、フラッシュ ${out.flashes.map((t) => t.toFixed(4)).join(',')}（入力 ${inp.flashes.map((t) => t.toFixed(4)).join(',')}）、クリック ${out.clicks.map((t) => t.toFixed(4)).join(',')}`,
      )
    }
  }

  group = '86. 動画の終わりの余韻（映像の長さを保つ / 最後のフレームを延ばす）'
  if (want(86)) {
    // 最後のクリックを映像の終わりの 0.3 秒前に置き、余韻が映像の終わりを越えるようにする
    for (const o of [
      // 最後のフレーム（119 / 30 秒）を白にして、延ばした後に表示され続けるかを見る
      { container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', seconds: 4, marks: [1, 3.7, 119 / 30] },
      { container: 'webm', videoCodec: 'vp9', audioCodec: 'opus', seconds: 4, marks: [1, 3.7, 119 / 30] },
    ] as FixtureOptions[]) {
    const { file } = await fixtureFile(o, 'tail.' + o.container)
    const r = await load(file)
    const tag = o.container.toUpperCase()
    if (!r.ok) check('読み込み', false, r.error.message)
    else {
      for (const mode of ['trim', 'extend'] as VideoTailMode[]) {
        const { job } = await exportVideo(r.audio, dspOf(1), mode)
        const res = await job.promise
        const inp = await measureMarks(file, { decodeVideo: false })
        const out = await measureMarks(res.blob, { decodeVideo: false })
        const inEnd = (inp.videoStart ?? 0) + (inp.videoDuration ?? 0)
        const outVideoEnd = out.videoDuration ?? 0
        const outAudioEnd = out.audioDuration ?? 0
        const sameUntilLast = inp.videoPackets.slice(0, -1).every((p, i) => p.hash === out.videoPackets[i].hash && Math.abs(p.timestamp - out.videoPackets[i].timestamp) < 1e-6)
        if (mode === 'trim') {
          check(
            `${tag} 映像の長さを保つ: 映像の長さ・パケットは入力と同じ、音声は映像の終わり（+ エンコーダーの 1 フレーム以内）まで、余韻の残りは切ってフェード`,
            Math.abs(outVideoEnd - inEnd) < 1e-6 && sameUntilLast && outAudioEnd <= inEnd + 1024 / 48000 + 1e-6 && res.trimmedTailSeconds > 1,
            `映像 ${f2(outVideoEnd)} 秒（入力 ${f2(inEnd)} 秒）・音声 ${outAudioEnd.toFixed(3)} 秒・切った余韻 ${f2(res.trimmedTailSeconds)} 秒`,
          )
        } else {
          const last = out.videoPackets[out.videoPackets.length - 1]
          // 再生したときの見え方（Chrome の <video>）: 長さが余韻の終わりまで延び、最後のフレームが表示され続ける
          const url = URL.createObjectURL(res.blob)
          const v = document.createElement('video')
          v.muted = true
          v.src = url
          await new Promise((done) => {
            v.onloadeddata = done
            setTimeout(done, 5000)
          })
          const brightAt = async (t: number) => {
            v.currentTime = t
            await new Promise((done) => {
              v.onseeked = done
              setTimeout(done, 3000)
            })
            const cv = new OffscreenCanvas(16, 16)
            const g = cv.getContext('2d')!
            g.drawImage(v, 0, 0, 16, 16)
            return g.getImageData(8, 12, 1, 1).data[0]
          }
          const held = [await brightAt(5), await brightAt(v.duration - 0.05)]
          const playerDur = v.duration
          v.src = ''
          URL.revokeObjectURL(url)
          check(
            `${tag} 最後のフレームを延ばす: 映像のパケットは最後まで同じ中身、再生（<video>）の長さ = 余韻の終わり（±0.05 秒）、延ばした区間も最後のフレーム（白）を表示`,
            sameUntilLast && last.hash === inp.videoPackets[inp.videoPackets.length - 1].hash && res.extendedSeconds > 1 && Math.abs(playerDur - outAudioEnd) <= 0.05 && held.every((b) => b > 200),
            `再生の長さ ${playerDur.toFixed(3)} 秒・音声 ${outAudioEnd.toFixed(3)} 秒（最後のフレーム +${f2(res.extendedSeconds)} 秒）、5 秒と終わりの明るさ ${held.join(' / ')}`,
          )
          if (o.container === 'mp4') {
            check(`${tag}: 最後のパケットの長さ（コンテナに記録）= 余韻の終わりまで`, Math.abs(outVideoEnd - outAudioEnd) < 0.03, `映像トラックの終わり ${f2(outVideoEnd)} 秒・音声 ${outAudioEnd.toFixed(3)} 秒`)
          } else {
            // Matroska の SimpleBlock はフレームごとの長さを持たないため、延長はファイル全体の長さ（Segment Duration）で表す
            info(`${tag}: 最後のパケットの長さ（コンテナ）`, `映像トラックの終わり ${f2(outVideoEnd)} 秒（Matroska はフレームごとの長さを記録しないため、延長はファイル全体の長さで表す。Chrome 以外のプレイヤーは未確認）`)
          }
        }
      }
    }
  }

  }

  group = '87. キャンセル（レンダリング中・動画の書き込み中）'
  if (want(87)) {
    const { file } = await fixtureFile({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', seconds: 20 }, 'cancel.mp4')
    const r = await load(file)
    if (!r.ok) check('読み込み', false, r.error.message)
    else {
      for (const at of ['rendering', 'muxing'] as const) {
        let fired = false
        const box: { cancel?: () => void } = {}
        const { job } = await exportVideo(r.audio, dspOf(3), 'trim', (p) => {
          if (!fired && p.stage === at && (p.fraction ?? 0) > 0.05) {
            fired = true
            box.cancel?.()
          }
        })
        box.cancel = job.cancel
        let cancelled = false
        let result: unknown = null
        try {
          result = await job.promise
        } catch (e) {
          cancelled = e instanceof VideoCancelledError
        }
        check(`${at === 'rendering' ? 'レンダリング' : '動画の書き込み'}中にキャンセル → 結果なし（VideoCancelledError）・フレームが残らない`, fired && cancelled && result === null && exportFrameCount() === 0, `キャンセル ${fired ? '実行' : '未実行'}、${cancelled ? 'キャンセル済み' : '完了してしまった'}、フレーム ${exportFrameCount()}`)
      }
      const { job } = await exportVideo(r.audio, dspOf(1), 'trim')
      const res = await job.promise
      check('キャンセル後の書き出しは正常に完了', res.blob.size > 1000, `${(res.blob.size / 1024).toFixed(0)} KB`)
    }
  }

  group = '88. 大きな動画・メモリ'
  if (want(88)) {
    // 3 分（640×360・30 fps）の動画: 処理時間とメモリ
    const longSeconds = Number(new URLSearchParams(location.search).get('seconds') ?? 180)
    const { file } = await fixtureFile({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', seconds: longSeconds, width: 640, height: 360, marks: [10, longSeconds / 2, longSeconds - 10], tone: 0.05 }, 'long.mp4')
    const t0 = performance.now()
    const r = await load(file)
    const loadMs = performance.now() - t0
    if (!r.ok) check('読み込み', false, r.error.message)
    else {
      const est = estimateVideoExportBytes(r.audio.video!.info, { frames: r.audio.buffer.length, channels: 2, sampleRate: 48000 }, dspOf(3).spatial)
      const m0 = await settledMemoryMb()
      const times: string[] = []
      const mem: (number | null)[] = []
      const rounds = Number(new URLSearchParams(location.search).get('rounds') ?? 2)
      for (let k = 0; k < rounds; k++) {
        const t1 = performance.now()
        const { job } = await exportVideo(r.audio, dspOf(3), 'trim')
        const res = await job.promise
        times.push(`${((performance.now() - t1) / 1000).toFixed(1)} 秒（音声 ${(res.renderMs / 1000).toFixed(1)} + 書き込み ${(res.muxMs / 1000).toFixed(1)}）・${(res.blob.size / 2 ** 20).toFixed(1)} MB`)
        const url = URL.createObjectURL(res.blob)
        URL.revokeObjectURL(url)
        mem.push(await settledMemoryMb())
      }
      check('3 分の動画（640×360、入力 ' + (file.size / 2 ** 20).toFixed(1) + ' MB）を 2 回書き出せる', true, `読み込み（音声の抽出）${(loadMs / 1000).toFixed(1)} 秒、書き出し ${times.join(' / ')}`)
      if (m0 === null || mem.some((m) => m === null)) check('メモリ: 2 回目の書き出しで増え続けない（≤ 30 MB）', false, '未実行: ブラウザのメモリを測れない環境')
      else check('メモリ: 2 回目の書き出しで増え続けない（1 回目の後との差 ≤ 30 MB）', mem[1]! - mem[0]! <= 30, `開始 ${m0.toFixed(0)} MB → ${mem.map((v) => v!.toFixed(0)).join(' → ')} MB、見積もり ${(est / 2 ** 20).toFixed(0)} MB`)
      // 原因の調査（Phase 07 で測定）: ページ内に AudioWorklet を読み込んだ OfflineAudioContext（再生エンジンの解析）があると、
      // 書き出し 1 回ごとにレンダリングの出力 1 本分（3 分で 約 68 MB）が、iframe を消した後もしばらく残る（リークではない）。
      // 書き出しのない時間が続くと戻る。上の判定（基準 ≤ 30 MB）はこの一時的な保持を含むので FAIL になる（基準は変えない）
      if (m0 !== null && mem.every((m) => m !== null)) {
        await sleep(RETAINED_RELEASE_IDLE_MS)
        const idle = await settledMemoryMb()
        info(
          `参考: 書き出しのない時間が ${RETAINED_RELEASE_IDLE_MS / 1000} 秒続いた後`,
          idle === null ? '測定不可' : `${idle.toFixed(0)} MB（2 回目の後 ${mem[mem.length - 1]!.toFixed(0)} MB から ${(idle - mem[mem.length - 1]!).toFixed(0)} MB、開始 ${m0.toFixed(0)} MB との差 ${(idle - m0).toFixed(0)} MB）`,
        )
      }
      info('原因（調査結果）', 'ページ内のワークレットつき OfflineAudioContext（解析）があるとき、書き出し 1 回ごとにレンダリングの出力 1 本分がしばらく残る（書き出しのない時間が続くと戻る）。次の書き出しのメモリの判定に足して上限を超えないようにしている')
    }
    // 上限: 1 GiB を超える動画は読み込み前に止める・メモリの見積もりが上限を超える動画は書き出し前に止める
    const fake = { fileName: 'big.mp4', fileSizeBytes: 900 * 2 ** 20, container: 'mp4', formatName: 'MP4', mimeType: 'video/mp4', duration: 1800, video: { codec: 'avc', codecString: null, width: 1920, height: 1080, rotation: 0, fps: 30, startTime: 0, duration: 1800, canDecode: true }, audioTracks: [], primaryAudioId: 1 } as const
    const est = estimateVideoExportBytes(fake as never, { frames: 1800 * 48000, channels: 2, sampleRate: 48000 }, dspOf(3).spatial)
    check('900 MB・30 分の動画は、メモリの見積もりが上限を超えるので書き出し前に止める', est > exportMemoryBudget(8), `見積もり ${(est / 2 ** 30).toFixed(1)} GiB > 上限 ${(exportMemoryBudget(8) / 2 ** 30).toFixed(1)} GiB`)
    const big = new File([new Uint8Array(1)], 'big.mp4')
    Object.defineProperty(big, 'size', { value: 1.5 * 2 ** 30 })
    const rb = await load(big)
    check('1 GiB を超える動画ファイルは読み込み前に止める（サイズのエラー）', !rb.ok && rb.error.kind === 'too-large', rb.ok ? '読めてしまった' : rb.error.message)
  }

  group = '89. プレビュー・ダウンロード'
  if (want(89)) {
    const { file } = await fixtureFile(containers[0].o, 'preview.mp4')
    const r = await load(file)
    if (!r.ok) check('読み込み', false, r.error.message)
    else {
      const { job } = await exportVideo(r.audio, dspOf(0), 'trim')
      const res = await job.promise
      const url = URL.createObjectURL(res.blob)
      const v = document.createElement('video')
      v.preload = 'auto'
      v.muted = true
      v.src = url
      const ok = await new Promise<boolean>((resolve) => {
        v.oncanplay = () => resolve(true)
        v.onerror = () => resolve(false)
        setTimeout(() => resolve(false), 15000)
      })
      check('<video> で書き出した動画（Object URL）を読み込める・長さ・解像度が入力と同じ（再生用の DSP は通らない）', ok && Math.abs(v.duration - 6) < 0.1 && v.videoWidth === 320 && v.videoHeight === 240, `読み込み ${ok}、${f2(v.duration)} 秒、${v.videoWidth}×${v.videoHeight}`)
      const a = document.createElement('a')
      a.href = url
      a.download = 'out.mp4'
      check('ダウンロード用のリンク（blob: URL・download 属性）', a.href.startsWith('blob:') && a.download === 'out.mp4', res.blob.type)
      v.src = ''
      URL.revokeObjectURL(url)
    }
  }

  group = '90. 監視・打ち切り・復旧（Phase 07 の安定化）'
  if (want(90)) {
    const { file } = await fixtureFile(containers[0].o, 'watch.mp4')
    const r = await load(file)
    if (!r.ok) check('読み込み', false, r.error.message)
    else {
      const attempt = async (extra: Parameters<typeof exportVideo>[4]) => {
        const t = performance.now()
        const { job } = await exportVideo(r.audio, dspOf(1), 'trim', () => {}, extra)
        try {
          return { res: await job.promise, err: null as unknown, ms: performance.now() - t }
        } catch (e) {
          return { res: null, err: e, ms: performance.now() - t }
        }
      }
      // 動画の書き込み（映像のパケット 30 個の後）で止まる → VideoTimeoutError、出力なし
      const a = await attempt({ debugMuxStallAfterPackets: 30, muxStallMs: 1500 })
      check(
        '動画の書き込みで進捗が途絶える → VideoTimeoutError（MUXING）・結果なし・フレームなし（LIVE ARENA、Motion なし）',
        a.res === null && a.err instanceof VideoTimeoutError && exportFrameCount() === 0,
        `${a.err instanceof Error ? `${a.err.name}: ${a.err.message}` : '完了してしまった'}、${(a.ms / 1000).toFixed(1)} 秒`,
      )
      // 音声のレンダリングの準備で毎回止まる → ExportTimeoutError（自動のやり直しは 1 回まで）
      const b = await attempt({ debugStall: { stage: 'context' }, watchdog: { prepareStallMs: 1500, prepareRetries: 1 } })
      check(
        '動画の音声の準備で毎回止まる → ExportTimeoutError（準備、2 回で打ち切り）・結果なし・フレームなし',
        b.res === null && b.err instanceof ExportTimeoutError && b.err.stage === 'preparing' && b.err.attempts === 2 && exportFrameCount() === 0,
        `${b.err instanceof Error ? `${b.err.name}: ${b.err.message}` : '完了してしまった'}、${(b.ms / 1000).toFixed(1)} 秒`,
      )
      // 打ち切りの後に、もう一度正常に書き出せる（映像のパケットは入力と同じ数・同期）
      const c = await attempt({})
      const out = c.res ? await measureMarks(c.res.blob) : null
      const inp = await measureMarks(file)
      const errs = out ? syncErrors(inp, out) : []
      check(
        '打ち切りの後の動画の書き出しは正常に完了（映像のパケット 180 個・同期の誤差 ±1 ms）',
        !!c.res && c.res.videoPackets === 180 && errs.length === 3 && errs.every((e) => Math.abs(e) <= 0.001),
        c.res ? `${c.res.videoPackets} 個、${(c.res.blob.size / 1024).toFixed(0)} KB、誤差 ${errs.map(ms).join(' / ')}` : String(c.err),
      )
    }
  }

  group = '98. 診断（メモリの内訳。合否なし・通常の test:video に含めない）'
  if (wantDiagnostic(98)) {
    const q = new URLSearchParams(location.search)
    const seconds = Number(q.get('s') ?? 180)
    const rounds = Number(q.get('rounds') ?? 4)
    const mode = q.get('mode') ?? 'export'
    type Detail = Record<string, { ws: number; priv: number; n: number }>
    const w = window as unknown as { csxMemDetail?: (id: string) => void; csxPressure?: (id: string) => void; __csxMem?: Record<string, unknown> }
    const ask = async (fn: ((id: string) => void) | undefined): Promise<unknown> => {
      if (!fn) return null
      const id = String(Math.random())
      fn(id)
      for (let i = 0; i < 300; i++) {
        await sleep(100)
        if (w.__csxMem && id in w.__csxMem) return w.__csxMem[id]
      }
      return null
    }
    const heap = () => ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 2 ** 20
    const sample = async (label: string, pressure: boolean) => {
      await sleep(1000)
      gc()
      if (pressure) {
        await ask(w.csxPressure)
        await sleep(3000)
        gc()
      }
      await sleep(2000)
      const d = (await ask(w.csxMemDetail)) as Detail | null
      if (!d) return info(label, '測定不可')
      const tot = Object.values(d).reduce((a, e) => ({ ws: a.ws + e.ws, priv: a.priv + e.priv }), { ws: 0, priv: 0 })
      const parts = Object.entries(d)
        .sort((a, b) => b[1].priv - a[1].priv)
        .map(([k, e]) => `${k.replace(/\.mojom\.\w+/, '')} ${e.ws}/${e.priv}`)
        .join('、')
      info(`${label}${pressure ? '（メモリ不足の通知の後）' : ''}`, `合計 WS ${tot.ws} / private ${tot.priv} MB、JS ヒープ ${heap().toFixed(0)} MB｜${parts}`)
    }
    const { file } = await fixtureFile({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', seconds, width: 640, height: 360, marks: [10], tone: 0.05 }, 'diag.mp4')
    const r = await load(file)
    if (!r.ok) check('読み込み', false, r.error.message)
    else {
      if (!engine) engine = new AudioEngine(0)
      engine.setBuffer(r.audio.buffer)
      engine.applyDsp(dspOf(3))
      await engine.exportSnapshot()
      await sample('解析の後・書き出し前', false)
      await sample('解析の後・書き出し前', true)
      for (let k = 0; k < rounds; k++) {
        let fired = false
        const box: { cancel?: () => void } = {}
        const { job } = await exportVideo(r.audio, dspOf(3), 'trim', (p) => {
          if (mode === 'cancel' && !fired && p.stage === 'rendering' && (p.fraction ?? 0) > 0.3) {
            fired = true
            box.cancel?.()
          }
        })
        box.cancel = job.cancel
        try {
          await job.promise
        } catch (e) {
          if (!(e instanceof VideoCancelledError)) throw e
        }
        await sample(`${mode === 'cancel' ? 'キャンセル' : '書き出し'} ${k + 1} 回目の後`, false)
        await sample(`${mode === 'cancel' ? 'キャンセル' : '書き出し'} ${k + 1} 回目の後`, true)
      }
      await sleep(60000)
      await sample('60 秒放置の後', true)
      releaseEngine()
      await sample('再生エンジンを破棄した後', true)
    }
  }

  releaseEngine()
  return results
}
