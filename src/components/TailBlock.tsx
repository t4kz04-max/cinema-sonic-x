import { useEffect, useState } from 'react'
import type { ActiveTailMode, TailMode } from '../audio/spatial/tailImpulse'
import {
  isTailActive,
  TAIL_CAVEATS,
  TAIL_MODE_DOCS,
  TAIL_PARAM_DOCS,
  TAIL_PROCESSING,
  tailSettings,
  tailSupported,
  type SpatialParams,
} from '../audio/spatial/spatialSpec'
import type { AudioPlayer } from '../hooks/useAudioPlayer'
import { formatTime } from '../utils/format'
import { RangeControl } from './RangeControl'

interface TailBlockProps {
  player: AudioPlayer
}

const TAIL_MODES: TailMode[] = ['off', 'natural', 'distance', 'ripple']

const TAIL_SLIDERS: { key: 'tailLength' | 'tailIntensity'; label: string }[] = [
  { key: 'tailLength', label: 'TAIL LENGTH' },
  { key: 'tailIntensity', label: 'TAIL INTENSITY' },
]

const signed = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`

/** Dynamic Tail・蓄積防止の現在の減衰（ワークレットからの通知をそのまま表示。再生中のみ更新） */
function TailMeter({ player }: TailBlockProps) {
  const [r, setR] = useState<{ duckDb: number; guardDb: number } | null>(null)
  const playing = player.status === 'playing'
  const { readTail } = player
  useEffect(() => {
    if (!playing) return
    let id = 0
    let frame = 0
    const tick = () => {
      id = requestAnimationFrame(tick)
      if (++frame % 6 !== 0) return
      const t = readTail()
      if (t) setR({ duckDb: t.duckDb, guardDb: t.guardDb })
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [playing, readTail])
  return (
    <span className="tail-meter mono" title="Dynamic Tail（演奏の密度による減衰）・蓄積防止による残響の減衰（DSP の実測値）">
      {r ? `残響 ${signed(r.duckDb + r.guardDb)} dB（Dynamic ${signed(r.duckDb)} / 蓄積防止 ${signed(r.guardDb)}）` : '残響の減衰: —（再生中に表示）'}
    </span>
  )
}

function sliderValue(key: 'tailLength' | 'tailIntensity', p: SpatialParams): string {
  const s = tailSettings(p)
  return key === 'tailLength' ? `RT60 ${s.rt60.toFixed(2)} 秒` : `残響 ${signed(s.gainDb)} dB`
}

export function TailBlock({ player }: TailBlockProps) {
  const { spatialParams: p, dsp, loop, musicRegion } = player
  const supported = tailSupported(p.mode)
  const active = isTailActive(p)
  const dynamicAvailable = dsp?.spatial.tailEngine !== 'fallback'
  const modeKey: ActiveTailMode | null = p.tailMode === 'off' ? null : p.tailMode
  return (
    <div className={`motion-block tail-block${active ? ' is-active' : ''}`}>
      <div className="motion-block__head">
        <div>
          <p className="motion-block__title">SPATIAL TAIL</p>
          <p className="motion-block__sub">
            {supported
              ? '音が鳴り終わった後の余韻の広がり・遠ざかり・消え方を制御する。OFF は既存の動作（HALL の余韻はそのまま）'
              : 'Spatial Tail は CINEMA / HALL で使用できます'}
          </p>
        </div>
      </div>

      <div className="motion-presets tail-modes" role="radiogroup" aria-label="SPATIAL TAIL">
        {TAIL_MODES.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={p.tailMode === id}
            disabled={!supported}
            className={`spatial-mode motion-preset${p.tailMode === id ? ' is-active' : ''}`}
            onClick={() => player.setSpatialParams({ tailMode: id })}
          >
            <span className="spatial-mode__label">{id === 'off' ? 'OFF' : TAIL_MODE_DOCS[id].label}</span>
            <small>{id === 'off' ? '既存の動作（HALL は既存の後期残響）' : TAIL_MODE_DOCS[id].summary}</small>
          </button>
        ))}
      </div>

      <div className="motion-controls tail-controls">
        {TAIL_SLIDERS.map(({ key, label }) => (
          <div className={`spatial-param${!active ? ' is-disabled' : ''}`} key={key}>
            <div className="spatial-param__head">
              <label htmlFor={`tail-${key}`}>{label}</label>
              <span className="mono">
                {p[key]}%<small> {sliderValue(key, p)}</small>
              </span>
            </div>
            <RangeControl
              id={`tail-${key}`}
              min={0}
              max={100}
              step={1}
              value={p[key]}
              disabled={!supported}
              ariaLabel={label}
              onChange={(v) => player.setSpatialParams({ [key]: v } as Partial<SpatialParams>)}
            />
            <p className="spatial-param__desc">{TAIL_PARAM_DOCS[key]}</p>
          </div>
        ))}
        <div className="tail-row">
          <button
            type="button"
            className={`bypass-btn engine-btn${p.dynamicTail ? ' is-enabled' : ''}`}
            aria-pressed={p.dynamicTail}
            disabled={!active || !dynamicAvailable}
            onClick={() => player.setSpatialParams({ dynamicTail: !p.dynamicTail })}
          >
            <span className="bypass-btn__led" aria-hidden="true" />
            <span className="bypass-btn__label">DYNAMIC TAIL</span>
            <span className="bypass-btn__state">{!dynamicAvailable ? '利用不可（AudioWorklet なし）' : p.dynamicTail ? 'ON' : 'OFF'}</span>
          </button>
          {active && <TailMeter player={player} />}
        </div>
        <p className="spatial-param__desc">{TAIL_PARAM_DOCS.dynamicTail}</p>
        {modeKey && (
          <p className="spatial-param__desc motion-preset-detail">
            <strong>{TAIL_MODE_DOCS[modeKey].label}:</strong> {TAIL_MODE_DOCS[modeKey].detail}
          </p>
        )}
      </div>

      <div className="tail-row tail-loop">
        <button
          type="button"
          className={`bypass-btn engine-btn${loop.enabled ? ' is-enabled' : ''}`}
          aria-pressed={loop.enabled}
          disabled={!player.audio}
          onClick={() => player.setLoop({ enabled: !loop.enabled })}
        >
          <span className="bypass-btn__led" aria-hidden="true" />
          <span className="bypass-btn__label">LOOP</span>
          <span className="bypass-btn__state">{loop.enabled ? 'ON' : 'OFF'}</span>
        </button>
        <div className="ab-switch" role="radiogroup" aria-label="LOOP TYPE">
          {(['normal', 'spatial'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={loop.type === t}
              className={`ab-switch__item${loop.type === t ? ' is-active' : ''}`}
              onClick={() => player.setLoop({ type: t })}
            >
              {t === 'normal' ? 'NORMAL' : 'SPATIAL'}
            </button>
          ))}
        </div>
        <p className="spatial-param__desc">
          {loop.type === 'normal'
            ? 'NORMAL: ファイル全体を繰り返す。境界で前回の後期残響を 80 ms で消し、毎回同じ状態から始める'
            : `SPATIAL: 音楽が鳴っている区間（${musicRegion ? `${formatTime(musicRegion.start, true)}〜${formatTime(musicRegion.end, true)}` : '無音の判定なし = ファイル全体'}）を繰り返し、前回の余韻を残したまま次の冒頭を重ねる`}
        </p>
      </div>

      <div className="spatial-doc">
        <div>
          <p className="spatial-doc__title">Spatial Tail の処理内容</p>
          <ol>
            {TAIL_PROCESSING.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ol>
        </div>
        <div>
          <p className="spatial-doc__title">停止・ループと既知の制限</p>
          <ul>
            <li>STOP: 直接音を 12 ms でフェードアウトし、反射音・残響の余韻は自然に消えるまで残す</li>
            <li>PAUSE: 位置を保持して出力を 20 ms で止め、残響を消す（再開時に前の残響は鳴らない）</li>
            <li>CUT: 直接音と余韻の両方を 20 ms で止めて先頭へ</li>
            {TAIL_CAVEATS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
