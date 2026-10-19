// 書き出しのオフラインレンダリング（Phase 06）。再生と同じ createOutputChain（重低音 → 空間）と同じ処理計画で、
// 音源全体 + 余韻を OfflineAudioContext で描画し、WAV にする。
//
//   音源（メディア時刻 0 から）→ [重低音] → [空間: CINEMA / HALL / Motion / Spatial Tail / Dynamic Tail] → 出力
//   出力の先頭の処理の遅延を切り捨て（音源と同じ時刻にそろえる）、末尾は余韻が −100 dBFS を下回ってから 150 ms 後で切り、最後の 20 ms をフェード
//
// Motion の位置はメディア時刻の純粋関数なので、transport を「時刻 0 から再生」にすれば、再生中のシーク・プレビューの
// 履歴によらず曲の先頭から同じ動きになる。PULSE の包絡は書き出す音源全体から計算する（再生と同じ関数）。
// 通常は使い捨ての iframe（exportFrame.ts）の中で実行する（Chrome が AudioWorklet を読み込んだ OfflineAudioContext を
// 解放しないため、iframe ごと破棄してメモリを返す。キャンセルも iframe の破棄で行う）。

import { loadAlignWorklet } from '../alignDelay'
import { integratedLoudness, linearToDb, samplePeak } from '../loudness'
import { createOutputChain } from '../outputChain'
import { loadDynamicsWorklet } from '../processingGraph'
import { computeEnvelope } from '../spatial/motionEnvelope'
import { loadMotionWorklet, measureHrtfLatency } from '../spatial/spatialGraph'
import { isMotionActive } from '../spatial/spatialSpec'
import { loadTailWorklet } from '../spatial/tailEngine'
import { END_FADE_SECONDS, renderSeconds, TAIL_KEEP_AFTER_SECONDS, TAIL_SILENCE_THRESHOLD, type ExportProgress, type ExportRequest, type ExportResult } from './exportSpec'
import { encodeWav } from './wavEncoder'

/** 進捗を測るための suspend の回数（多すぎるとレンダリングが遅くなる） */
const PROGRESS_STEPS = 40
const RENDER_QUANTUM = 128

export interface RenderedExport {
  /** 先頭の処理の遅延を切り捨て、末尾を切り詰めた浮動小数点の出力（ステレオ） */
  channels: Float32Array[]
  sourceSeconds: number
  tailSeconds: number
  headTrimSeconds: number
  renderMs: number
}

