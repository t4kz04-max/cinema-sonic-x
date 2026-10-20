import { useState } from 'react'
import type { WavBitDepth } from '../audio/export/wavEncoder'
import { getPreset } from '../audio/presets/spatialPresets'
import type { AudioPlayer } from '../hooks/useAudioPlayer'
import { formatBytes, formatHz, formatTime } from '../utils/format'
import { estimateVideoOutputBytes, MIME_OF, outputAudioCodecFor, VIDEO_AUDIO_BITRATE, type VideoTailMode } from '../video/videoSpec'
import { Badge, Panel } from './Panel'

interface VideoPanelProps {
  player: AudioPlayer
}

const STAGE_LABEL = { preparing: 'PREPARING', rendering: 'RENDERING', encoding: 'ENCODING', muxing: 'MUXING' } as const

function settingsLabel(player: AudioPlayer): string {
  const ps = player.presetState
  if (ps.activeId) return getPreset(ps.activeId).label
  if (ps.savedActive) return 'CUSTOM（保存）'
  if (ps.custom) return 'CUSTOM'
  return player.spatialParams.mode === 'off' ? 'ORIGINAL 相当（空間 OFF）' : '手動設定'
}

/** 動画の入力・書き出し（Phase 07）。音声だけの WAV（元の音声 / 立体音響化）と、音声を差し替えた動画 */
export function VideoPanel({ player }: VideoPanelProps) {
  const { audio, videoState: vs, originalUrl } = player
  const [tailMode, setTailMode] = useState<VideoTailMode>('trim')
  const [bitDepth, setBitDepth] = useState<WavBitDepth>(16)
  // プレビューを再生できなかった結果の URL（コーデックをブラウザ・OS が再生できない場合など）
  const [unplayableUrl, setUnplayableUrl] = useState<string | null>(null)
  const video = audio?.video
  if (!audio || !video) return null
  const info = video.info
  const running = vs.state === 'running' || player.exportState.state === 'running'
  const label = settingsLabel(player)
  // 出力の音声コーデックは、AAC が使えない環境では Opus になる（書き出し時に確認）
  const expectedCodec = outputAudioCodecFor(info.container, true)
  const sizeEstimate = estimateVideoOutputBytes(info, expectedCodec, info.duration)
  const canPlayInput = typeof document !== 'undefined' && document.createElement('video').canPlayType(MIME_OF[info.container]) !== ''
  const track = info.audioTracks.find((t) => t.id === info.primaryAudioId)

  const badge =
    vs.state === 'running' ? (
      <Badge tone="pending">{STAGE_LABEL[vs.progress.stage]}</Badge>
    ) : vs.state === 'complete' ? (
      <Badge tone="live">PROCESSING COMPLETE</Badge>
    ) : vs.state === 'error' ? (
      <Badge tone="locked">失敗</Badge>
    ) : vs.state === 'cancelled' ? (
      <Badge tone="idle">キャンセル</Badge>
    ) : (
      <Badge tone="idle">{info.container.toUpperCase()}</Badge>
    )

  return (
    <Panel index="09" label="VIDEO" title="動画（音声の抽出・立体音響化・差し替え）" className="panel--video" aside={badge}>
      <dl className="spec-list spec-list--compact">
        <div className="spec-list__row">
          <dt>ファイル</dt>
          <dd className="mono">{info.fileName}</dd>
        </div>
        <div className="spec-list__row">
          <dt>コンテナ</dt>
          <dd className="mono">
            {info.container.toUpperCase()}（{info.formatName}）
          </dd>
        </div>
        <div className="spec-list__row">
          <dt>映像</dt>
          <dd className="mono">
            {info.video.codec}
            {info.video.codecString ? ` (${info.video.codecString})` : ''} / {info.video.width}×{info.video.height}
            {info.video.fps ? ` / ${info.video.fps.toFixed(2)} fps` : ''}
            {info.video.rotation ? ` / 回転 ${info.video.rotation}°` : ''}
          </dd>
        </div>
        <div className="spec-list__row">
          <dt>再生時間</dt>
          <dd className="mono">{formatTime(info.duration, true)}</dd>
        </div>
        <div className="spec-list__row">
          <dt>音声トラック</dt>
          <dd className="mono">
            {info.audioTracks.map((t) => (
              <span key={t.id} className="video-track">
                #{t.id} {t.codec} / {formatHz(t.sampleRate)} / {t.channels}ch / 開始 {t.startTime.toFixed(3)} 秒{t.language && t.language !== 'und' ? ` / ${t.language}` : ''}
                {t.id === info.primaryAudioId ? '（処理する）' : '（出力に含めない）'}
              </span>
            ))}
          </dd>
        </div>
      </dl>
      {info.audioTracks.length > 1 && <p className="notice">音声トラックが {info.audioTracks.length} 本あります。処理するのは「処理する」と表示したトラックだけで、動画の書き出しにはこのトラックを加工した音声 1 本だけが入ります。</p>}

      {canPlayInput && originalUrl ? (
        <video className="video-preview" controls preload="metadata" src={originalUrl} onPlay={player.pause} data-preview="input" />
      ) : (
        <p className="output-stage__note">このブラウザは入力の動画（{info.video.codec}）を再生できないため、プレビューを表示しません（書き出しは映像をコピーするので可能です）。</p>
      )}
      <p className="output-stage__note">入力の動画は元の音声のまま再生します（立体音響の試聴は上の再生ボタンで。抽出した音声に処理を掛けて再生します）。</p>

      <div className="video-actions">
        <div className="video-action">
          <p className="spatial-doc__title">1. 音声だけ抽出（ORIGINAL AUDIO）</p>
          <p className="spatial-param__desc">処理せずに WAV（{track ? `${formatHz(track.sampleRate)}・ステレオ` : '—'}）。WAV には音声の開始時刻（{video.audioStart.toFixed(3)} 秒）が入らない点に注意。</p>
          <span className="ab-switch export-depth" role="radiogroup" aria-label="ビット深度">
            {([16, 24] as WavBitDepth[]).map((d) => (
              <button key={d} type="button" role="radio" aria-checked={bitDepth === d} disabled={running} className={`ab-switch__item${bitDepth === d ? ' is-active' : ''}`} onClick={() => setBitDepth(d)}>
                {d}-bit
              </button>
            ))}
          </span>
          <button type="button" className="btn-chip" disabled={running} onClick={() => void player.exportOriginalVideoAudio(bitDepth)}>
            元の音声を WAV に
          </button>
        </div>
        <div className="video-action">
          <p className="spatial-doc__title">2. 立体音響化して WAV</p>
          <p className="spatial-param__desc">「08 EXPORT」の書き出しと同じ処理（{label}、余韻を最後まで含む）。</p>
          <button type="button" className="btn-chip" disabled={running} onClick={() => void player.exportWav(bitDepth, label)}>
            {label} で WAV を書き出す（08 EXPORT に表示）
          </button>
        </div>
        <div className="video-action">
          <p className="spatial-doc__title">3. 立体音響化して動画</p>
          <p className="spatial-param__desc">
            映像は再エンコードせずにコピーし、音声だけを {label} で加工して差し替え（{info.container.toUpperCase()}・{expectedCodec === 'aac' ? 'AAC' : 'Opus'} {VIDEO_AUDIO_BITRATE[expectedCodec] / 1000} kbps）。推定サイズ 最大 {formatBytes(sizeEstimate)}
          </p>
          <span className="ab-switch video-tail" role="radiogroup" aria-label="動画の終わりの余韻">
            <button type="button" role="radio" aria-checked={tailMode === 'trim'} disabled={running} className={`ab-switch__item${tailMode === 'trim' ? ' is-active' : ''}`} onClick={() => setTailMode('trim')}>
              映像の長さを保つ
            </button>
            <button type="button" role="radio" aria-checked={tailMode === 'extend'} disabled={running} className={`ab-switch__item${tailMode === 'extend' ? ' is-active' : ''}`} onClick={() => setTailMode('extend')}>
              最後のフレームを延ばして余韻を残す
            </button>
          </span>
          <p className="output-stage__note">
            {tailMode === 'trim'
              ? '映像の終わりで音声を切り、最後の 20 ms をフェード（映像の長さは変えない。映像の後ろの余韻は入らない）'
              : '最後のフレームの表示時間を延ばし、余韻が消えるまで映像を出す（再エンコードなし。映像の長さが余韻の分だけ長くなる）'}
          </p>
          <button type="button" className="btn-export" disabled={running} onClick={() => void player.exportSpatialVideo(tailMode, label)}>
            {vs.state === 'running' && vs.kind === 'video' ? '書き出し中…' : '動画を書き出す'}
          </button>
        </div>
      </div>

      {vs.state === 'running' && (
        <div className="export-progress" role="status">
          <div className="export-stages">
            {(['preparing', 'rendering', 'encoding', 'muxing'] as const).map((s) => (
              <span key={s} className={vs.progress.stage === s ? 'is-current' : ''}>
                {STAGE_LABEL[s]}
              </span>
            ))}
          </div>
          {vs.progress.fraction !== undefined && (
            <>
              <div className="export-bar">
                <span style={{ width: `${(vs.progress.fraction * 100).toFixed(1)}%` }} />
              </div>
              <p className="output-stage__note mono">
                {vs.progress.stage === 'rendering' ? 'レンダリング済み' : '書き込み済み（映像の時刻）'} {(vs.progress.fraction * 100).toFixed(0)}%
              </p>
            </>
          )}
          {vs.kind === 'video' && (
            <button type="button" className="btn-chip" onClick={player.cancelVideo}>
              キャンセル
            </button>
          )}
        </div>
      )}
      {vs.state === 'error' && (
        <p className="notice">
          {vs.message}
          {vs.detail && <small> {vs.detail}</small>}
        </p>
      )}
      {vs.state === 'cancelled' && <p className="output-stage__note">キャンセルしました（ファイルは作成していません）。</p>}
      {vs.state === 'complete' && (
        <div className="export-done">
          <p className="export-done__title">PROCESSING COMPLETE</p>
          {vs.kind === 'video' ? (
            <dl className="spec-list spec-list--compact">
              <div className="spec-list__row">
                <dt>ファイル</dt>
                <dd className="mono">{vs.fileName}</dd>
              </div>
              <div className="spec-list__row">
                <dt>形式</dt>
                <dd className="mono">
                  {info.container.toUpperCase()} / 映像 {info.video.codec}（コピー、{vs.result.videoPackets} パケット）/ 音声 {vs.result.audioCodec === 'aac' ? 'AAC' : 'Opus'} / {formatBytes(vs.result.blob.size)}
                </dd>
              </div>
              <div className="spec-list__row">
                <dt>長さ</dt>
                <dd className="mono">
                  映像 {vs.result.videoEnd.toFixed(2)} 秒{vs.result.extendedSeconds > 0 ? `（最後のフレームを ${vs.result.extendedSeconds.toFixed(2)} 秒延長）` : ''} / 音声 {vs.result.audioSeconds.toFixed(2)} 秒
                  {vs.result.trimmedTailSeconds > 0 ? `（映像の後ろの余韻 ${vs.result.trimmedTailSeconds.toFixed(2)} 秒を切り、フェード）` : ''}
                </dd>
              </div>
              <div className="spec-list__row">
                <dt>設定</dt>
                <dd>{vs.settingsLabel}</dd>
              </div>
              <div className="spec-list__row">
                <dt>処理時間</dt>
                <dd className="mono">
                  音声 {(vs.result.renderMs / 1000).toFixed(1)} 秒 + 動画の書き込み {(vs.result.muxMs / 1000).toFixed(1)} 秒
                </dd>
              </div>
            </dl>
          ) : (
            <dl className="spec-list spec-list--compact">
              <div className="spec-list__row">
                <dt>ファイル</dt>
                <dd className="mono">{vs.fileName}</dd>
              </div>
              <div className="spec-list__row">
                <dt>形式</dt>
                <dd className="mono">
                  WAV / {formatTime(vs.seconds, true)} / {formatBytes(vs.bytes)}（処理なし）
                </dd>
              </div>
            </dl>
          )}
          <a className="btn-export btn-export--download" href={vs.url} download={vs.fileName}>
            {vs.kind === 'video' ? '動画をダウンロード' : 'WAV をダウンロード'}
          </a>
          {vs.kind === 'video' ? (
            <video className="video-preview" controls preload="metadata" src={vs.url} onPlay={player.pause} onError={() => setUnplayableUrl(vs.url)} data-preview="output" />
          ) : (
            <audio controls preload="metadata" src={vs.url} onPlay={player.pause} onError={() => setUnplayableUrl(vs.url)} data-preview="original-wav" />
          )}
          {unplayableUrl === vs.url ? (
            <p className="output-stage__note">このブラウザは書き出したファイルのコーデックを再生できないため、プレビューできません。ファイルはダウンロードして対応するプレイヤーで再生してください。</p>
          ) : (
            <p className="output-stage__note">書き出したファイルそのものを再生します（再生用の空間処理は通しません）。</p>
          )}
        </div>
      )}
    </Panel>
  )
}
