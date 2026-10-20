// 映像はそのまま（再エンコードせずパケットをコピー）、音声だけを加工済みの音声に差し替えた動画を作る。
//
//   入力動画 ─ 映像トラックの符号化済みパケット（タイムスタンプ・キーフレームそのまま）─────────────┐
//   加工済みの音声（元の音声トラックと同じ開始時刻・同じサンプルの位置）→ AAC / Opus エンコード ─┴→ 出力（入力と同じコンテナ）
//
// 同期: 映像のタイムスタンプはコピーし、音声は元の音声トラックの最初のタイムスタンプから並べる。書き出しの音声は
// Phase 06 で処理の遅延を先頭で切り捨ててあり、加工後のサンプル k が元のサンプル k と同じ時刻になる。
// エンコーダーの遅延（AAC のプライミング・Opus の pre-skip）は mediabunny がコンテナに記録する（試験で確認）。
// 余韻: trim = 映像の終わりで音声を切る（最後の 20 ms をフェード）/ extend = 最後のフレームの表示時間を延ばし、余韻の終わりまで映像を出す（再エンコードなし）

import { ALL_FORMATS, AudioSample, AudioSampleSource, BlobSource, BufferTarget, EncodedPacketSink, EncodedVideoPacketSource, Input, MkvOutputFormat, MovOutputFormat, Mp4OutputFormat, Output, WebMOutputFormat, type VideoCodec } from 'mediabunny'
import { VIDEO_AUDIO_BITRATE, VideoCancelledError, VIDEO_END_FADE_SECONDS, type VideoContainer, type VideoTailMode } from './videoSpec'

export interface RemuxOptions {
  container: VideoContainer
  audioCodec: 'aac' | 'opus'
  tailMode: VideoTailMode
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
  /** 試験専用: 映像のパケットをこの数だけ書いたところで止めたままにする（監視・打ち切りの試験用） */
  debugStallAfterPackets?: number
}

export interface RemuxResult {
  blob: Blob
  /** 出力の音声の長さ・映像の終わり（秒） */
  audioSeconds: number
  videoEnd: number
  /** extend のとき、最後のフレームを延ばした長さ（秒） */
  extendedSeconds: number
  /** trim のとき、映像の終わりより後ろで切り捨てた余韻（秒） */
  trimmedTailSeconds: number
  videoPackets: number
}

/**
 * 固定フレームレートなら、そのフレームレート（Hz）。先頭 300 フレームの間隔がすべて 1/fps の格子から ±0.6 ms 以内なら固定とみなす。
 * 可変フレームレートなら undefined（時刻を丸めないため）
 */
async function constantFrameRate(vt: NonNullable<Awaited<ReturnType<Input['getPrimaryVideoTrack']>>>): Promise<number | undefined> {
  const ts: number[] = []
  for await (const p of new EncodedPacketSink(vt).packets()) {
    ts.push(p.timestamp)
    if (ts.length >= 300) break
  }
  if (ts.length < 3) return undefined
  ts.sort((a, b) => a - b)
  const span = ts[ts.length - 1] - ts[0]
  const fps = Math.round(((ts.length - 1) / span) * 1000) / 1000
  const candidates = [24000 / 1001, 24, 25, 30000 / 1001, 30, 48, 50, 60000 / 1001, 60, 120]
  const rate = candidates.find((c) => Math.abs(c - fps) < 0.01) ?? fps
  const ok = ts.every((t) => Math.abs((t - ts[0]) * rate - Math.round((t - ts[0]) * rate)) / rate <= 0.0006)
  return ok ? rate : undefined
}

/** 1 回にエンコーダーへ渡す音声の長さ（フレーム） */
const AUDIO_CHUNK_SECONDS = 0.5

