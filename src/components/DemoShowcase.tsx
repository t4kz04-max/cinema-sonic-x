import { memo, useCallback } from 'react'
import { demoOfSource, sectionIndexAt, SPATIAL_SHOWCASE } from '../demo/demoSpec'
import { usePlaybackSelector } from '../hooks/playbackClock'
import type { AudioPlayer } from '../hooks/useAudioPlayer'
import { formatBytes } from '../utils/format'

const fmtSec = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/**
 * 「サンプル音源で試す」。押したときだけ同じサイトからデモ音源を取得する（最初の表示では取得しない）。
 * 読み込んだ後は、元のデモ音源（加工なし）のダウンロードも出す（公式デモ音源であることを明記）
 */
export const DemoOffer = memo(function DemoOffer({ player, compact = false }: { player: AudioPlayer; compact?: boolean }) {
  const demo = SPATIAL_SHOWCASE
  const loaded = demoOfSource(player.audio?.source)
  const loading = player.loadingName !== null
  const { loadDemo } = player
  const onClick = useCallback(() => void loadDemo(demo.id), [loadDemo, demo.id])
  return (
    <div className={`demo-offer${compact ? ' demo-offer--compact' : ''}${loaded ? ' is-loaded' : ''}`} data-ui="demo-offer">
      {!compact && <p className="demo-offer__lead">ファイルが手元にない場合は</p>}
      <button type="button" className="demo-offer__btn" data-ui="demo-load" onClick={onClick} disabled={loading} aria-describedby={compact ? undefined : 'demo-offer-sub'}>
        <span className="demo-offer__btn-main">{loaded ? 'サンプル音源を読み込み直す' : 'サンプル音源で試す'}</span>
        <span className="demo-offer__btn-sub">
          {demo.title} · {demo.durationSeconds} 秒 · 約 {formatBytes(demo.approxBytes)}
        </span>
      </button>
      {!compact && (
        <p className="demo-offer__note" id="demo-offer-sub">
          {demo.description}。押したときだけこのサイトから取得します（お使いの音声はどこにも送信しません）。
        </p>
      )}
      {loaded && player.originalUrl && (
        <p className="demo-offer__note" data-ui="demo-original">
          公式デモ音源を読み込み中です。{' '}
          <a className="link-btn" href={player.originalUrl} download={loaded.fileName}>
            元のデモ音源（加工なし・公式デモ音源）をダウンロード
          </a>
        </p>
      )}
    </div>
  )
})

/**
 * デモ音源の区間（Intro / Groove / Main / Space / Outro）。音源は 1 つのまま、押すとその区間の先頭へシークする。
 * 再生中の区間は再生位置から求め、区間が変わったときだけ再描画する（毎フレーム再描画しない）
 */
export const DemoSections = memo(function DemoSections({ player }: { player: AudioPlayer }) {
  const demo = demoOfSource(player.audio?.source)
  const sections = demo?.sections ?? null
  const active = usePlaybackSelector(player.clock, (v) => (sections ? sectionIndexAt(sections, v.position) : -1))
  const { seek } = player
  if (!demo || !sections) return null
  return (
    <div className="demo-sections" data-ui="demo-sections">
      <p className="demo-sections__title">
        <span className="demo-sections__badge">公式デモ</span>
        {demo.title} の区間（押すとその位置へ移動）
      </p>
      <ol className="demo-sections__list" aria-label={`${demo.title} の区間`}>
        {sections.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              className={`demo-section${i === active ? ' is-active' : ''}`}
              data-section={s.id}
              aria-current={i === active ? 'true' : undefined}
              aria-label={`${s.label}（${fmtSec(s.start)}〜${fmtSec(s.end)}）${s.focus}。この位置へ移動`}
              onClick={() => seek(s.start)}
            >
              <span className="demo-section__label">{s.label}</span>
              <span className="demo-section__time mono">
                {fmtSec(s.start)}–{fmtSec(s.end)}
              </span>
              <span className="demo-section__focus">{s.focus}</span>
            </button>
          </li>
        ))}
      </ol>
      <p className="demo-sections__note">区間は曲の構成の目安です。方向や広がりの聞こえ方には個人差があります。</p>
    </div>
  )
})
