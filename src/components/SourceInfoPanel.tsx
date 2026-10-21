import { memo } from 'react'
import type { LoadedAudio } from '../types/audio'
import { estimateDecodedBytes } from '../utils/fileValidation'
import { formatBytes, formatChannels, formatHz, formatTime } from '../utils/format'
import { Badge, Panel } from './Panel'

interface SourceInfoPanelProps {
  audio: LoadedAudio | null
}

interface Row {
  label: string
  value: string
  note?: string
}

function buildRows(audio: LoadedAudio): Row[] {
  const { buffer, header } = audio
  const resampled = header.sampleRate !== null && header.sampleRate !== buffer.sampleRate
  const v = audio.video?.info
  const rows: Row[] = [
    { label: '種類', value: v ? `動画（${v.container.toUpperCase()}）` : '音声' },
    ...(v
      ? [
          { label: '映像', value: `${v.video.width}×${v.video.height}${v.video.fps ? ` / ${v.video.fps.toFixed(2)} fps` : ''}`, note: `${v.video.codec}（書き出しでは再エンコードせずにコピー）` },
          { label: '動画の長さ', value: formatTime(v.duration, true) },
        ]
      : []),
    { label: v ? '音声の長さ' : '長さ', value: formatTime(buffer.duration, true) },
    {
      label: 'サンプルレート（元）',
      value: header.sampleRate !== null ? formatHz(header.sampleRate) : '取得できませんでした',
      note: 'ファイルヘッダーより',
    },
    {
      label: 'サンプルレート（デコード後）',
      value: formatHz(buffer.sampleRate),
      note: resampled ? 'ブラウザの出力レートへリサンプル済み' : 'AudioContext',
    },
    { label: 'チャンネル数', value: formatChannels(buffer.numberOfChannels) },
    { label: '形式', value: `${audio.format.toUpperCase()}${header.codec ? ` / ${header.codec}` : ''}` },
  ]
  if (header.bitDepth !== null) rows.push({ label: '量子化ビット数', value: `${header.bitDepth} bit` })
  if (header.bitrateKbps !== null) {
    rows.push({ label: 'ビットレート', value: `${header.bitrateKbps} kbps`, note: '先頭フレーム（VBRでは平均と異なる）' })
  }
  rows.push(
    { label: 'ファイルサイズ', value: formatBytes(audio.fileSizeBytes) },
    { label: 'デコード後メモリ', value: formatBytes(estimateDecodedBytes(buffer)), note: '32bit float PCM' },
  )
  return rows
}

export const SourceInfoPanel = memo(function SourceInfoPanel({ audio }: SourceInfoPanelProps) {
  return (
    <Panel
      index="02"
      label="SOURCE"
      title="音源情報"
      className="panel--info"
      aside={audio ? <Badge tone="live">デコード完了</Badge> : <Badge tone="idle">未読み込み</Badge>}
    >
      {audio ? (
        <>
          <p className="file-name" title={audio.fileName}>
            {audio.fileName}
          </p>
          <dl className="spec-list">
            {buildRows(audio).map((row) => (
              <div className="spec-list__row" key={row.label}>
                <dt>{row.label}</dt>
                <dd>
                  <span className="mono">{row.value}</span>
                  {row.note && <span className="spec-list__note">{row.note}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p className="empty-note">音源を読み込むと、ここにファイル名・長さ・サンプルレート・チャンネル数が表示されます。</p>
      )}
    </Panel>
  )
})
