import { useState } from 'react'
import type { AudioPlayer } from '../hooks/useAudioPlayer'
import { volumePercentToGain } from '../hooks/useAudioPlayer'
import { formatDb, formatTime, gainToDb } from '../utils/format'
import { PauseIcon, PlayIcon, StopIcon, VolumeIcon } from './Icons'
import { Badge, Panel } from './Panel'
import { RangeControl } from './RangeControl'
import { Waveform } from './Waveform'

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

function nodeClass(kind: NodeKind, bypass: boolean): string {
  if (kind === 'pending') return 'is-pending'
  if (kind === 'process' && bypass) return 'is-off'
  return 'is-active'
}

export function TransportPanel({ player }: TransportPanelProps) {
  const { audio, status, position, duration, volume, bypass, dsp } = player
  const path = dsp?.dynamicsEngine === 'fallback' ? FALLBACK_PATH : SIGNAL_PATH
  // シークバーのドラッグ中は表示だけ更新し、離した時点でシークする（ソース再生成によるノイズ防止）
  const [scrub, setScrub] = useState<number | null>(null)
  const shown = scrub ?? position
  const disabled = !audio
  const volumeDb = formatDb(gainToDb(volumePercentToGain(volume)))

  const commitScrub = () => {
    if (scrub === null) return
    player.seek(scrub)
    setScrub(null)
  }

  return (
    <Panel
      index="03"
      label="TRANSPORT"
      title="プレイヤー"
      className="panel--transport"
      aside={
        <>
          {bypass ? <Badge tone="idle">BYPASS：原音</Badge> : <Badge tone="pending">処理音・{player.bassParams.mode === 'extreme' ? 'EXTREME' : 'NORMAL'}</Badge>}
          <Badge tone={status === 'playing' ? 'live' : 'idle'}>{STATUS_LABEL[status]}</Badge>
        </>
      }
    >
      <div className="time-display" aria-live="off">
        <span className="time-display__current mono">{formatTime(shown, true)}</span>
        <span className="time-display__sep">/</span>
        <span className="time-display__total mono">{formatTime(duration, true)}</span>
      </div>

      <Waveform
        buffer={audio?.buffer ?? null}
        progress={duration > 0 ? shown / duration : 0}
        onSeekRatio={(r) => player.seek(r * duration)}
      />

      <RangeControl
        id="seek"
        className="range--seek"
        min={0}
        max={duration || 1}
        step={0.01}
        value={shown}
        disabled={disabled}
        ariaLabel="再生位置"
        ariaValueText={`${formatTime(shown)} / ${formatTime(duration)}`}
        onChange={setScrub}
        onCommit={commitScrub}
      />

      <div className="transport-row">
        <div className="transport-buttons">
          <button
            type="button"
            className="btn-round btn-round--secondary"
            onClick={player.stop}
            disabled={disabled}
            aria-label="停止"
            title="停止（先頭に戻る）"
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
        </div>

        <div className="volume">
          <label htmlFor="volume" className="volume__label">
            <VolumeIcon /> 音量
          </label>
          <RangeControl
            id="volume"
            className="range--volume"
            min={0}
            max={100}
            step={1}
            value={volume}
            ariaLabel="音量"
            ariaValueText={`${volume}%（${volumeDb}）`}
            onChange={player.setVolume}
          />
          <span className="volume__value mono">
            {volume}%<small>{volumeDb}</small>
          </span>
        </div>
      </div>

      <div className="signal-path" aria-label="現在の信号経路">
        <span className="signal-path__title">SIGNAL PATH{bypass && ' — BYPASS'}</span>
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
}
