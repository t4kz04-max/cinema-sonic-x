import { memo } from 'react'
import type { AudioPlayer } from '../hooks/useAudioPlayer'
import { platformLimits } from '../utils/platform'
import { EnhancementPanel } from './EnhancementPanel'
import { ExportPanel } from './ExportPanel'
import { PresetPanel } from './PresetPanel'
import { SourceInfoPanel } from './SourceInfoPanel'
import { MotionPanel, SpatialPanel, TailPanel } from './SpatialPanel'
import { SpectrumPanel } from './SpectrumPanel'
import { TransportPanel } from './TransportPanel'
import { UploadZone } from './UploadZone'
import { VideoPanel } from './VideoPanel'

/** セクションへのリンク（ページ内の移動だけ。状態は変えない） */
const SECTIONS: [string, string][] = [
  ['studio-input', 'INPUT'],
  ['studio-transport', 'PLAYER'],
  ['studio-preset', 'PRESET'],
  ['studio-spatial', 'SPATIAL'],
  ['studio-motion', 'MOTION'],
  ['studio-tail', 'TAIL'],
  ['studio-bass', 'BASS'],
  ['studio-export', 'EXPORT'],
]

/** STUDIO MODE: 重低音・空間・Motion・Tail・書き出しの詳細設定と測定の表示（Phase 07 までの画面を整理したもの） */
export const StudioView = memo(function StudioView({ player }: { player: AudioPlayer }) {
  const { audio, bypass } = player
  const limits = platformLimits()
  return (
    <div className="studio" data-view="studio">
      <nav className="studio-nav" aria-label="STUDIO のセクション">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} onClick={(e) => {
            // ハッシュ（#studio）を書き換えずにスクロールだけする
            e.preventDefault()
            document.getElementById(id)?.scrollIntoView({ block: 'start' })
          }}>
            {label}
          </a>
        ))}
      </nav>
      {limits.notice && <p className="notice">{limits.notice}</p>}
      <main className="console">
        <div className="console__col console__col--side">
          <UploadZone loadingName={player.loadingName} error={player.error} hasAudio={audio !== null} onFile={player.loadFile} onDismissError={player.clearError} />
          <SourceInfoPanel audio={audio} />
          <ExportPanel player={player} />
          <VideoPanel player={player} />
        </div>
        <div className="console__col console__col--main">
          <TransportPanel player={player} />
          <PresetPanel player={player} />
          <SpatialPanel player={player} />
          <MotionPanel player={player} />
          <TailPanel player={player} />
          <EnhancementPanel player={player} />
          <SpectrumPanel dsp={player.dsp} bypass={bypass || !player.bassEnabled} />
        </div>
      </main>
    </div>
  )
})
