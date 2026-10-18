import { useEffect, useMemo, useRef } from 'react'
import type { BassParams } from '../audio/bassSpec'
import { computeEqResponse, logFrequencies } from '../audio/eqResponse'
import { useElementSize } from '../hooks/useElementSize'

interface EqCurveProps {
  params: BassParams
  /** EQ に実際に掛かっている倍率（上限・安全制限込み） */
  scale: number
  trimDb: number
  bypass: boolean
}

const F_MIN = 20
const F_MAX = 20000
const DB_MIN = -12
const DB_MAX = 27
const FREQS = logFrequencies(320, F_MIN, F_MAX)
const GRID_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const GRID_DB = [-6, 0, 6, 12, 18, 24]

const COLORS = {
  bass: '#a78bfa',
  bassFill: 'rgba(167, 139, 250, 0.22)',
  sub: '#38bdf8',
  subFill: 'rgba(56, 189, 248, 0.2)',
  total: '#f5f3ff',
  trimmed: '#fbbf24',
  grid: 'rgba(120, 132, 190, 0.14)',
  zero: 'rgba(160, 170, 220, 0.35)',
  label: '#4f5878',
}

const formatFreq = (f: number) => (f >= 1000 ? `${f / 1000}k` : `${f}`)

export function EqCurve({ params, scale, trimDb, bypass }: EqCurveProps) {
  const [wrapRef, size] = useElementSize<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const response = useMemo(() => computeEqResponse(params, scale, FREQS), [params, scale])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size.width * dpr
    canvas.height = size.height * dpr
    const g = canvas.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const { width: w, height: h } = size
    g.clearRect(0, 0, w, h)

    const x = (f: number) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w
    const y = (db: number) => ((DB_MAX - Math.min(Math.max(db, DB_MIN), DB_MAX)) / (DB_MAX - DB_MIN)) * h

    g.font = '10px Consolas, monospace'
    g.fillStyle = COLORS.label
    for (const f of GRID_FREQS) {
      g.fillStyle = COLORS.grid
      g.fillRect(Math.round(x(f)), 0, 1, h)
      g.fillStyle = COLORS.label
      g.fillText(formatFreq(f), Math.min(x(f) + 3, w - 22), h - 4)
    }
    for (const db of GRID_DB) {
      g.fillStyle = db === 0 ? COLORS.zero : COLORS.grid
      g.fillRect(0, Math.round(y(db)), w, 1)
      g.fillStyle = COLORS.label
      g.fillText(`${db > 0 ? '+' : ''}${db}`, 4, y(db) - 3)
    }
    if (!response) return

    const path = (values: Float32Array, offset = 0) => {
      g.beginPath()
      for (let i = 0; i < FREQS.length; i++) {
        const px = x(FREQS[i])
        const py = y(values[i] + offset)
        if (i === 0) g.moveTo(px, py)
        else g.lineTo(px, py)
      }
    }
    const area = (values: Float32Array, fill: string, stroke: string) => {
      path(values)
      g.lineTo(w, y(0))
      g.lineTo(0, y(0))
      g.closePath()
      g.fillStyle = fill
      g.fill()
      path(values)
      g.strokeStyle = stroke
      g.lineWidth = 1.25
      g.stroke()
    }

    g.globalAlpha = bypass ? 0.3 : 1
    area(response.bassDb, COLORS.bassFill, COLORS.bass)
    area(response.subDb, COLORS.subFill, COLORS.sub)

    path(response.totalDb)
    g.strokeStyle = COLORS.total
    g.lineWidth = 2
    g.stroke()

    if (trimDb < -0.05) {
      path(response.totalDb, trimDb)
      g.setLineDash([5, 4])
      g.strokeStyle = COLORS.trimmed
      g.lineWidth = 1.5
      g.stroke()
      g.setLineDash([])
    }
    g.globalAlpha = 1
  }, [response, size, trimDb, bypass])

  return (
    <div className="eq-curve">
      <div className="eq-curve__plot" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          style={{ width: size.width, height: size.height }}
          role="img"
          aria-label="低音EQの周波数特性"
        />
        {bypass && <span className="eq-curve__overlay">BYPASS 中 — 原音をそのまま出力</span>}
      </div>
      <ul className="eq-legend">
        <li style={{ color: COLORS.bass }}>BASS BOOST</li>
        <li style={{ color: COLORS.sub }}>SUB BASS</li>
        <li style={{ color: COLORS.total }}>EQ 合計</li>
        <li style={{ color: COLORS.trimmed }} className="is-dashed">
          全帯域トリム込み
        </li>
        <li className="eq-legend__note">EQ 単体の特性（低域コンプ・リミッターの動的な抑制は含まない）</li>
      </ul>
    </div>
  )
}
