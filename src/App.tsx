import { useCallback, useEffect, useState } from 'react'
import './App.css'
import { AppHeader, type ViewMode } from './components/AppHeader'
import { SimpleView } from './components/SimpleView'
import { StudioView } from './components/StudioView'
import { useAudioPlayer } from './hooks/useAudioPlayer'

/** 画面のモードは URL のハッシュ（#studio）で持つ（再読み込み・リンクで同じ画面を開ける。音源・設定は URL に入れない） */
const modeFromHash = (): ViewMode => (window.location.hash === '#studio' ? 'studio' : 'simple')

function App() {
  // 再生エンジン・DSP 設定・読み込んだファイル・書き出しの結果は 1 つ（SIMPLE / STUDIO で共通。モードの切替で作り直さない）
  const player = useAudioPlayer()
  const { audio, togglePlay, bypass, setBypass } = player
  const [mode, setModeState] = useState<ViewMode>(modeFromHash)

  const setMode = useCallback((next: ViewMode) => {
    setModeState(next)
    const url = next === 'studio' ? '#studio' : window.location.pathname + window.location.search
    window.history.replaceState(null, '', url)
  }, [])
  const openStudio = useCallback(() => setMode('studio'), [setMode])

  useEffect(() => {
    const onHash = () => setModeState(modeFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

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
      if (target?.closest('input, textarea, select, button, [role="button"], audio, video')) return
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
    <div className={`app app--${mode}`}>
      <AppHeader mode={mode} onModeChange={setMode} />
      {mode === 'simple' ? <SimpleView player={player} onOpenStudio={openStudio} /> : <StudioView player={player} />}
      <footer className="app-footer">
        <span>音源・動画はお使いのブラウザ内でのみ処理されます。サーバーや外部サービスへは送信されません。</span>
        <span className="mono">CINEMA SONIC X · SIMPLE / STUDIO (Phase 08)</span>
      </footer>
    </div>
  )
}

export default App
