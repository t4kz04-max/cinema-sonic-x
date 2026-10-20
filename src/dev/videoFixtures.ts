// 試験用の動画をブラウザ内で作る（WebCodecs でエンコードし、mediabunny で MP4 / WebM にまとめる）。
// 映像は黒の画面に、指定時刻だけ白いフレーム（フラッシュ）を入れ、音声は同じ時刻にクリック（短いノイズバースト）を入れる。
// 書き出した動画を読み戻して、フラッシュとクリックの時刻差（音声・映像の同期）を測る。

import { AudioSample, AudioSampleSource, BufferTarget, EncodedPacket, EncodedVideoPacketSource, MkvOutputFormat, MovOutputFormat, Mp4OutputFormat, Output, WebMOutputFormat, type AudioCodec, type VideoCodec } from 'mediabunny'

export interface FixtureOptions {
  container: 'mp4' | 'mov' | 'webm' | 'mkv'
  videoCodec: VideoCodec
  /** null = 音声なし */
  audioCodec: AudioCodec | null
  seconds: number
  fps?: number
  width?: number
  height?: number
  sampleRate?: number
  /** フラッシュ（映像）とクリック（音声）の時刻（秒、映像の時刻） */
  marks?: number[]
  /** 音声トラックの開始時刻（秒）。映像は 0 から */
  audioStart?: number
  /** クリックの代わりに入れる連続音（試験用、振幅） */
  tone?: number
}

const CODEC_STRING: Record<string, string> = {
  avc: 'avc1.42001f',
  vp8: 'vp8',
  vp9: 'vp09.00.10.08',
  av1: 'av01.0.04M.08',
}

/** 試験用の動画を作る（Blob）。エンコーダーが使えない場合は例外 */
export async function makeFixtureVideo(o: FixtureOptions): Promise<{ blob: Blob; marks: number[] }> {
  const fps = o.fps ?? 30
  const w = o.width ?? 320
  const h = o.height ?? 240
  const sr = o.sampleRate ?? 48000
  const marks = o.marks ?? [1, 2.5, 4]
  const format =
    o.container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : o.container === 'mov' ? new MovOutputFormat({ fastStart: 'in-memory' }) : o.container === 'webm' ? new WebMOutputFormat() : new MkvOutputFormat()
  const output = new Output({ format, target: new BufferTarget() })
  const videoSource = new EncodedVideoPacketSource(o.videoCodec)
  output.addVideoTrack(videoSource, { frameRate: fps })
  let audioSource: AudioSampleSource | null = null
  if (o.audioCodec) {
    audioSource = new AudioSampleSource({ codec: o.audioCodec, bitrate: 128000 })
    output.addAudioTrack(audioSource)
  }
  await output.start()

  // 映像: VideoEncoder で 1 フレームずつ（マーク時刻のフレームだけ白）
  const frames = Math.round(o.seconds * fps)
  const canvas = new OffscreenCanvas(w, h)
  const g = canvas.getContext('2d')!
  const chunks: { chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }[] = []
  const enc = new VideoEncoder({
    output: (chunk, meta) => chunks.push({ chunk, meta }),
    error: (e) => {
      throw e
    },
  })
  enc.configure({ codec: CODEC_STRING[o.videoCodec] ?? o.videoCodec, width: w, height: h, bitrate: 300_000, framerate: fps, ...(o.videoCodec === 'avc' ? { avc: { format: 'avc' } } : {}) })
  const markFrames = new Set(marks.map((t) => Math.round(t * fps)))
  for (let i = 0; i < frames; i++) {
    g.fillStyle = markFrames.has(i) ? '#ffffff' : '#000000'
    g.fillRect(0, 0, w, h)
    // フレーム番号を少し描く（すべてのフレームが同一にならないように）
    g.fillStyle = '#202020'
    g.fillRect((i * 7) % (w - 8), 4, 8, 8)
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) })
    enc.encode(frame, { keyFrame: i % fps === 0 })
    frame.close()
    // 待たずに入れ続けるとエンコーダーのキューにフレームが溜まる（3 分の 640×360 で数 GB）
    while (enc.encodeQueueSize > 8) await new Promise<void>((r) => enc.addEventListener('dequeue', () => r(), { once: true }))
  }
  await enc.flush()
  enc.close()
  for (const { chunk, meta } of chunks) await videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta)

  // 音声: クリック（L=R の 5 ms のノイズバースト）
  if (audioSource) {
    const start = o.audioStart ?? 0
    const len = Math.round((o.seconds - start) * sr)
    const data = new Float32Array(len * 2)
    let seed = 1
    for (const t of marks) {
      const s = Math.round((t - start) * sr)
      for (let k = 0; k < Math.round(0.005 * sr) && s + k < len; k++) {
        seed = (seed * 1664525 + 1013904223) >>> 0
        const v = ((seed / 0x100000000) * 2 - 1) * 0.5
        data[(s + k) * 2] = v
        data[(s + k) * 2 + 1] = v
      }
    }
    if (o.tone) for (let i = 0; i < len; i++) for (let c = 0; c < 2; c++) data[i * 2 + c] += o.tone * Math.sin((2 * Math.PI * 440 * i) / sr)
    // 1 秒ずつ渡す
    for (let f0 = 0; f0 < len; f0 += sr) {
      const n = Math.min(sr, len - f0)
      // subarray（オフセット付きのビュー）を渡すと先頭から読まれるため、コピーを渡す
      const sample = new AudioSample({ data: data.slice(f0 * 2, (f0 + n) * 2), format: 'f32', numberOfChannels: 2, sampleRate: sr, timestamp: start + f0 / sr })
      await audioSource.add(sample)
      sample.close()
    }
  }
  await output.finalize()
  const buf = (output.target as BufferTarget).buffer!
  const mime = o.container === 'mp4' ? 'video/mp4' : o.container === 'mov' ? 'video/quicktime' : o.container === 'webm' ? 'video/webm' : 'video/x-matroska'
  return { blob: new Blob([buf], { type: mime }), marks }
}
