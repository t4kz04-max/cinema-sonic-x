// 試験用: 動画を読み戻して、映像のフラッシュの時刻と音声のクリックの時刻を測る（mediabunny + WebCodecs でデコード）。

import { ALL_FORMATS, AudioSampleSink, BlobSource, EncodedPacketSink, Input, VideoSampleSink } from 'mediabunny'

export interface MarkTimes {
  /** 白いフレームの表示時刻（秒） */
  flashes: number[]
  /** クリックの立ち上がりの時刻（秒、デコードした音声のタイムスタンプから） */
  clicks: number[]
  videoStart: number | null
  audioStart: number | null
  videoDuration: number | null
  audioDuration: number | null
  videoPackets: { timestamp: number; duration: number; byteLength: number; key: boolean; hash: number }[]
}

/** パケットの中身の簡易ハッシュ（映像のストリームコピーの確認用） */
export function hashBytes(b: Uint8Array): number {
  let h = 2166136261
  for (let i = 0; i < b.length; i++) {
    h ^= b[i]
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export async function measureMarks(blob: Blob, opts: { decodeVideo?: boolean; clickThreshold?: number } = {}): Promise<MarkTimes> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const v = await input.getPrimaryVideoTrack()
    const a = await input.getPrimaryAudioTrack()
    const out: MarkTimes = { flashes: [], clicks: [], videoStart: null, audioStart: null, videoDuration: null, audioDuration: null, videoPackets: [] }
    if (v) {
      out.videoStart = await v.getFirstTimestamp()
      out.videoDuration = await v.computeDuration()
      for await (const p of new EncodedPacketSink(v).packets()) out.videoPackets.push({ timestamp: p.timestamp, duration: p.duration, byteLength: p.byteLength, key: p.type === 'key', hash: hashBytes(p.data) })
      if (opts.decodeVideo ?? true) {
        const canvas = new OffscreenCanvas(16, 16)
        const g = canvas.getContext('2d', { willReadFrequently: true })!
        let prevBright = false
        for await (const s of new VideoSampleSink(v).samples()) {
          s.draw(g, 0, 0, 16, 16)
          s.close()
          const px = g.getImageData(8, 12, 1, 1).data
          const bright = px[0] > 128
          if (bright && !prevBright) out.flashes.push(s.timestamp)
          prevBright = bright
        }
      }
    }
    if (a) {
      out.audioStart = await a.getFirstTimestamp()
      out.audioDuration = await a.computeDuration()
      const th = opts.clickThreshold ?? 0.1
      let quietSince = -Infinity
      let first: number | null = null
      for await (const s of new AudioSampleSink(a).samples()) {
        const n = s.numberOfFrames
        const buf = new Float32Array(n)
        s.copyTo(buf, { planeIndex: 0, format: 'f32-planar' })
        if (first === null) first = s.timestamp
        for (let i = 0; i < n; i++) {
          const t = s.timestamp + i / s.sampleRate
          if (Math.abs(buf[i]) >= th) {
            if (t - quietSince > 0.3) out.clicks.push(t)
            quietSince = t
          }
        }
        s.close()
      }
    }
    return out
  } finally {
    input.dispose()
  }
}
