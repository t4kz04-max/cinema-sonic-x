// 動画から音声トラックを取り出して PCM（元のサンプルレート・コンテナの時刻つき）にする。
// decodeAudioData は使わない: 音声トラックの開始時刻（映像との時間差）が失われるため（Phase 07 で実測: 0.5 秒後に始まる音声が 0 秒からになる）。
// mediabunny + WebCodecs の AudioDecoder でデコードし、各サンプルのタイムスタンプの位置に並べる（AAC のプライミングなどはコンテナの情報で除かれる）。

import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny'
import { VideoCancelledError, type ExtractedAudio } from './videoSpec'

/** 音声トラックをデコードする。trackId を省略すると主な音声トラック。音声がなければ例外 */
export async function extractAudio(file: Blob, opts: { trackId?: number; signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<ExtractedAudio> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const tracks = await input.getAudioTracks()
    const track = opts.trackId !== undefined ? tracks.find((t) => t.id === opts.trackId) : await input.getPrimaryAudioTrack()
    if (!track) throw new Error('この動画には音声トラックがありません。')
    if (!(await track.canDecode())) throw new Error(`このブラウザでは音声のコーデック（${(await track.getCodec()) ?? '不明'}）をデコードできません。`)
    const sampleRate = await track.getSampleRate()
    const numberOfChannels = await track.getNumberOfChannels()
    const startTime = await track.getFirstTimestamp()
    const duration = await track.computeDuration()
    // 長さはコンテナの値から確保し、足りなければ伸ばす（タイムスタンプの位置に置くので、途中の欠けは無音になる）
    let capacity = Math.ceil((duration - startTime) * sampleRate) + sampleRate
    let channels = Array.from({ length: numberOfChannels }, () => new Float32Array(capacity))
    let end = 0
    for await (const s of new AudioSampleSink(track).samples()) {
      if (opts.signal?.aborted) {
        s.close()
        throw new VideoCancelledError()
      }
      const offset = Math.round((s.timestamp - startTime) * sampleRate)
      const n = s.numberOfFrames
      if (offset + n > capacity) {
        capacity = Math.max(offset + n, Math.ceil(capacity * 1.5))
        channels = channels.map((c) => {
          const g = new Float32Array(capacity)
          g.set(c)
          return g
        })
      }
      if (offset >= 0) {
        for (let c = 0; c < numberOfChannels; c++) s.copyTo(channels[c].subarray(offset, offset + n), { planeIndex: c, format: 'f32-planar' })
        end = Math.max(end, offset + n)
      }
      s.close()
      opts.onProgress?.(Math.min(1, (s.timestamp - startTime) / Math.max(1e-6, duration - startTime)))
    }
    if (end === 0) throw new Error('音声トラックをデコードできましたが、サンプルが含まれていません。')
    return { channels: channels.map((c) => c.slice(0, end)), sampleRate, startTime }
  } finally {
    input.dispose()
  }
}
