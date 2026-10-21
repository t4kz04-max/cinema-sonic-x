import { useState } from 'react'
import { usePlaybackClock } from '../hooks/playbackClock'
import type { AudioPlayer } from '../hooks/useAudioPlayer'
import { formatTime } from '../utils/format'
import { RangeControl } from './RangeControl'
import { Waveform } from './Waveform'

interface PlaybackTimelineProps {
  player: AudioPlayer
  /** 波形を表示する（SIMPLE MODE でも表示する。波形のピークは音源ごとに 1 回だけ計算） */
  waveform?: boolean
  idPrefix: string
}

/**
 * 再生時刻・波形・シークバー。再生位置を購読するのはこの部品だけ（再生中に他のパネルを再描画しない）。
 * シークバーのドラッグ中は表示だけ更新し、離した時点でシークする（ソース再生成によるノイズ防止）
 */
export function PlaybackTimeline({ player, waveform = true, idPrefix }: PlaybackTimelineProps) {
  const { position } = usePlaybackClock(player.clock)
  const { audio, duration } = player
  const [scrub, setScrub] = useState<number | null>(null)
  const shown = scrub ?? position

  const commitScrub = () => {
    if (scrub === null) return
    player.seek(scrub)
    setScrub(null)
  }

  return (
    <>
      <div className="time-display" aria-live="off">
        <span className="time-display__current mono" data-ui="position">
          {formatTime(shown, true)}
        </span>
        <span className="time-display__sep">/</span>
        <span className="time-display__total mono">{formatTime(duration, true)}</span>
      </div>

      {waveform && <Waveform buffer={audio?.buffer ?? null} progress={duration > 0 ? shown / duration : 0} onSeekRatio={(r) => player.seek(r * duration)} />}

      <RangeControl
        id={`${idPrefix}-seek`}
        className="range--seek"
        min={0}
        max={duration || 1}
        step={0.01}
        value={shown}
        disabled={!audio}
        ariaLabel="再生位置"
        ariaValueText={`${formatTime(shown)} / ${formatTime(duration)}`}
        onChange={setScrub}
        onCommit={commitScrub}
      />
    </>
  )
}
