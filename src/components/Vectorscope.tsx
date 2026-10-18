import { useEffect, useRef, useState } from 'react'

interface VectorscopeProps {
  read: (left: Float32Array<ArrayBuffer>, right: Float32Array<ArrayBuffer>) => boolean
  active: boolean
}

const SIZE = 2048
const PX = 220

/**
 * ゴニオメーター（ベクトルスコープ）: 縦軸 = Mid（L+R）、横軸 = Side（R−L）。
 * 縦に細い = モノラルに近い、横に広がる = ステレオ幅が大きい、横に寝る = 逆相成分が多い。
 * 下段の数値は表示中のフレームの位相相関（+1 同相 / 0 無相関 / −1 逆相）。
 */
export function Vectorscope({ read, active }: VectorscopeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [correlation, setCorrelation] = useState<number | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const g = canvas?.getContext('2d')
    if (!canvas || !g) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = PX * dpr
    canvas.height = PX * dpr
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const left = new Float32Array(SIZE)
    const right = new Float32Array(SIZE)
    const c = PX / 2
    const drawGrid = () => {
      g.fillStyle = '#060912'
      g.fillRect(0, 0, PX, PX)
      g.strokeStyle = 'rgba(120, 132, 190, 0.18)'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(c, 6)
      g.lineTo(c, PX - 6)
      g.moveTo(6, c)
      g.lineTo(PX - 6, c)
      g.moveTo(20, 20)
      g.lineTo(PX - 20, PX - 20)
      g.moveTo(PX - 20, 20)
      g.lineTo(20, PX - 20)
      g.stroke()
      g.fillStyle = 'rgba(120, 132, 190, 0.5)'
      g.font = '10px Consolas, monospace'
      g.fillText('M', c + 4, 14)
      g.fillText('L', 16, 16)
      g.fillText('R', PX - 22, 16)
      g.fillText('S', PX - 14, c - 4)
    }
    drawGrid()
    if (!active) return
    let id = 0
    let frame = 0
    const tick = () => {
      id = requestAnimationFrame(tick)
      if (!read(left, right)) return
      // 残像を残して軌跡を見やすくする
      g.fillStyle = 'rgba(6, 9, 18, 0.35)'
      g.fillRect(0, 0, PX, PX)
      drawGrid()
      g.fillStyle = 'rgba(167, 139, 250, 0.55)'
      let lr = 0
      let ll = 0
      let rr = 0
      const k = (PX / 2 - 8) * 0.9
      for (let i = 0; i < SIZE; i += 2) {
        const l = left[i]
        const r = right[i]
        lr += l * r
        ll += l * l
        rr += r * r
        const x = c + ((r - l) / Math.SQRT2) * k
        const y = c - ((l + r) / Math.SQRT2) * k
        g.fillRect(x, y, 1.4, 1.4)
      }
      if (++frame % 6 === 0) setCorrelation(ll > 1e-9 && rr > 1e-9 ? lr / Math.sqrt(ll * rr) : null)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [read, active])

  // 停止中は表示しない（前回の値を残さない）
  const corr = active ? correlation : null
  return (
    <div className="scope">
      <canvas ref={canvasRef} style={{ width: PX, height: PX }} role="img" aria-label="ベクトルスコープ（出力のステレオ像）" />
      <div className="scope__corr">
        <span>位相相関</span>
        <div className="corr-bar">
          <span style={{ left: `${(((corr ?? 0) + 1) / 2) * 100}%`, opacity: corr === null ? 0.25 : 1 }} />
        </div>
        <strong className={`mono${corr !== null && corr < 0 ? ' is-warn' : ''}`}>{corr === null ? '—' : corr.toFixed(2)}</strong>
      </div>
      <p className="scope__note">縦 = Mid（中央）／ 横 = Side（広がり）。出力（ORIGINAL 時は原音）を表示</p>
    </div>
  )
}
