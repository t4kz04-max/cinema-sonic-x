import { volumePercentToGain, type AudioPlayer } from '../hooks/useAudioPlayer'
import { formatDb, gainToDb } from '../utils/format'
import { VolumeIcon } from './Icons'
import { RangeControl } from './RangeControl'

/** モニター音量（再生のみ。書き出しには影響しない）。SIMPLE / STUDIO で同じ値を使う */
export function VolumeControl({ player, idPrefix }: { player: AudioPlayer; idPrefix: string }) {
  const { volume } = player
  const volumeDb = formatDb(gainToDb(volumePercentToGain(volume)))
  return (
    <div className="volume">
      <label htmlFor={`${idPrefix}-volume`} className="volume__label">
        <VolumeIcon /> 音量
      </label>
      <RangeControl
        id={`${idPrefix}-volume`}
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
  )
}
