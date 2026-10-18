import { useEffect, useMemo, useRef } from 'react'
import { logFrequencies } from '../audio/eqResponse'
import { bandLevelDb, smoothedSpectrumDb, SUMMARY_BANDS, thirdOctaveLevelsDb } from '../audio/spectrum'
import { useElementSize } from '../hooks/useElementSize'
import type { DspStatus } from '../types/audio'
import { Badge, Panel } from './Panel'

interface SpectrumPanelProps {
  dsp: DspStatus | null
  bypass: boolean
}

const F_MIN = 20
const F_MAX = 10000
const RANGE_DB = 60
const FREQS = logFrequencies(360, F_MIN, F_MAX)
const GRID_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
const LOW_CENTERS = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200]
const BAR_RANGE_DB = 15

const COLORS = {
  before: 'rgba(160, 170, 210, 0.85)',
  after: '#a78bfa',
  afterFill: 'rgba(167, 139, 250, 0.16)',
  lowZone: 'rgba(56, 189, 248, 0.06)',
  grid: 'rgba(120, 132, 190, 0.14)',
  label: '#4f5878',
}

const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
const formatFreq = (f: number) => (f >= 1000 ? `${f / 1000}k` : `${f}`)

export function SpectrumPanel({ dsp, bypass }: SpectrumPanelProps) {
  const [wrapRef, size] = useElementSize<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const spectra = dsp?.spectra ?? null

  const curves = useMemo(() => {
    if (!spectra) return null
    return {
      before: smoothedSpectrumDb(spectra.before, FREQS, 6),
      after: smoothedSpectrumDb(spectra.after, FREQS, 6),
    }
  }, [spectra])

  const lowDeltas = useMemo(() => {
    if (!spectra) return null
    const b = thirdOctaveLevelsDb(spectra.before, LOW_CENTERS)
    const a = thirdOctaveLevelsDb(spectra.after, LOW_CENTERS)
    return LOW_CENTERS.map((f, i) => ({ f, delta: a[i] - b[i] }))
  }, [spectra])

  const summary = useMemo(() => {
    if (!spectra) return null
    return SUMMARY_BANDS.map((band) => ({
      ...band,
      delta: bandLevelDb(spectra.after, band.lo, band.hi) - bandLevelDb(spectra.before, band.lo, band.hi),
    }))
  }, [spectra])

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
    g.fillStyle = COLORS.lowZone
    g.fillRect(0, 0, x(200), h)
    g.font = '10px Consolas, monospace'
    for (const f of GRID_FREQS) {
      g.fillStyle = COLORS.grid
      g.fillRect(Math.round(x(f)), 0, 1, h)
      g.fillStyle = COLORS.label
      g.fillText(formatFreq(f), Math.min(x(f) + 3, w - 24), h - 4)
    }
    g.fillStyle = 'rgba(56, 189, 248, 0.6)'
    g.fillText('20–200 Hz', 6, 14)
    if (!curves) return

    const top = Math.ceil(Math.max(...curves.before, ...curves.after) / 6) * 6 + 3
    const y = (v: number) => ((top - v) / RANGE_DB) * h
    for (let v = top - 3; v > top - RANGE_DB; v -= 12) {
      g.fillStyle = COLORS.grid
      g.fillRect(0, Math.round(y(v)), w, 1)
      g.fillStyle = COLORS.label
      g.fillText(`${v} dB`, w - 44, y(v) - 3)
    }
    const path = (values: Float32Array) => {
      g.beginPath()
      values.forEach((v, i) => {
        const px = x(FREQS[i])
        const py = y(v)
        if (i === 0) g.moveTo(px, py)
        else g.lineTo(px, py)
      })
    }
    path(curves.after)
    g.lineTo(w, h)
    g.lineTo(0, h)
    g.closePath()
    g.fillStyle = COLORS.afterFill
    g.fill()
    path(curves.before)
    g.strokeStyle = COLORS.before
    g.lineWidth = 1.25
    g.stroke()
    path(curves.after)
    g.strokeStyle = COLORS.after
    g.lineWidth = 2
    g.stroke()
  }, [curves, size])

  const status = dsp?.analysis ?? 'idle'

  return (
    <Panel
      index="06"
      label="ANALYZER"
      title="重低音エンジン: 処理前後のスペクトル比較"
      className="panel--spectrum"
      aside={
        status === 'measuring' ? (
          <Badge tone="pending">計測中…</Badge>
        ) : spectra ? (
          <Badge tone="live">解析済み</Badge>
        ) : (
          <Badge tone="idle">{status === 'silent' ? '無音' : '未解析'}</Badge>
        )
      }
    >
      <div className="spectrum">
        <div className="spectrum__plot" ref={wrapRef}>
          <canvas ref={canvasRef} style={{ width: size.width, height: size.height }} role="img" aria-label="処理前後の平均スペクトル" />
          {!spectra && <span className="spectrum__empty">{status === 'silent' ? '無音のためスペクトルなし' : '音源を読み込むと処理前後のスペクトルを表示します'}</span>}
        </div>
        <ul className="eq-legend">
          <li style={{ color: COLORS.before }}>処理前（原音）</li>
          <li style={{ color: COLORS.after }}>処理後（現在の設定）</li>
          <li className="eq-legend__note">
            曲の抜粋（最大 30 秒）を実際の処理グラフでオフライン処理した平均スペクトル（1/6 oct 平滑）{bypass && '。BYPASS 中も処理ON時の結果を表示しています'}
          </li>
        </ul>
      </div>

      <div className="low-bars" aria-label="20〜200 Hz の 1/3 オクターブ帯域ごとの変化">
        <p className="low-bars__title">20–200 Hz の変化（1/3 オクターブ）</p>
        <div className="low-bars__grid">
          {(lowDeltas ?? LOW_CENTERS.map((f) => ({ f, delta: 0 }))).map(({ f, delta }) => {
            const ratio = Math.min(Math.abs(delta) / BAR_RANGE_DB, 1) * 50
            return (
              <div className="low-bar" key={f}>
                <span className="low-bar__value mono">{lowDeltas ? signed(delta) : '—'}</span>
                <div className="low-bar__track">
                  <span
                    className={delta >= 0 ? 'is-up' : 'is-down'}
                    style={delta >= 0 ? { bottom: '50%', height: `${ratio}%` } : { top: '50%', height: `${ratio}%` }}
                  />
                </div>
                <span className="low-bar__freq mono">{f}</span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="band-summary">
        {(summary ?? SUMMARY_BANDS.map((b) => ({ ...b, delta: NaN }))).map((b) => (
          <div className={`band-chip${b.delta > 0.5 ? ' is-up' : b.delta < -0.5 ? ' is-down' : ''}`} key={b.id}>
            <span>{b.label}</span>
            <strong className="mono">{Number.isFinite(b.delta) ? `${signed(b.delta)} dB` : '—'}</strong>
          </div>
        ))}
      </div>
    </Panel>
  )
}
