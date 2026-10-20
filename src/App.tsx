import { useEffect } from 'react'
import './App.css'
import { AppHeader } from './components/AppHeader'
import { EnhancementPanel } from './components/EnhancementPanel'
import { ExportPanel } from './components/ExportPanel'
import { PresetPanel } from './components/PresetPanel'
import { VideoPanel } from './components/VideoPanel'
import { SourceInfoPanel } from './components/SourceInfoPanel'
import { SpatialPanel } from './components/SpatialPanel'
import { SpectrumPanel } from './components/SpectrumPanel'
import { TransportPanel } from './components/TransportPanel'
import { UploadZone } from './components/UploadZone'
import { useAudioPlayer } from './hooks/useAudioPlayer'

function App() {
  const player = useAudioPlayer()
  const { audio, togglePlay, bypass, setBypass } = player

  // Space: 再生/一時停止、B: ORIGINAL / PROCESSED 切替。フォーカス中のボタンやスライダーの標準操作とは重複させない
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      // window や document が target の場合もあるため Element に限定する
      const target = e.target instanceof Element ? e.target : null
      if (e.code === 'KeyB') {
        if (target?.closest('textarea, input[type="text"]')) return
        e.preventDefault()
        setBypass(!bypass)
        return
      }
      if (e.code !== 'Space' || !audio) return
      if (target?.closest('input, textarea, select, button, [role="button"]')) return
      e.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [audio, togglePlay, bypass, setBypass])

  // ウィンドウ全体へのドロップでブラウザがファイルを開いてしまうのを防ぐ
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  return (
    <div className="app">
      <AppHeader />
      <main className="console">
        <div className="console__col console__col--side">
          <UploadZone
            loadingName={player.loadingName}
            error={player.error}
            hasAudio={audio !== null}
            onFile={(file) => void player.loadFile(file)}
            onDismissError={player.clearError}
          />
          <SourceInfoPanel audio={audio} />
          <ExportPanel player={player} />
          <VideoPanel player={player} />
        </div>
        <div className="console__col console__col--main">
          <TransportPanel player={player} />
          <PresetPanel player={player} />
          <SpatialPanel player={player} />
          <EnhancementPanel player={player} />
          <SpectrumPanel dsp={player.dsp} bypass={bypass || !player.bassEnabled} />
        </div>
      </main>
      <footer className="app-footer">
        <span>音源はお使いのブラウザ内でのみ処理されます。サーバーや外部サービスへは送信されません。</span>
        <span className="mono">CINEMA SONIC X · Video (Phase 07)</span>
      </footer>
    </div>
  )
}

export default App
