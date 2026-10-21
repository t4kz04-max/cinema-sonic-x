import { useEffect, useMemo, useRef, type PointerEvent } from 'react'
import { useElementSize } from '../hooks/useElementSize'

interface WaveformProps {
  buffer: AudioBuffer | null
  /** 0〜1 */
  progress: number
  onSeekRatio: (ratio: number) => void
}

const PEAK_BUCKETS = 2000
const BAR_WIDTH = 2
const BAR_GAP = 1

/**
 * 音源ごとのピーク（画面のモードの切替で波形を作り直しても、長い音源の全サンプルを読み直さない）。
 * WeakMap なので音源を読み替えると古いピークも解放される
 */
const peakCache = new WeakMap<AudioBuffer, Float32Array>()

function peaksOf(buffer: AudioBuffer): Float32Array {
  let p = peakCache.get(buffer)
  if (!p) {
    p = computePeaks(buffer)
    peakCache.set(buffer, p)
  }
  return p
}

/** 全チャンネルを通した区間ごとの最小・最大値（実データそのまま。正規化しない） */
function computePeaks(buffer: AudioBuffer): Float32Array {
  const peaks = new Float32Array(PEAK_BUCKETS * 2)
  const len = buffer.length
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  for (let b = 0; b < PEAK_BUCKETS; b++) {
    const start = Math.floor((b * len) / PEAK_BUCKETS)
    const end = Math.max(start + 1, Math.floor(((b + 1) * len) / PEAK_BUCKETS))
    let min = 0
    let max = 0
    for (const data of channels) {
      for (let i = start; i < end && i < len; i++) {
        const v = data[i]
        if (v < min) min = v
        else if (v > max) max = v
      }
    }
    peaks[b * 2] = min
    peaks[b * 2 + 1] = max
  }
  return peaks
}

export function Waveform({ buffer, progress, onSeekRatio }: WaveformProps) {
  const [wrapRef, size] = useElementSize<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const peaks = useMemo(() => (buffer ? peaksOf(buffer) : null), [buffer])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size.width * dpr
    canvas.height = size.height * dpr
    const g = canvas.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, size.width, size.height)

    const mid = size.height / 2
    g.fillStyle = 'rgba(139, 150, 200, 0.18)'
    g.fillRect(0, mid - 0.5, size.width, 1)
    if (!peaks) return

    const bars = Math.floor(size.width / (BAR_WIDTH + BAR_GAP))
    const playedX = progress * size.width
    const amp = mid * 0.92
    const played = g.createLinearGradient(0, 0, 0, size.height)
    played.addColorStop(0, '#c4b5fd')
    played.addColorStop(0.5, '#8b5cf6')
    played.addColorStop(1, '#c4b5fd')

    for (let i = 0; i < bars; i++) {
      const b0 = Math.floor((i * PEAK_BUCKETS) / bars)
      const b1 = Math.max(b0 + 1, Math.floor(((i + 1) * PEAK_BUCKETS) / bars))
      let min = 0
      let max = 0
      for (let b = b0; b < b1; b++) {
        if (peaks[b * 2] < min) min = peaks[b * 2]
        if (peaks[b * 2 + 1] > max) max = peaks[b * 2 + 1]
      }
      const x = i * (BAR_WIDTH + BAR_GAP)
      const top = mid - Math.min(max, 1) * amp
      const h = Math.max(1, (Math.min(max, 1) - Math.max(min, -1)) * amp)
      g.fillStyle = x < playedX ? played : 'rgba(120, 132, 190, 0.42)'
      g.fillRect(x, top, BAR_WIDTH, h)
    }

    g.fillStyle = '#ede9fe'
    g.fillRect(Math.min(playedX, size.width - 1.5), 0, 1.5, size.height)
  }, [peaks, progress, size])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!buffer) return
    const rect = e.currentTarget.getBoundingClientRect()
    onSeekRatio(Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1))
  }

  return (
    <div
      ref={wrapRef}
      className={`waveform${buffer ? '' : ' is-empty'}`}
      onPointerDown={onPointerDown}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} style={{ width: size.width, height: size.height }} />
      {!buffer && <span className="waveform__empty">NO SIGNAL — 音源未読み込み</span>}
    </div>
  )
}
