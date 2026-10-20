// 動画の書き出し（Phase 07）: Phase 06 の書き出し（使い捨て iframe でのオフラインレンダリング）で音声を加工し、
// 映像はコピーしたまま音声だけを差し替える。音声だけの WAV（元の音声 / 立体音響化）もここから。

import type { ExportSnapshot } from '../audio/AudioEngine'
import { startExport, ExportCancelledError } from '../audio/export/exportRunner'
import type { ExportProgress, ExportRequest, ExportWatchdog } from '../audio/export/exportSpec'
import { encodeWav, type WavBitDepth } from '../audio/export/wavEncoder'
import { remuxWithAudio, type RemuxResult } from './videoMux'
import { MUX_STALL_MS, outputAudioCodecFor, VideoCancelledError, VideoTimeoutError, type ExtractedAudio, type VideoInfo, type VideoTailMode } from './videoSpec'

export type VideoJobStage = 'preparing' | 'rendering' | 'encoding' | 'muxing'

export interface VideoJobProgress {
  stage: VideoJobStage
  /** rendering: レンダリング済みの割合（実測）/ muxing: 映像のパケットを書き終えた割合（時刻）/ 他は undefined */
  fraction?: number
}

export interface VideoJob<T> {
  promise: Promise<T>
  cancel(): void
}

/** 元の音声（処理なし）を WAV に。音声トラックの開始時刻は WAV に入らない（WAV には時刻の情報がない） */
export function originalAudioWav(audio: ExtractedAudio, bitDepth: WavBitDepth): Blob {
  return encodeWav(audio.channels.length === 1 ? [audio.channels[0], audio.channels[0]] : audio.channels.slice(0, 2), { sampleRate: audio.sampleRate, bitDepth, seed: 1 }).blob
}

export interface VideoExportResult extends RemuxResult {
  audioCodec: 'aac' | 'opus'
  /** Phase 06 の書き出しで切り捨てた処理の遅延（秒）と、加えた余韻（秒） */
  headTrimSeconds: number
  tailSeconds: number
  renderMs: number
  muxMs: number
}

/** AAC をエンコードできるか（できなければ MP4 / MOV の音声は Opus） */
export { canEncodeAudio } from 'mediabunny'

/** 立体音響化した音声で、映像をコピーした動画を作る */
export function startVideoExport(
  file: File,
  info: VideoInfo,
  audio: ExtractedAudio,
  snap: ExportSnapshot,
  o: {
    tailMode: VideoTailMode
    aacAvailable: boolean
    onProgress: (p: VideoJobProgress) => void
    /** 監視の時間（省略時は既定値。試験で短くする） */
    watchdog?: Partial<ExportWatchdog>
    muxStallMs?: number
    /** 試験専用: 動画の書き込みを途中で止める（監視・打ち切りの試験用） */
    debugMuxStallAfterPackets?: number
    /** 試験専用: 音声のレンダリングの段階で止める（ExportRequest.debugStall） */
    debugStall?: ExportRequest['debugStall']
  },
): VideoJob<VideoExportResult> {
  const abort = new AbortController()
  let renderJob: ReturnType<typeof startExport> | null = null
  const promise = (async () => {
    o.onProgress({ stage: 'preparing' })
    // Phase 06 の書き出し（WAV は作らず、浮動小数点の結果だけ受け取る）
    const t0 = performance.now()
    renderJob = startExport(
      { channels: audio.channels.map((c) => c.slice()), sampleRate: audio.sampleRate, ...snap, bitDepth: 16, ditherSeed: 1, returnFloat: true, encodeWav: false, debugStall: o.debugStall },
      (p: ExportProgress) => o.onProgress(p.stage === 'rendering' ? { stage: 'rendering', fraction: p.rendered } : { stage: p.stage === 'encoding' ? 'encoding' : 'preparing' }),
      { watchdog: o.watchdog },
    )
    let rendered
    try {
      rendered = await renderJob.promise
    } catch (e) {
      if (e instanceof ExportCancelledError) throw new VideoCancelledError()
      throw e
    }
    const renderMs = performance.now() - t0
    // 浮動小数点の結果（3 分で 約 70 MB）を結果のオブジェクトから外し、レンダリングの job への参照も切る。
    // job の promise は解決した値（この結果）を持ち続け、キャンセル用の関数から参照されるため、外さないと書き出しのたびに残っていた（Phase 07 で実測: 3 分の動画で 1 回 +70〜77 MB）
    const float = rendered.float!
    rendered.float = undefined
    renderJob = null
    if (abort.signal.aborted) throw new VideoCancelledError()
    const audioCodec = outputAudioCodecFor(info.container, o.aacAvailable)
    const t1 = performance.now()
    o.onProgress({ stage: 'muxing', fraction: 0 })
    // 監視: 映像のパケット・音声のまとまりの進捗が MUX_STALL_MS 届かなければ打ち切る（出力は破棄、結果は返さない）
    const stallMs = o.muxStallMs ?? MUX_STALL_MS
    let lastBeat = performance.now()
    let watch: ReturnType<typeof setInterval> | undefined
    const stalled = new Promise<never>((_, reject) => {
      watch = setInterval(() => {
        const since = performance.now() - lastBeat
        if (since <= stallMs) return
        clearInterval(watch)
        abort.abort()
        console.warn('[CINEMA SONIC X] 動画の書き込みを監視で打ち切りました', JSON.stringify({ container: info.container, audioCodec, stalledMs: Math.round(since) }))
        reject(new VideoTimeoutError(since))
      }, 500)
    })
    let r: RemuxResult
    try {
      r = await Promise.race([
        remuxWithAudio(file, { channels: float, sampleRate: audio.sampleRate, startTime: audio.startTime }, {
          container: info.container,
          audioCodec,
          tailMode: o.tailMode,
          signal: abort.signal,
          debugStallAfterPackets: o.debugMuxStallAfterPackets,
          onProgress: (f) => {
            lastBeat = performance.now()
            o.onProgress({ stage: 'muxing', fraction: f })
          },
        }),
        stalled,
      ])
    } finally {
      clearInterval(watch)
    }
    return { ...r, audioCodec, headTrimSeconds: rendered.headTrimSeconds, tailSeconds: rendered.tailSeconds, renderMs, muxMs: performance.now() - t1 }
  })()
  return {
    promise,
    cancel() {
      abort.abort()
      renderJob?.cancel()
    },
  }
}
