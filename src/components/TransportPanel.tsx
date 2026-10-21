import { memo } from 'react'
import type { AudioPlayer } from '../hooks/useAudioPlayer'
import { isTailActive, TAIL_MODE_DOCS } from '../audio/spatial/spatialSpec'
import { CutIcon, LoopIcon, PauseIcon, PlayIcon, StopIcon } from './Icons'
import { Badge, Panel } from './Panel'
import { PlaybackTimeline } from './PlaybackTimeline'
import { VolumeControl } from './VolumeControl'

interface TransportPanelProps {
  player: AudioPlayer
}

const STATUS_LABEL = { playing: '再生中', paused: '一時停止', stopped: '停止' } as const

type NodeKind = 'fixed' | 'process' | 'pending'

const SIGNAL_PATH: { name: string; kind: NodeKind; note?: string }[] = [
  { name: 'SOURCE', kind: 'fixed' },
  { name: 'HPF', kind: 'process' },
  { name: 'BASS EQ', kind: 'process' },
  { name: 'SUB EQ', kind: 'process' },
  { name: 'HARMONICS', kind: 'pending', note: '未実装・Phase 03' },
  { name: 'X-OVER 150Hz', kind: 'process' },
  { name: 'LOW COMP', kind: 'process' },
  { name: 'TRIM', kind: 'process' },
  { name: 'LIMITER', kind: 'process' },
  { name: 'VOLUME', kind: 'fixed' },
  { name: 'OUTPUT', kind: 'fixed' },
]

const FALLBACK_PATH: typeof SIGNAL_PATH = [
  ...SIGNAL_PATH.slice(0, 5),
  { name: 'TRIM', kind: 'process' },
  { name: 'PEAK COMP（簡易）', kind: 'process' },
  ...SIGNAL_PATH.slice(-2),
]

const SPATIAL_LABEL = { off: 'SPATIAL OFF', wide: 'SPATIAL: WIDE', cinema: 'SPATIAL: CINEMA', hall: 'SPATIAL: HALL' } as const

function nodeClass(kind: NodeKind, bypass: boolean): string {
  if (kind === 'pending') return 'is-pending'
  if (kind === 'process' && bypass) return 'is-off'
  return 'is-active'
}

export const TransportPanel = memo(function TransportPanel({ player }: TransportPanelProps) {
  const { audio, status, bypass, dsp, bassEnabled, spatialParams, loop } = player
  const bassPath = dsp?.dynamicsEngine === 'fallback' ? FALLBACK_PATH : SIGNAL_PATH
  // VOLUME / OUTPUT の手前に空間処理を入れて表示する
  const path = [
    ...bassPath.slice(0, -2).map((n) => (n.kind === 'process' && !bassEnabled ? { ...n, kind: 'pending' as const, note: undefined } : n)),
    { name: SPATIAL_LABEL[spatialParams.mode], kind: spatialParams.mode === 'off' ? ('pending' as const) : ('process' as const) },
    ...(isTailActive(spatialParams) && spatialParams.tailMode !== 'off'
      ? [{ name: `TAIL: ${TAIL_MODE_DOCS[spatialParams.tailMode].label}${spatialParams.dynamicTail ? ' + DYNAMIC' : ''}`, kind: 'process' as const }]
      : []),
    ...bassPath.slice(-2),
  ]
  const disabled = !audio

  return (
    <Panel
      index="03"
      id="studio-transport"
      label="TRANSPORT"
      title="プレイヤー"
      className="panel--transport"
      aside={
        <>
          {bypass ? <Badge tone="idle">ORIGINAL：原音</Badge> : <Badge tone="pending">PROCESSED</Badge>}
          <Badge tone={status === 'playing' ? 'live' : 'idle'}>{STATUS_LABEL[status]}</Badge>
        </>
      }
    >
      <PlaybackTimeline player={player} idPrefix="studio" />

      <div className="transport-row">
        <div className="ab-switch" role="radiogroup" aria-label="試聴する音（B キーで切替）">
          <button type="button" role="radio" aria-checked={bypass} className={`ab-switch__item${bypass ? ' is-active is-original' : ''}`} onClick={() => player.setBypass(true)}>
            ORIGINAL
          </button>
          <button type="button" role="radio" aria-checked={!bypass} className={`ab-switch__item${!bypass ? ' is-active' : ''}`} onClick={() => player.setBypass(false)}>
            PROCESSED
          </button>
        </div>
        <div className="transport-buttons">
          <button
            type="button"
            className="btn-round btn-round--secondary"
            onClick={player.cut}
            disabled={disabled}
            aria-label="CUT（直接音と余韻を止める）"
            title="CUT: 直接音と余韻の両方を止めて先頭へ"
          >
            <CutIcon />
          </button>
          <button
            type="button"
            className="btn-round btn-round--secondary"
            onClick={player.stop}
            disabled={disabled}
            aria-label="停止（余韻を残す）"
            title="STOP: 直接音を止めて先頭へ（残響の余韻は残す）"
          >
            <StopIcon />
          </button>
          <button
            type="button"
            className="btn-round btn-round--primary"
            onClick={player.togglePlay}
            disabled={disabled}
            aria-label={status === 'playing' ? '一時停止' : '再生'}
            title={status === 'playing' ? '一時停止（Space）' : '再生（Space）'}
          >
            {status === 'playing' ? <PauseIcon size={28} /> : <PlayIcon size={28} />}
          </button>
          <button
            type="button"
            className={`btn-round btn-round--secondary loop-btn${loop.enabled ? ' is-active' : ''}`}
            onClick={() => player.setLoop({ enabled: !loop.enabled })}
            disabled={disabled}
            aria-pressed={loop.enabled}
            aria-label={`LOOP ${loop.enabled ? 'ON' : 'OFF'}`}
            title={`LOOP（${loop.type === 'normal' ? 'NORMAL' : 'SPATIAL'}）: ${loop.enabled ? 'ON' : 'OFF'}。種類は空間音響パネルで切替`}
          >
            <LoopIcon />
            {loop.enabled && <span className="loop-btn__type">{loop.type === 'normal' ? 'N' : 'S'}</span>}
          </button>
        </div>

        <VolumeControl player={player} idPrefix="studio" />
      </div>

      <div className="signal-path" aria-label="現在の信号経路">
        <span className="signal-path__title">SIGNAL PATH{bypass && ' — ORIGINAL（全段 BYPASS）'}</span>
        <ol>
          {path.map((node) => (
            <li key={node.name} className={nodeClass(node.kind, bypass)}>
              <span>{node.name}</span>
              {node.note && <small>{node.note}</small>}
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  )
})
