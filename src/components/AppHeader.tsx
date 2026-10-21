import { LockIcon } from './Icons'

export type ViewMode = 'simple' | 'studio'

interface AppHeaderProps {
  mode: ViewMode
  onModeChange: (mode: ViewMode) => void
}

export function AppHeader({ mode, onModeChange }: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="brand">
        <div className="brand__mark" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <div>
          <h1 className="brand__name">
            CINEMA SONIC <span className="brand__x">X</span>
          </h1>
          <p className="brand__tagline">ブラウザ完結型 立体音響・重低音プロセッサー</p>
        </div>
      </div>
      {/* 画面のモードは表示だけを切り替える（再生エンジン・DSP 設定・読み込んだファイル・書き出しの結果は共通） */}
      <div className="mode-toggle" role="radiogroup" aria-label="画面のモード">
        <button type="button" role="radio" aria-checked={mode === 'simple'} data-mode="simple" className={`mode-toggle__item${mode === 'simple' ? ' is-active' : ''}`} onClick={() => onModeChange('simple')}>
          SIMPLE<small>かんたん</small>
        </button>
        <button type="button" role="radio" aria-checked={mode === 'studio'} data-mode="studio" className={`mode-toggle__item${mode === 'studio' ? ' is-active' : ''}`} onClick={() => onModeChange('studio')}>
          STUDIO<small>詳細設定</small>
        </button>
      </div>
      <div className="app-header__meta">
        <span className="meta-chip meta-chip--secure" title="音源はこのブラウザ内でのみ処理され、外部へ送信されません">
          <LockIcon /> ローカル処理のみ・外部送信なし
        </span>
        <span className="meta-chip">開発版</span>
      </div>
    </header>
  )
}
