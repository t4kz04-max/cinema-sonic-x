import { memo, type ReactNode } from 'react'
import type { WavBitDepth } from '../audio/export/wavEncoder'
import { getPreset, SPATIAL_PRESETS, type PresetId } from '../audio/presets/spatialPresets'
import type { AudioPlayer } from '../hooks/useAudioPlayer'
import { formatBytes, formatChannels, formatHz, formatTime } from '../utils/format'
import { platformLimits } from '../utils/platform'
import { estimateExportBytes, exportMemoryBudget } from '../audio/export/exportSpec'
import { estimateVideoExportBytes, MIME_OF } from '../video/videoSpec'
import { ExportError, StageTrack } from './exportCommon'
import { settingsLabel, STAGE_HINT, type UiStage } from './exportLabels'
import { PauseIcon, PlayIcon, StopIcon } from './Icons'
import { MediaCompare } from './MediaCompare'
import { Badge } from './Panel'
import { PlaybackTimeline } from './PlaybackTimeline'
import { UploadZone } from './UploadZone'
import { VolumeControl } from './VolumeControl'

interface SimpleViewProps {
  player: AudioPlayer
  onOpenStudio: () => void
}

/**
 * SIMPLE MODE のプリセットの説明（UI の文言だけ。プリセットの設定値・元データは変えない）。
 * 音響の専門用語を使わず、聴いたときの違いが分かる文にする
 */
const SIMPLE_COPY: Record<PresetId, { catch: string; text: string; scene: string }> = {
  'cinema-3d': {
    catch: '映画館のスクリーンの前で聴く音',
    text: '映画館のような響きを加え、セリフや歌声は真ん中にとどめます。響きは控えめで自然です。',
    scene: '映画・ドラマ・ナレーション',
  },
  'live-arena': {
    catch: '大きなライブ会場の響き',
    text: '会場いっぱいに響きが広がります。演奏が混み合う所では響きを自動で抑え、音がにごりにくくします。',
    scene: 'ライブ音源・バンド・合唱',
  },
  'motion-360': {
    catch: '音がまわりを動き回る',
    text: '周りの音がゆっくり動き、近づいたり遠ざかったりするように聞こえます。歌声と低音は動かしません。',
    scene: '動きのある演出・BGM',
  },
  'immersive-x': {
    catch: 'いちばん立体的な仕上がり',
    text: '音の位置・奥行き・余韻の広がりを組み合わせた、4 つの中で最も没入感のある設定です。',
    scene: '音楽・映像作品全般',
  },
}

const STEPS = ['ファイルを選ぶ', 'プリセットを選ぶ', 'プレビュー', '加工を開始', 'ダウンロード'] as const

function StepBar({ current }: { current: number }) {
  return (
    <ol className="simple-steps" aria-label="操作の手順">
      {STEPS.map((s, i) => (
        <li key={s} className={i < current ? 'is-done' : i === current ? 'is-current' : ''} aria-current={i === current ? 'step' : undefined}>
          <span className="simple-steps__num">{i + 1}</span>
          <span className="simple-steps__label">{s}</span>
        </li>
      ))}
    </ol>
  )
}

function Section({ step, title, aside, children, className }: { step: number; title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`simple-card ${className ?? ''}`} aria-label={title} data-step={step}>
      <header className="simple-card__head">
        <span className="simple-card__step">STEP {step}</span>
        <h2 className="simple-card__title">{title}</h2>
        {aside && <span className="simple-card__aside">{aside}</span>}
      </header>
      {children}
    </section>
  )
}