export async function remuxWithAudio(file: Blob, audio: { channels: Float32Array[]; sampleRate: number; startTime: number }, o: RemuxOptions): Promise<RemuxResult> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  let output: Output | null = null
  let detachAbort = () => {}
  const check = () => {
    if (o.signal?.aborted) throw new VideoCancelledError()
  }
  try {
    const vt = await input.getPrimaryVideoTrack()
    if (!vt) throw new Error('映像トラックがありません。')
    const codec = (await vt.getCodec()) as VideoCodec | null
    if (!codec) throw new Error('映像のコーデックを判定できないため、映像をコピーできません。')
    const decoderConfig = await vt.getDecoderConfig()
    const videoEnd = await vt.computeDuration()
    const rotation = await vt.getRotation()

    // 音声の長さ（trim: 映像の終わりまで / extend: 余韻の終わりまで）
    const sr = audio.sampleRate
    const total = audio.channels[0].length
    const toVideoEnd = Math.max(0, Math.round((videoEnd - audio.startTime) * sr))
    const frames = o.tailMode === 'trim' ? Math.min(total, toVideoEnd) : total
    const channels = audio.channels.map((c) => c.subarray(0, frames))
    const fadeEnd = o.tailMode === 'trim' && frames < total
    const audioEnd = audio.startTime + frames / sr

    const format =
      o.container === 'mp4' ? new Mp4OutputFormat({ fastStart: false }) : o.container === 'mov' ? new MovOutputFormat({ fastStart: false }) : o.container === 'webm' ? new WebMOutputFormat() : new MkvOutputFormat()
    output = new Output({ format, target: new BufferTarget() })
    // 打ち切り・キャンセル（signal）で、書きかけの出力をすぐ破棄する（待っている処理があっても出力を手放す）
    detachAbort = cancelOutputOnAbort(o.signal, output)
    // Matroska（WebM / MKV）はフレームの長さを SimpleBlock に書かず、トラックの DefaultDuration（frameRate を渡したときだけ書かれる）か
    // 次のフレームの時刻から推定される。渡さないと最後のフレームの長さが失われ、映像が 1 フレーム短くなる（Phase 07 で実測）。
    // ただし frameRate を渡すと時刻がその格子に丸められるため、フレームの間隔が一定（固定フレームレート）のときだけ渡す
    const matroska = o.container === 'webm' || o.container === 'mkv'
    const frameRate = matroska ? await constantFrameRate(vt) : undefined
    const videoSource = new EncodedVideoPacketSource(codec)
    output.addVideoTrack(videoSource, { rotation, frameRate })
    // Opus は 48 kHz（他のレートは mediabunny が 48 kHz に変換してからエンコード）
    const audioSource = new AudioSampleSource({
      codec: o.audioCodec,
      bitrate: VIDEO_AUDIO_BITRATE[o.audioCodec],
      transform: o.audioCodec === 'opus' && sr !== 48000 ? { sampleRate: 48000 } : undefined,
    })
    output.addAudioTrack(audioSource, { languageCode: undefined })
    await output.start()

    // 音声を少しずつ渡す（映像のパケットと時刻が大きく離れないように交互に）
    const nch = channels.length
    const chunk = Math.round(AUDIO_CHUNK_SECONDS * sr)
    let a0 = 0
    const fadeFrames = Math.round(VIDEO_END_FADE_SECONDS * sr)
    const pushAudioUntil = async (t: number) => {
      while (a0 < frames && audio.startTime + a0 / sr <= t) {
        check()
        const n = Math.min(chunk, frames - a0)
        const planar = new Float32Array(n * nch)
        for (let c = 0; c < nch; c++) planar.set(channels[c].subarray(a0, a0 + n), c * n)
        if (fadeEnd && a0 + n > frames - fadeFrames) {
          for (let i = 0; i < n; i++) {
            const k = a0 + i - (frames - fadeFrames)
            if (k < 0) continue
            const g = 0.5 + 0.5 * Math.cos((Math.PI * (k + 1)) / fadeFrames)
            for (let c = 0; c < nch; c++) planar[c * n + i] *= g
          }
        }
        const sample = new AudioSample({ data: planar, format: 'f32-planar', numberOfChannels: nch, sampleRate: sr, timestamp: audio.startTime + a0 / sr })
        await audioSource.add(sample)
        sample.close()
        a0 += n
        // 監視用: 音声のまとまりごとにも進んだことを知らせる（割合は映像の時刻のまま）
        o.onProgress?.(lastFraction)
      }
    }
    let lastFraction = 0

    // 映像: パケットをそのままコピー（extend のときは最後のパケットの表示時間を延ばす）
    const sink = new EncodedPacketSink(vt)
    let prev: Awaited<ReturnType<EncodedPacketSink['getFirstPacket']>> = null
    let count = 0
    let first = true
    let extendedSeconds = 0
    const addVideo = async (p: NonNullable<typeof prev>, last: boolean) => {
      let packet = p
      if (last && o.tailMode === 'extend' && audioEnd > p.timestamp + p.duration) {
        extendedSeconds = audioEnd - (p.timestamp + p.duration)
        packet = p.clone({ duration: audioEnd - p.timestamp })
      }
      await videoSource.add(packet, first && decoderConfig ? { decoderConfig } : undefined)
      first = false
      count++
    }
    for await (const p of sink.packets()) {
      check()
      if (o.debugStallAfterPackets !== undefined && count >= o.debugStallAfterPackets) await new Promise<never>(() => {})
      if (prev) await addVideo(prev, false)
      await pushAudioUntil(p.timestamp)
      prev = p
      lastFraction = Math.min(0.99, p.timestamp / Math.max(1e-6, videoEnd))
      o.onProgress?.(lastFraction)
    }
    if (prev) await addVideo(prev, true)
    await pushAudioUntil(Infinity)
    check()
    await output.finalize()
    const buf = (output.target as BufferTarget).buffer!
    o.onProgress?.(1)
    return {
      blob: new Blob([buf], { type: await output.getMimeType() }),
      audioSeconds: frames / sr,
      videoEnd,
      extendedSeconds,
      trimmedTailSeconds: fadeEnd ? (total - frames) / sr : 0,
      videoPackets: count,
    }
  } catch (e) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {})
    throw e
  } finally {
    detachAbort()
    input.dispose()
  }
}

/**
 * signal が中止されたら出力を破棄する。リスナーはこの小さな関数の中で作る（remuxWithAudio の中で作ると、同じ関数の
 * 他のクロージャーが使う音声の配列まで一緒に捕まえ、signal が残る間その配列が解放されない）。終わったら外す
 */
function cancelOutputOnAbort(signal: AbortSignal | undefined, out: Output): () => void {
  if (!signal) return () => {}
  const onAbort = () => {
    if (out.state !== 'finalized' && out.state !== 'canceled') void out.cancel().catch(() => {})
  }
  signal.addEventListener('abort', onAbort)
  return () => signal.removeEventListener('abort', onAbort)
}
