import { useRef, useState } from 'react'
import { estimateExportBytes, exportMemoryBudget, reverbTailSeconds } from '../audio/export/exportSpec'
import { wavDataBytes, type WavBitDepth } from '../audio/export/wavEncoder'
import { getPreset } from '../audio/presets/spatialPresets'
import type { AudioPlayer } from '../hooks/useAudioPlayer'
import { FORMAT_SUPPORT } from '../utils/fileValidation'
import { formatBytes, formatHz, formatTime } from '../utils/format'
import { Badge, Panel } from './Panel'

interface ExportPanelProps {
  player: AudioPlayer
}

const STAGE_LABEL = { preparing: 'PREPARING', rendering: 'RENDERING', encoding: 'ENCODING' } as const

/** 現在の設定の名前（ファイル名・表示に使う） */
function settingsLabel(player: AudioPlayer): string {
  const ps = player.presetState
  if (ps.activeId) return getPreset(ps.activeId).label
  if (ps.savedActive) return 'CUSTOM（保存）'
  if (ps.custom) return 'CUSTOM'
  return player.spatialParams.mode === 'off' ? 'ORIGINAL 相当（空間 OFF）' : '手動設定'
}

/**
 * 書き出した WAV そのもの（Object URL）と元のファイルを、<audio> で再生する（再生用の DSP は通さない）。
 * EXPORTED / ORIGINAL の切替は同じ時刻から（書き出しは処理の遅延を先頭で切り捨ててあるので時刻がそろう）
 */
function ExportPreview({ url, original, onPlay }: { url: string; original: string | null; onPlay: () => void }) {
  const exported = useRef<HTMLAudioElement>(null)
  const orig = useRef<HTMLAudioElement>(null)
  const [which, setWhich] = useState<'exported' | 'original'>('exported')
  const switchTo = (next: 'exported' | 'original') => {
    if (next === which) return
    const from = which === 'exported' ? exported.current : orig.current
    const to = next === 'exported' ? exported.current : orig.current
    if (from && to) {
      const playing = !from.paused
      from.pause()
      to.currentTime = Math.min(from.currentTime, Number.isFinite(to.duration) ? to.duration : from.currentTime)
      if (playing) void to.play()
    }
    setWhich(next)
  }
  return (
    <div className="export-preview">
      <div className="ab-switch" role="radiogroup" aria-label="プレビューする音">
        <button type="button" role="radio" aria-checked={which === 'exported'} className={`ab-switch__item${which === 'exported' ? ' is-active' : ''}`} onClick={() => switchTo('exported')}>
          EXPORTED
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={which === 'original'}
          disabled={!original}
          className={`ab-switch__item${which === 'original' ? ' is-active is-original' : ''}`}
          onClick={() => switchTo('original')}
        >
          ORIGINAL
        </button>
      </div>
      <audio ref={exported} controls src={url} preload="auto" hidden={which !== 'exported'} onPlay={onPlay} data-preview="exported" />
      {original && <audio ref={orig} controls src={original} preload="auto" hidden={which !== 'original'} onPlay={onPlay} data-preview="original" />}
      <p className="output-stage__note">書き出した WAV ファイルそのものを再生します（再生用の空間処理・重低音は通しません）。ORIGINAL は読み込んだ元のファイルです。</p>
    </div>
  )
}