/** 読み込んだファイルの情報（SIMPLE MODE は主な項目だけ。全項目は STUDIO の SOURCE） */
function FileSummary({ player }: { player: AudioPlayer }) {
  const { audio } = player
  if (!audio) return <p className="empty-note">ファイルを読み込むと、ここに名前・長さ・サンプルレートなどが表示されます。</p>
  const v = audio.video?.info
  const rows: [string, string][] = [
    ['種類', v ? `動画（${v.container.toUpperCase()}）` : `音声（${audio.format.toUpperCase()}）`],
    ['再生時間', formatTime(v ? v.duration : audio.buffer.duration, true)],
    ['サンプルレート', formatHz(audio.header.sampleRate ?? audio.buffer.sampleRate)],
    ['チャンネル数', formatChannels(audio.header.channels ?? audio.buffer.numberOfChannels)],
  ]
  if (v) rows.push(['解像度', `${v.video.width}×${v.video.height}${v.video.fps ? ` / ${v.video.fps.toFixed(0)} fps` : ''}`])
  rows.push(['ファイルサイズ', formatBytes(audio.fileSizeBytes)])
  return (
    <div className="file-summary" data-ui="file-summary">
      <p className="file-name" title={audio.fileName}>
        {audio.fileName}
      </p>
      <dl className="spec-list spec-list--compact">
        {rows.map(([k, val]) => (
          <div className="spec-list__row" key={k}>
            <dt>{k}</dt>
            <dd className="mono">{val}</dd>
          </div>
        ))}
      </dl>
      {v && v.audioTracks.length > 1 && <p className="output-stage__note">音声トラックが {v.audioTracks.length} 本あります。主な 1 本だけを加工します。</p>}
    </div>
  )
}

function PresetCards({ player, onOpenStudio }: SimpleViewProps) {
  const ps = player.presetState
  const customFrom = ps.custom && ps.source?.kind === 'preset' ? ps.source.id : null
  return (
    <>
      <div className="simple-presets" role="radiogroup" aria-label="音響プリセット">
        {SPATIAL_PRESETS.map((p) => {
          const copy = SIMPLE_COPY[p.id]
          const selected = ps.activeId === p.id
          const modified = customFrom === p.id
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={selected}
              data-preset={p.id}
              className={`simple-preset${selected ? ' is-active' : ''}${modified ? ' is-modified' : ''}`}
              onClick={() => player.applyPreset(p.id)}
            >
              <span className="simple-preset__label">{p.label}</span>
              <span className="simple-preset__catch">{copy.catch}</span>
              <span className="simple-preset__text">{copy.text}</span>
              <span className="simple-preset__foot">
                <span>{copy.scene}</span>
                <span className={p.headphones ? 'is-hp' : ''}>{p.headphones ? 'ヘッドホン向け' : 'スピーカーでも可'}</span>
              </span>
              {(selected || modified) && <span className="simple-preset__state">{selected ? '選択中' : 'CUSTOM（調整済み）'}</span>}
            </button>
          )
        })}
      </div>
      <p className="simple-note">ヘッドホン向けの 3 つは、ヘッドホンで聴いたときの方向（前・後ろ・まわり）の感じ方に個人差があります。頭の中や後ろに聞こえる場合もあります。</p>
      {(ps.custom || ps.savedActive) && (
        <p className="simple-note" data-ui="custom-note">
          {ps.savedActive ? '保存した CUSTOM 設定' : `CUSTOM 設定（${customFrom ? `${getPreset(customFrom).label} を STUDIO で調整` : 'STUDIO で調整'}）`}を使っています。カードを選ぶとプリセットの設定に戻ります。{' '}
          <button type="button" className="link-btn" onClick={onOpenStudio}>
            STUDIO で調整する
          </button>
        </p>
      )}
      {ps.source === null && !ps.activeId && !ps.savedActive && <p className="simple-note">4 つのうち 1 つを選んでください。選ぶとすぐに試聴の音に反映されます。</p>}
    </>
  )
}

