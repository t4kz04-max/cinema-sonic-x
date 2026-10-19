import { Badge, Panel } from './Panel'

export function ExportPanel() {
  return (
    <Panel
      index="08"
      label="EXPORT"
      title="書き出し"
      className="panel--export"
      aside={<Badge tone="locked">Phase 06</Badge>}
    >
      <dl className="spec-list spec-list--compact">
        <div className="spec-list__row">
          <dt>出力形式</dt>
          <dd className="mono">WAV（PCM）</dd>
        </div>
        <div className="spec-list__row">
          <dt>処理場所</dt>
          <dd>このブラウザ内（OfflineAudioContext）</dd>
        </div>
      </dl>
      <button type="button" className="btn-export" disabled aria-describedby="export-note">
        WAVを書き出す
      </button>
      <p id="export-note" className="empty-note">
        WAV書き出しは未実装です（Phase 06 で実装予定）。
      </p>
    </Panel>
  )
}