export function ExportPanel({ player }: ExportPanelProps) {
  const { audio, exportState: ex, spatialParams, originalUrl } = player
  const [bitDepth, setBitDepth] = useState<WavBitDepth>(16)

  const running = ex.state === 'running'
  const label = settingsLabel(player)
  const rate = audio ? (audio.header.sampleRate ?? audio.buffer.sampleRate) : null
  const frames = audio && rate ? Math.ceil((audio.buffer.duration + reverbTailSeconds(spatialParams)) * rate) : 0
  const sizeEstimate = audio && rate ? 44 + wavDataBytes(frames, 2, bitDepth) : null
  const memEstimate = audio && rate ? estimateExportBytes(Math.ceil(audio.buffer.duration * rate), audio.buffer.numberOfChannels, rate, spatialParams, bitDepth) : null
  const memBudget = exportMemoryBudget((navigator as Navigator & { deviceMemory?: number }).deviceMemory)

  const badge =
    ex.state === 'running' ? (
      <Badge tone="pending">{STAGE_LABEL[ex.progress.stage]}</Badge>
    ) : ex.state === 'complete' ? (
      <Badge tone="live">PROCESSING COMPLETE</Badge>
    ) : ex.state === 'error' ? (
      <Badge tone="locked">失敗</Badge>
    ) : ex.state === 'cancelled' ? (
      <Badge tone="idle">キャンセル</Badge>
    ) : (
      <Badge tone="idle">{audio ? '準備完了' : '音源未読み込み'}</Badge>
    )

  return (
    <Panel index="08" label="EXPORT" title="書き出し" className="panel--export" aside={badge}>
      <dl className="spec-list spec-list--compact">
        <div className="spec-list__row">
          <dt>設定</dt>
          <dd>{label}</dd>
        </div>
        <div className="spec-list__row">
          <dt>出力形式</dt>
          <dd className="mono">WAV / PCM / ステレオ</dd>
        </div>
        <div className="spec-list__row">
          <dt>ビット深度</dt>
          <dd>
            <span className="ab-switch export-depth" role="radiogroup" aria-label="ビット深度">
              {([16, 24] as WavBitDepth[]).map((d) => (
                <button key={d} type="button" role="radio" aria-checked={bitDepth === d} disabled={running} className={`ab-switch__item${bitDepth === d ? ' is-active' : ''}`} onClick={() => setBitDepth(d)}>
                  {d}-bit
                </button>
              ))}
            </span>
          </dd>
        </div>
        <div className="spec-list__row">
          <dt>サンプルレート</dt>
          <dd className="mono">
            {rate ? formatHz(rate) : '—'}
            {audio && !audio.header.sampleRate && <span className="spec-list__note">元のレートが不明なため再生時のレート</span>}
          </dd>
        </div>
        <div className="spec-list__row">
          <dt>長さ（推定）</dt>
          <dd className="mono">{audio ? `${formatTime(audio.buffer.duration, true)} + 余韻 最大 ${reverbTailSeconds(spatialParams).toFixed(2)} 秒` : '—'}</dd>
        </div>
        <div className="spec-list__row">
          <dt>ファイルサイズ（推定）</dt>
          <dd className="mono">{sizeEstimate !== null ? formatBytes(sizeEstimate) : '—'}</dd>
        </div>
        <div className="spec-list__row">
          <dt>必要なメモリ（推定）</dt>
          <dd className="mono">
            {memEstimate !== null ? `${formatBytes(memEstimate)} / 上限 ${formatBytes(memBudget)}` : '—'}
          </dd>
        </div>
      </dl>

      <div className="export-actions">
        <button type="button" className="btn-export" disabled={!audio || running} onClick={() => void player.exportWav(bitDepth, label)}>
          {running ? '書き出し中…' : 'EXPORT（WAV を生成）'}
        </button>
        {running && (
          <button type="button" className="btn-chip" onClick={player.cancelExport}>
            キャンセル
          </button>
        )}
      </div>

      {ex.state === 'running' && (
        <div className="export-progress" role="status">
          <div className="export-stages">
            {(['preparing', 'rendering', 'encoding'] as const).map((s) => (
              <span key={s} className={ex.progress.stage === s ? 'is-current' : ''}>
                {STAGE_LABEL[s]}
              </span>
            ))}
          </div>
          {ex.progress.stage === 'rendering' && ex.progress.rendered !== undefined && (
            <>
              <div className="export-bar">
                <span style={{ width: `${(ex.progress.rendered * 100).toFixed(1)}%` }} />
              </div>
              <p className="output-stage__note mono">レンダリング済み {(ex.progress.rendered * 100).toFixed(0)}%（OfflineAudioContext で実際に描画し終えた時刻）</p>
            </>
          )}
        </div>
      )}
      {ex.state === 'error' && (
        <p className="notice">
          {ex.message}
          {ex.detail && <small> {ex.detail}</small>}
        </p>
      )}
      {ex.state === 'cancelled' && <p className="output-stage__note">キャンセルしました（ファイルは作成していません）。</p>}
      {ex.state === 'complete' && (
        <div className="export-done">
          <p className="export-done__title">PROCESSING COMPLETE</p>
          <dl className="spec-list spec-list--compact">
            <div className="spec-list__row">
              <dt>ファイル</dt>
              <dd className="mono">{ex.fileName}</dd>
            </div>
            <div className="spec-list__row">
              <dt>形式</dt>
              <dd className="mono">
                WAV PCM {ex.result.bitDepth}-bit{ex.result.bitDepth === 16 ? '（TPDF ディザ）' : ''} / {formatHz(ex.result.sampleRate)} / ステレオ / {formatBytes(ex.result.blob.size)}
              </dd>
            </div>
            <div className="spec-list__row">
              <dt>長さ</dt>
              <dd className="mono">
                {formatTime(ex.result.frames / ex.result.sampleRate, true)}（音源 {ex.result.sourceSeconds.toFixed(2)} 秒 + 余韻 {ex.result.tailSeconds.toFixed(2)} 秒）
              </dd>
            </div>
            <div className="spec-list__row">
              <dt>ピーク / ラウドネス</dt>
              <dd className="mono">
                {ex.result.peakDb.toFixed(2)} dBFS / {Number.isFinite(ex.result.loudnessLufs) ? `${ex.result.loudnessLufs.toFixed(1)} LUFS` : '無音'}
                {ex.result.clippedSamples > 0 && `（飽和 ${ex.result.clippedSamples} サンプル）`}
              </dd>
            </div>
            <div className="spec-list__row">
              <dt>設定</dt>
              <dd>{ex.settingsLabel}</dd>
            </div>
          </dl>
          <a className="btn-export btn-export--download" href={ex.url} download={ex.fileName}>
            WAV をダウンロード
          </a>
          <ExportPreview url={ex.url} original={originalUrl} onPlay={player.pause} />
        </div>
      )}

      <div className="spatial-doc export-doc">
        <div>
          <p className="spatial-doc__title">書き出しの処理</p>
          <ol>
            <li>再生と同じ設定・同じ処理計画（ラウドネス合わせのトリムなど）で、音源全体を先頭から OfflineAudioContext で処理（Motion は曲の先頭から同じ動き）</li>
            <li>音源の後ろに、設定された残響（IR の長さ・プリディレイ）から決めた余韻を含める。−100 dBFS を下回ってから 150 ms 後で切り、最後の 20 ms をフェード</li>
            <li>処理の遅延（Motion・HRTF・リミッターの先読み）は先頭で切り捨て、元の音源と同じ時刻にそろえる</li>
            <li>書き出しは使い捨ての内部フレームで行い、終わったら破棄してメモリを返す（キャンセルも同じ）</li>
          </ol>
        </div>
        <div>
          <p className="spatial-doc__title">対応形式（入力）</p>
          <ul>
            {FORMAT_SUPPORT.map((f) => (
              <li key={f.formats}>
                {f.formats}: {f.status}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Panel>
  )
}