function Preview({ player }: { player: AudioPlayer }) {
  const { audio, status, bypass, dsp } = player
  const disabled = !audio
  const measuring = dsp?.spatial.analysis === 'measuring' || dsp?.analysis === 'measuring'
  return (
    <div className="simple-preview">
      <PlaybackTimeline player={player} idPrefix="simple" />
      <div className="simple-preview__row">
        <div className="transport-buttons">
          <button type="button" className="btn-round btn-round--primary" onClick={player.togglePlay} disabled={disabled} aria-label={status === 'playing' ? '一時停止' : '再生'} title={status === 'playing' ? '一時停止（Space）' : '再生（Space）'}>
            {status === 'playing' ? <PauseIcon size={28} /> : <PlayIcon size={28} />}
          </button>
          <button type="button" className="btn-round btn-round--secondary" onClick={player.stop} disabled={disabled} aria-label="停止" title="停止して先頭へ">
            <StopIcon />
          </button>
        </div>
        <div className="ab-switch ab-switch--large" role="radiogroup" aria-label="試聴する音（B キーで切替）">
          <button type="button" role="radio" aria-checked={bypass} className={`ab-switch__item${bypass ? ' is-active is-original' : ''}`} onClick={() => player.setBypass(true)}>
            ORIGINAL<small>元の音</small>
          </button>
          <button type="button" role="radio" aria-checked={!bypass} className={`ab-switch__item${!bypass ? ' is-active' : ''}`} onClick={() => player.setBypass(false)}>
            PROCESSED<small>加工した音</small>
          </button>
        </div>
        <VolumeControl player={player} idPrefix="simple" />
      </div>
      <p className="output-stage__note">
        再生中でも切り替えられます（同じ位置のまま、短いクロスフェードで切替。加工した音は元の音と同じくらいの音量にそろえています）。
        {measuring && ' 音量をそろえるための測定中です（数秒で終わります）。'}
      </p>
    </div>
  )
}

