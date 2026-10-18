import { LockIcon } from './Icons'

export function AppHeader() {
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
          <p className="brand__tagline">ブラウザ完結型 重低音強化プロセッサー</p>
        </div>
      </div>
      <div className="app-header__meta">
        <span className="meta-chip meta-chip--secure" title="音源はこのブラウザ内でのみ処理され、外部へ送信されません">
          <LockIcon /> ローカル処理のみ・外部送信なし
        </span>
        <span className="meta-chip">PHASE 02.5 / 開発版</span>
      </div>
    </header>
  )
}