/** オフラインレンダリング（WAV にする前の浮動小数点の結果） */
export async function renderExportFloat(req: ExportRequest, onProgress: (p: ExportProgress) => void = () => {}): Promise<RenderedExport> {
  onProgress({ stage: 'preparing' })
  const sr = req.sampleRate
  const srcFrames = req.channels[0].length
  const sourceSeconds = srcFrames / sr
  const hrtfLatency = await measureHrtfLatency(sr)
  // 遅延（先頭の切り捨て量）はチェーンを作ってから正確に分かるため、まず上限で長さを決める（Motion の STFT + HRTF + 先読み 2 段）
  const maxHead = 4096 / sr + hrtfLatency + 0.02
  const totalFrames = Math.ceil(renderSeconds(sourceSeconds, maxHead, req.dsp.spatial) * sr)
  const ctx = new OfflineAudioContext(2, totalFrames, sr)
  if (!(await loadDynamicsWorklet(ctx))) throw new Error('AudioWorklet を読み込めませんでした（書き出しには AudioWorklet が必要です）')
  await loadTailWorklet(ctx)
  const motionOk = await loadMotionWorklet(ctx)
  await loadAlignWorklet(ctx)
  if (isMotionActive(req.dsp.spatial) && !motionOk) throw new Error('Motion の AudioWorklet を読み込めませんでした')
  const envelope = isMotionActive(req.dsp.spatial) ? computeEnvelope(req.channels, sr, req.dsp.spatial.motionSpeed / 100) : null

  const source = new AudioBuffer({ length: srcFrames, numberOfChannels: req.channels.length, sampleRate: sr })
  req.channels.forEach((d, c) => source.copyToChannel(d as Float32Array<ArrayBuffer>, c))
  const chain = createOutputChain(ctx, {
    dsp: req.dsp,
    bypass: false,
    useWorklet: true,
    bassScale: req.bassScale,
    bassDynamics: { ...req.bassDynamics, reportIntervalMs: 0 },
    spatial: {
      trimDb: req.spatialTrimDb,
      hrtfLatencySeconds: hrtfLatency,
      wideSideCapDb: req.wideSideCapDb,
      // 使うモードだけ作る（使わないチェーンは再生時も入力を切り離していて、出力に寄与しない）
      modes: req.dsp.spatial.mode === 'off' ? [] : [req.dsp.spatial.mode],
      reportIntervalMs: 0,
      motion: motionOk ? { transport: { playing: true, startedAt: 0, pausedAt: 0 }, envelope, reportIntervalMs: 0 } : undefined,
    },
  })
  const node = new AudioBufferSourceNode(ctx, { buffer: source })
  node.connect(chain.input)
  chain.output.connect(ctx.destination)
  const headTrimSeconds = chain.bass.latencySeconds * (req.dsp.bassEnabled ? 1 : 0) + chain.spatial.processingLatencySeconds()
  const head = Math.round(headTrimSeconds * sr)

  // 進捗: 一定間隔で suspend し、そこまでレンダリングし終えた割合を通知する（推定ではなく実際に描画済みの時刻）
  const step = Math.max(RENDER_QUANTUM, Math.ceil(totalFrames / PROGRESS_STEPS / RENDER_QUANTUM) * RENDER_QUANTUM)
  for (let f = step; f < totalFrames; f += step) {
    void ctx.suspend(f / sr).then(() => {
      onProgress({ stage: 'rendering', rendered: f / totalFrames })
      void ctx.resume()
    })
  }
  node.start(0)
  onProgress({ stage: 'rendering', rendered: 0 })
  const t0 = performance.now()
  const out = await ctx.startRendering()
  const renderMs = performance.now() - t0
  onProgress({ stage: 'rendering', rendered: 1 })

  // 先頭の処理の遅延を切り捨て、末尾は余韻がしきい値を下回った所まで（音源の長さより短くはしない）
  const L = out.getChannelData(0)
  const R = out.getChannelData(1)
  let last = head + srcFrames - 1
  for (let i = L.length - 1; i > last; i--) {
    if (Math.abs(L[i]) > TAIL_SILENCE_THRESHOLD || Math.abs(R[i]) > TAIL_SILENCE_THRESHOLD) {
      last = i
      break
    }
  }
  const end = Math.min(L.length, last + 1 + Math.round(TAIL_KEEP_AFTER_SECONDS * sr))
  const channels = [L.slice(head, end), R.slice(head, end)]
  // 末尾のフェード（しきい値以下の残りを 0 へ。余韻の本体は切らない）
  const fade = Math.min(Math.round(END_FADE_SECONDS * sr), channels[0].length)
  for (const ch of channels) {
    for (let i = 0; i < fade; i++) {
      const k = ch.length - fade + i
      ch[k] *= 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / fade)
    }
  }
  return { channels, sourceSeconds, tailSeconds: channels[0].length / sr - sourceSeconds, headTrimSeconds: head / sr, renderMs }
}

/** レンダリング → WAV */
export async function renderExport(req: ExportRequest, onProgress: (p: ExportProgress) => void = () => {}): Promise<ExportResult> {
  const r = await renderExportFloat(req, onProgress)
  onProgress({ stage: 'encoding' })
  const { blob, stats } = encodeWav(r.channels, { sampleRate: req.sampleRate, bitDepth: req.bitDepth, dither: true, seed: req.ditherSeed })
  return {
    blob,
    sampleRate: req.sampleRate,
    bitDepth: req.bitDepth,
    channels: 2,
    frames: r.channels[0].length,
    sourceSeconds: r.sourceSeconds,
    tailSeconds: r.tailSeconds,
    headTrimSeconds: r.headTrimSeconds,
    peakDb: linearToDb(samplePeak(r.channels)),
    loudnessLufs: integratedLoudness(r.channels, req.sampleRate),
    clippedSamples: stats.clippedSamples,
    renderMs: r.renderMs,
    float: req.returnFloat ? r.channels : undefined,
  }
}