/** 書き出しと結果（STEP 4・5）。音声 → WAV、動画 → 立体音響化した動画 または 立体音響化した WAV */
function ExportFlow({ player }: { player: AudioPlayer }) {
  const { audio, exportState: ex, videoState: vs, exportOptions: opt, originalUrl } = player
  const limits = platformLimits()
  const isVideo = !!audio?.video
  // 動画を書き出せない端末（スマートフォンなど）では音声（WAV）だけを選べる
  const output: 'video' | 'wav' = isVideo && limits.videoExport.ok ? opt.videoOutput : 'wav'
  const label = settingsLabel(player)
  // SIMPLE ではプリセット（または CUSTOM）を選んだときだけ書き出す（初期状態の WIDE は選んだ設定ではないため）
  const ps = player.presetState
  const processing = ps.source !== null || ps.activeId !== null || ps.savedActive
  const running = ex.state === 'running' || vs.state === 'running'
  const blocked = !audio ? 'ファイルを読み込んでください。' : !processing ? 'プリセットを選んでください（STUDIO で手動で決めた設定は STUDIO の EXPORT から書き出せます）。' : output === 'video' && !limits.videoExport.ok ? limits.videoExport.reason : null

  // 必要なメモリの目安（書き出し前の判定と同じ見積もり）。上限の半分を超えるときは、他のアプリ・タブを閉じるよう勧める
  const budget = exportMemoryBudget((navigator as Navigator & { deviceMemory?: number }).deviceMemory)
  const need = !audio
    ? 0
    : output === 'video' && audio.video
      ? estimateVideoExportBytes(audio.video.info, { frames: audio.buffer.length, channels: audio.buffer.numberOfChannels, sampleRate: audio.buffer.sampleRate }, player.dspConfig.spatial)
      : estimateExportBytes(Math.ceil(audio.buffer.duration * (audio.header.sampleRate ?? audio.buffer.sampleRate)), audio.buffer.numberOfChannels, audio.header.sampleRate ?? audio.buffer.sampleRate, player.dspConfig.spatial, opt.bitDepth)
  const heavy = need > budget * 0.5

  const start = () => {
    if (output === 'video') void player.exportSpatialVideo(opt.videoTail, label)
    else void player.exportWav(opt.bitDepth, label)
  }
  const cancel = output === 'video' ? player.cancelVideo : player.cancelExport

  // 表示する書き出しの状態（出力の種類ごと）。STUDIO の「元の音声を WAV に」の結果はここには出さない
  const job = output === 'video' ? (vs.state === 'complete' && vs.kind !== 'video' ? null : vs) : ex
  const stages: readonly UiStage[] = output === 'video' ? ['preparing', 'rendering', 'encoding', 'muxing'] : ['preparing', 'rendering', 'encoding']
  const progress = job?.state === 'running' ? ('kind' in job ? { stage: job.progress.stage, fraction: job.progress.fraction } : { stage: job.progress.stage, fraction: job.progress.rendered }) : null
  const canPlayInput = isVideo && audio?.video && document.createElement('video').canPlayType(MIME_OF[audio.video.info.container]) !== ''

  return (
    <>
      <Section step={4} title="加工を開始" aside={running && progress ? <Badge tone="pending">{STAGE_HINT[progress.stage]}</Badge> : undefined}>
        {isVideo && (
          <div className="simple-choice" role="radiogroup" aria-label="作るファイル">
            <button type="button" role="radio" aria-checked={output === 'video'} disabled={running || !limits.videoExport.ok} data-output="video" className={`simple-choice__item${output === 'video' ? ' is-active' : ''}`} onClick={() => player.setExportOptions({ videoOutput: 'video' })}>
              <strong>立体音響の動画を作る</strong>
              <small>{limits.videoExport.ok ? '映像はそのまま（画質は変わりません）、音声だけを加工して差し替えます' : 'この端末では使えません'}</small>
            </button>
            <button type="button" role="radio" aria-checked={output === 'wav'} disabled={running} data-output="wav" className={`simple-choice__item${output === 'wav' ? ' is-active' : ''}`} onClick={() => player.setExportOptions({ videoOutput: 'wav' })}>
              <strong>音声だけ取り出す（WAV）</strong>
              <small>動画の音声を加工して WAV ファイルにします（映像は含みません）</small>
            </button>
          </div>
        )}
        {output === 'wav' && (
          <div className="simple-option">
            <span>音質</span>
            <span className="ab-switch export-depth" role="radiogroup" aria-label="ビット深度">
              {([16, 24] as WavBitDepth[]).map((d) => (
                <button key={d} type="button" role="radio" aria-checked={opt.bitDepth === d} disabled={running} className={`ab-switch__item${opt.bitDepth === d ? ' is-active' : ''}`} onClick={() => player.setExportOptions({ bitDepth: d })}>
                  {d === 16 ? '標準（16-bit）' : '高音質（24-bit）'}
                </button>
              ))}
            </span>
          </div>
        )}
        {isVideo && !limits.videoExport.ok && <p className="simple-note" data-ui="video-limit">{limits.videoExport.reason}</p>}
        {output === 'video' && <p className="output-stage__note">動画の長さはそのまま（最後の余韻は動画の終わりで自然に消します）。最後のフレームを延ばして余韻を残す設定は STUDIO にあります。</p>}
        <div className="simple-export-actions">
          <button type="button" className="btn-export btn-export--primary" data-ui="export" disabled={running || blocked !== null} onClick={start}>
            {running ? '加工中…' : !processing ? (output === 'video' ? '動画を作る' : 'WAV を作る') : output === 'video' ? `${label} で動画を作る` : `${label} で WAV を作る`}
          </button>
          {running && (
            <button type="button" className="btn-chip" data-ui="cancel" onClick={cancel}>
              キャンセル
            </button>
          )}
        </div>
        {blocked && !running && <p className="simple-note">{blocked}</p>}
        {audio && !blocked && (
          <p className={`simple-note${heavy ? ' simple-note--warn' : ''}`} data-ui="memory-estimate">
            加工に使うメモリの目安: 約 {formatBytes(need)}（上限 {formatBytes(budget)}）。
            {heavy ? ' 長い・大きいファイルです。他のアプリやブラウザのタブを閉じて、PC の空きメモリに余裕がある状態で加工してください（足りないと途中で失敗します）。' : ''}
          </p>
        )}
        {progress && (
          <StageTrack stages={stages} current={progress.stage} fraction={progress.fraction} fractionLabel={progress.stage === 'rendering' ? '加工済み' : progress.stage === 'muxing' ? '書き込み済み' : undefined} />
        )}
        {job?.state === 'cancelled' && <p className="output-stage__note">キャンセルしました（ファイルは作成していません）。もう一度「作る」を押すと最初からやり直します。</p>}
        {job?.state === 'error' && <ExportError message={job.message} detail={job.detail} onRetry={blocked ? undefined : start} />}
      </Section>

      <Section step={5} title="完成ファイル" className="simple-card--result" aside={job?.state === 'complete' ? <Badge tone="live">COMPLETE</Badge> : undefined}>
        {job?.state === 'complete' ? (
          <div className="simple-result" data-ui="result">
            <StageTrack stages={stages} current="complete" />
            <p className="file-name" title={job.fileName}>
              {job.fileName}
            </p>
            <p className="output-stage__note mono">
              {'result' in job && 'bitDepth' in job.result
                ? `WAV ${job.result.bitDepth}-bit / ${formatHz(job.result.sampleRate)} / ${formatTime(job.result.frames / job.result.sampleRate, true)} / ${formatBytes(job.result.blob.size)}`
                : 'result' in job && 'videoPackets' in job.result
                  ? `${audio?.video?.info.container.toUpperCase() ?? ''} / 映像 ${job.result.videoEnd.toFixed(1)} 秒（コピー）/ 音声 ${job.result.audioCodec === 'aac' ? 'AAC' : 'Opus'} / ${formatBytes(job.result.blob.size)}`
                  : ''}
            </p>
            <a className="btn-export btn-export--download" href={job.url} download={job.fileName} data-ui="download">
              {output === 'video' ? '動画をダウンロード' : 'WAV をダウンロード'}
            </a>
            <MediaCompare
              kind={output === 'video' ? 'video' : 'audio'}
              exportedUrl={job.url}
              originalUrl={output === 'video' ? (canPlayInput ? originalUrl : null) : originalUrl}
              enginePlaying={player.status === 'playing'}
              onPlay={player.pause}
              volume={player.volume}
              note="完成したファイルそのものを再生します。ORIGINAL に切り替えると元のファイルを同じ位置から再生します。"
            />
          </div>
        ) : (
          <p className="empty-note">{running ? '加工が終わると、ここで完成ファイルを試聴・ダウンロードできます。' : '「作る」を押すと、ここに完成ファイルが表示されます。'}</p>
        )}
      </Section>
    </>
  )
}

