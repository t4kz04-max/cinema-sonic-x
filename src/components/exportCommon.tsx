import { STAGE_LABEL, type UiStage } from './exportLabels'

interface StageTrackProps {
  stages: readonly UiStage[]
  /** 実行中の段階。完了したときは 'complete' */
  current: UiStage | 'complete'
  /** 実行中の段階の進み具合（0〜1、測れる段階だけ） */
  fraction?: number
  fractionLabel?: string
}

/**
 * 書き出しの段階（PREPARING → RENDERING → ENCODING →（MUXING）→ COMPLETE）。
 * 進み具合は実際に測った値だけを出す（推定のアニメーションは使わない。CPU 負荷も増やさない）
 */
export function StageTrack({ stages, current, fraction, fractionLabel }: StageTrackProps) {
  const idx = current === 'complete' ? stages.length : stages.indexOf(current)
  return (
    <div className="export-progress" role="status" aria-live="polite">
      <ol className="export-stages">
        {stages.map((s, i) => (
          <li key={s} className={i < idx ? 'is-done' : i === idx ? 'is-current' : ''} data-stage={s}>
            {STAGE_LABEL[s]}
          </li>
        ))}
        <li className={current === 'complete' ? 'is-current is-complete' : ''} data-stage="complete">
          COMPLETE
        </li>
      </ol>
      {current !== 'complete' && fraction !== undefined && (
        <>
          <div className="export-bar">
            <span style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
          </div>
          {fractionLabel && (
            <p className="output-stage__note mono">
              {fractionLabel} {(fraction * 100).toFixed(0)}%
            </p>
          )}
        </>
      )}
    </div>
  )
}

/** 失敗の表示（原因と、もう一度試す方法） */
export function ExportError({ message, detail, onRetry, retryLabel }: { message: string; detail?: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div className="alert alert--export" role="alert">
      <div className="alert__body">
        <p className="alert__title">{message}</p>
        {detail && <p className="alert__detail">{detail}</p>}
        <p className="alert__detail">{retryHint(message, detail)}</p>
        {onRetry && (
          <button type="button" className="btn-chip" onClick={onRetry}>
            {retryLabel ?? 'もう一度書き出す'}
          </button>
        )}
      </div>
    </div>
  )
}

/** 失敗の種類ごとの再試行の方法 */
function retryHint(message: string, detail?: string): string {
  const text = `${message} ${detail ?? ''}`
  if (/待ってから/.test(text)) return '再試行: 表示された秒数だけ待ってから、もう一度書き出してください。'
  if (/メモリ/.test(text)) return '再試行: 他のタブ・アプリを閉じる、短い音源・小さい動画にする、または 24-bit を 16-bit にしてから、もう一度書き出してください。'
  if (/止まった|HRTF/.test(text)) return '再試行: そのまま「もう一度書き出す」を押してください。繰り返し止まる場合はページを読み込み直してください（読み込んだファイル・設定は読み込み直すと消えます）。'
  return '再試行: もう一度書き出してください。繰り返し失敗する場合は、別のプリセット・別のファイルで試すか、ページを読み込み直してください。'
}
