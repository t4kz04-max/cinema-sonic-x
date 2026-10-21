import { memo } from 'react'
import { estimateExportBytes, exportMemoryBudget, reverbTailSeconds } from '../audio/export/exportSpec'
import { wavDataBytes, type WavBitDepth } from '../audio/export/wavEncoder'
import type { AudioPlayer } from '../hooks/useAudioPlayer'
import { FORMAT_SUPPORT } from '../utils/fileValidation'
import { formatBytes, formatHz, formatTime } from '../utils/format'
import { ExportError, StageTrack } from './exportCommon'
import { settingsLabel, STAGE_LABEL } from './exportLabels'
import { MediaCompare } from './MediaCompare'
import { Badge, Panel } from './Panel'

interface ExportPanelProps {
  player: AudioPlayer
}

/** 音声の書き出し（STUDIO MODE）。設定（ビット深度）は useAudioPlayer の exportOptions に持ち、SIMPLE と共有する */
export const ExportPanel = memo(function ExportPanel({ player }: ExportPanelProps) {
  const { audio, exportState: ex, spatialParams, originalUrl } = player
  const { bitDepth } = player.exportOptions
  const setBitDepth = (d: WavBitDepth) => player.setExportOptions({ bitDepth: d })

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
    <Panel index="10" label="EXPORT" id="studio-export" title="書き出し" className="panel--export" aside={badge}>
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
        <StageTrack
          stages={['preparing', 'rendering', 'encoding']}
          current={ex.progress.stage}
          fraction={ex.progress.stage === 'rendering' ? ex.progress.rendered : undefined}
          fractionLabel="レンダリング済み（OfflineAudioContext で実際に描画し終えた時刻）"
        />
      )}
      {ex.state === 'error' && <ExportError message={ex.message} detail={ex.detail} onRetry={() => void player.exportWav(bitDepth, label)} />}
      {ex.state === 'cancelled' && <p className="output-stage__note">キャンセルしました（ファイルは作成していません）。</p>}
      {ex.state === 'complete' && (
        <div className="export-done">
          <StageTrack stages={['preparing', 'rendering', 'encoding']} current="complete" />
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
          <MediaCompare
            kind="audio"
            exportedUrl={ex.url}
            originalUrl={originalUrl}
            enginePlaying={player.status === 'playing'}
            onPlay={player.pause}
            volume={player.volume}
            note="書き出した WAV ファイルそのものを再生します（再生用の空間処理・重低音は通しません）。ORIGINAL は読み込んだ元のファイルです。"
          />
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
})
