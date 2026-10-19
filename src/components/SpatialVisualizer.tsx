import { useEffect, useRef, useState } from 'react'
import { createPositions, MAX_DISTANCE_M, SOURCE_COUNT, SOURCE_NAMES, SPEAKER_AZIMUTHS, sourcePositions } from '../audio/spatial/motion'
import type { MotionReport } from '../audio/spatial/motionTypes'
import { isMotionActive, motionControl, motionLayout, type SpatialParams } from '../audio/spatial/spatialSpec'

interface SpatialVisualizerProps {
  params: SpatialParams
  readMotion: () => MotionReport | null
  playing: boolean
}

const PX = 260
const VIEW_DISTANCE_M = 7
const TRAIL = 40
const COLORS = ['#f5f3ff', '#a78bfa', '#38bdf8', '#fbbf24', '#f59e0b', '#64748b', '#64748b']

/**
 * Spatial Position Visualizer（上から見た図、上が前方）。
 * Motion ON: AudioWorklet が実際に使っている平滑化後の位置（約 30 Hz で通知）をそのまま描く。
 * Motion OFF: CINEMA / HALL の静止配置（DSP の設定値）を描く。演出用のアニメーションはしない。
 */
export function SpatialVisualizer({ params, readMotion, playing }: SpatialVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [mediaTime, setMediaTime] = useState<number | null>(null)
  const active = isMotionActive(params)
  const supported = params.mode === 'cinema' || params.mode === 'hall'
  const source = !supported ? 'none' : active ? 'dsp' : 'static'

  useEffect(() => {
    const canvas = canvasRef.current
    const g = canvas?.getContext('2d')
    if (!canvas || !g) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = PX * dpr
    canvas.height = PX * dpr
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const c = PX / 2
    const R = PX / 2 - 14
    const toXY = (az: number, d: number): [number, number] => {
      const r = Math.min(d / VIEW_DISTANCE_M, 1) * R
      const a = (az * Math.PI) / 180
      return [c + r * Math.sin(a), c - r * Math.cos(a)]
    }
    const trails: [number, number][][] = Array.from({ length: SOURCE_COUNT }, () => [])

    const draw = (pos: { azimuth: number; distance: number }[]) => {
      g.fillStyle = '#060912'
      g.fillRect(0, 0, PX, PX)
      g.strokeStyle = 'rgba(120, 132, 190, 0.18)'
      for (const m of [2, 4, 6]) {
        g.beginPath()
        g.arc(c, c, (m / VIEW_DISTANCE_M) * R, 0, Math.PI * 2)
        g.stroke()
      }
      g.fillStyle = 'rgba(120, 132, 190, 0.5)'
      g.font = '9px Consolas, monospace'
      for (const m of [2, 4, 6]) g.fillText(`${m}m`, c + 3, c - (m / VIEW_DISTANCE_M) * R + 10)
      // 仮想スピーカー（固定 HRTF の方向）
      for (const az of SPEAKER_AZIMUTHS) {
        const [x, y] = toXY(az, VIEW_DISTANCE_M)
        g.fillStyle = 'rgba(125, 211, 252, 0.35)'
        g.fillRect(x - 2, y - 2, 4, 4)
      }
      // 聴取者（上が前方）
      g.fillStyle = '#1e293b'
      g.beginPath()
      g.arc(c, c, 8, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = '#94a3b8'
      g.beginPath()
      g.moveTo(c, c - 12)
      g.lineTo(c - 4, c - 6)
      g.lineTo(c + 4, c - 6)
      g.fill()
      // レイヤー
      for (let s = SOURCE_COUNT - 1; s >= 0; s--) {
        const [x, y] = toXY(pos[s].azimuth, Math.min(pos[s].distance, MAX_DISTANCE_M))
        const tr = trails[s]
        tr.push([x, y])
        if (tr.length > TRAIL) tr.shift()
        g.strokeStyle = COLORS[s]
        g.globalAlpha = 0.35
        g.beginPath()
        tr.forEach(([tx, ty], i) => (i === 0 ? g.moveTo(tx, ty) : g.lineTo(tx, ty)))
        g.stroke()
        g.globalAlpha = 1
        g.fillStyle = COLORS[s]
        g.beginPath()
        g.arc(x, y, s >= 5 ? 3.5 : 5, 0, Math.PI * 2)
        g.fill()
      }
    }

    if (!supported) {
      draw(createPositions().map(() => ({ azimuth: 0, distance: 0 })))
      return
    }
    if (!active) {
      // 静止配置（DSP の設定値そのもの）
      const pos = createPositions()
      sourcePositions(0, motionLayout(params), { ...motionControl(params), enabled: false }, null, pos)
      draw(pos)
      return
    }
    let id = 0
    let frame = 0
    const pos = createPositions()
    const tick = () => {
      id = requestAnimationFrame(tick)
      const r = readMotion()
      if (!r) return
      for (let s = 0; s < SOURCE_COUNT; s++) {
        pos[s].azimuth = r.positions[s * 2]
        pos[s].distance = r.positions[s * 2 + 1]
      }
      draw(pos)
      if (++frame % 10 === 0) setMediaTime(r.mediaTime)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [active, supported, params, readMotion, playing])

  return (
    <div className="viz">
      <canvas ref={canvasRef} style={{ width: PX, height: PX }} role="img" aria-label="音源レイヤーの位置（上から見た図、上が前方）" />
      <ul className="viz__legend">
        {SOURCE_NAMES.slice(0, 5).map((n, i) => (
          <li key={n} style={{ color: COLORS[i] }}>
            {n}
          </li>
        ))}
        <li style={{ color: COLORS[5] }}>BED（低域）</li>
      </ul>
      <p className="viz__note">
        {source === 'dsp'
          ? `DSP の実際の位置（Motion ワークレットからの通知）・再生位置 ${active && mediaTime !== null ? Math.max(0, mediaTime).toFixed(2) : '—'} 秒`
          : source === 'static'
            ? 'Motion OFF: 静止配置（現在の設定値）'
            : 'CINEMA / HALL を選ぶと表示されます'}
        。青い点 = 固定 HRTF の仮想スピーカー（30° 間隔）
      </p>
    </div>
  )
}
