import { useEffect, useRef, useState } from 'react'
import { volumePercentToGain } from '../hooks/useAudioPlayer'

interface MediaCompareProps {
  kind: 'audio' | 'video'
  /** 書き出したファイル（Object URL） */
  exportedUrl: string
  /** 読み込んだ元のファイル（Object URL）。比較できない場合は null */
  originalUrl: string | null
  /** 再生エンジン（PROCESSED / ORIGINAL の試聴）が再生中。重ねて鳴らさないよう、こちらを止める */
  enginePlaying: boolean
  /** こちらを再生したら再生エンジンを止める */
  onPlay: () => void
  /** モニター音量（%）。初期の音量を再生エンジンとそろえる（控えめな初期設定） */
  volume: number
  /** ファイルの説明（下に表示） */
  note: string
}

type Which = 'exported' | 'original'

/** 要素の音量を ms かけて変える（切替の瞬間のクリック・急な音量差を避ける） */
function fadeVolume(el: HTMLMediaElement, to: number, ms: number): Promise<void> {
  const from = el.volume
  const t0 = performance.now()
  return new Promise((resolve) => {
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms)
      el.volume = from + (to - from) * k
      if (k < 1) requestAnimationFrame(step)
      else resolve()
    }
    step()
  })
}

const FADE_MS = 60

/**
 * 完成ファイル（EXPORTED）と元のファイル（ORIGINAL）を同じ時刻から切り替えて再生する。
 * 書き出したファイルそのものを再生する（再生用の DSP は通さない）。切替は 60 ms のフェードアウト → 同じ時刻から
 * フェードイン（書き出しは処理の遅延を先頭で切り捨ててあるので時刻がそろう）
 */
export function MediaCompare({ kind, exportedUrl, originalUrl, enginePlaying, onPlay, volume, note }: MediaCompareProps) {
  const exported = useRef<HTMLMediaElement | null>(null)
  const original = useRef<HTMLMediaElement | null>(null)
  const [which, setWhich] = useState<Which>('exported')
  const [unplayable, setUnplayable] = useState<Which | null>(null)
  const switching = useRef(false)

  // 初期の音量を再生エンジンのモニター音量にそろえる（音量スライダーの変更にも追従）
  useEffect(() => {
    const g = volumePercentToGain(volume)
    if (exported.current) exported.current.volume = g
    if (original.current) original.current.volume = g
  }, [volume, exportedUrl, originalUrl])

  // 再生エンジンで試聴を始めたら止める（二重に鳴らさない）
  useEffect(() => {
    if (!enginePlaying) return
    exported.current?.pause()
    original.current?.pause()
  }, [enginePlaying])

  const switchTo = async (next: Which) => {
    if (next === which || switching.current) return
    const from = which === 'exported' ? exported.current : original.current
    const to = next === 'exported' ? exported.current : original.current
    setWhich(next)
    if (!from || !to) return
    switching.current = true
    try {
      const playing = !from.paused
      const vol = from.volume
      if (playing) await fadeVolume(from, 0, FADE_MS)
      from.pause()
      from.volume = vol
      to.currentTime = Math.min(from.currentTime, Number.isFinite(to.duration) ? to.duration : from.currentTime)
      if (playing) {
        to.volume = 0
        await to.play().catch(() => undefined)
        await fadeVolume(to, vol, FADE_MS)
      } else to.volume = vol
    } finally {
      switching.current = false
    }
  }

  const common = (w: Which) => ({
    controls: true,
    preload: 'metadata' as const,
    hidden: which !== w,
    onPlay,
    onError: () => setUnplayable(w),
    'data-preview': w,
  })

  return (
    <div className="export-preview">
      <div className="ab-switch" role="radiogroup" aria-label="プレビューするファイル">
        <button type="button" role="radio" aria-checked={which === 'exported'} className={`ab-switch__item${which === 'exported' ? ' is-active' : ''}`} onClick={() => void switchTo('exported')}>
          EXPORTED
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={which === 'original'}
          disabled={!originalUrl}
          className={`ab-switch__item${which === 'original' ? ' is-active is-original' : ''}`}
          onClick={() => void switchTo('original')}
        >
          ORIGINAL
        </button>
      </div>
      {kind === 'video' ? (
        <>
          <video ref={(el) => void (exported.current = el)} className="video-preview" src={exportedUrl} {...common('exported')} />
          {originalUrl && <video ref={(el) => void (original.current = el)} className="video-preview" src={originalUrl} {...common('original')} />}
        </>
      ) : (
        <>
          <audio ref={(el) => void (exported.current = el)} src={exportedUrl} {...common('exported')} />
          {originalUrl && <audio ref={(el) => void (original.current = el)} src={originalUrl} {...common('original')} />}
        </>
      )}
      {unplayable && (
        <p className="output-stage__note is-warn">
          このブラウザは{unplayable === 'exported' ? '書き出したファイル' : '元のファイル'}の形式（コーデック）を再生できないため、プレビューできません。ファイルはダウンロードして対応するプレイヤーで再生してください。
        </p>
      )}
      <p className="output-stage__note">{note}</p>
    </div>
  )
}