/** SIMPLE MODE: アップロード → プリセット → プレビュー → 加工 → ダウンロード の一本道 */
export const SimpleView = memo(function SimpleView({ player, onOpenStudio }: SimpleViewProps) {
  const { audio, presetState: ps, exportState: ex, videoState: vs } = player
  const limits = platformLimits()
  const hasSetting = ps.source !== null || ps.activeId !== null || ps.savedActive
  const complete = ex.state === 'complete' || (vs.state === 'complete' && vs.kind === 'video')
  const running = ex.state === 'running' || vs.state === 'running'
  const current = !audio ? 0 : !hasSetting ? 1 : complete ? 4 : running ? 3 : 2

  return (
    <div className="simple" data-view="simple">
      {limits.notice && <p className="notice simple-platform">{limits.notice}</p>}
      <StepBar current={current} />
      <div className="simple-grid">
        <div className="simple-col">
          <section className="simple-card simple-upload" aria-label="ファイルを選ぶ">
            <header className="simple-card__head">
              <span className="simple-card__step">STEP 1</span>
              <h2 className="simple-card__title">ファイルを選ぶ（音声・動画）</h2>
            </header>
          <UploadZone
            index="1"
            label="STEP"
            loadingName={player.loadingName}
            error={player.error}
            hasAudio={audio !== null}
            onFile={player.loadFile}
            onDismissError={player.clearError}
          />
          </section>
          <section className="simple-card" aria-label="ファイル情報">
            <header className="simple-card__head">
              <span className="simple-card__step">FILE</span>
              <h2 className="simple-card__title">ファイル情報</h2>
            </header>
            <FileSummary player={player} />
          </section>
        </div>
        <div className="simple-col simple-col--main">
          <Section step={2} title="プリセットを選ぶ">
            <PresetCards player={player} onOpenStudio={onOpenStudio} />
          </Section>
          <Section step={3} title="プレビュー" aside={<span className="simple-card__hint">ヘッドホンでの試聴がおすすめ</span>}>
            <Preview player={player} />
          </Section>
          <ExportFlow player={player} />
        </div>
      </div>
    </div>
  )
})
