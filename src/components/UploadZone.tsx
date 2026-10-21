import { memo,useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { LoadError } from '../types/audio'
import { ACCEPT_ATTR, MAX_FILE_BYTES, MAX_VIDEO_BYTES } from '../utils/fileValidation'
import { formatBytes } from '../utils/format'
import { UploadIcon } from './Icons'
import { Panel } from './Panel'

interface UploadZoneProps {
  loadingName: string | null
  error: LoadError | null
  hasAudio: boolean
  onFile: (file: File) => void
  onDismissError: () => void
  /** パネルの番号（SIMPLE MODE では手順の番号） */
  index?: string
  label?: string
}

export const UploadZone = memo(function UploadZone({ loadingName, error, hasAudio, onFile, onDismissError, index = '01', label = 'INPUT' }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  // 子要素への出入りで dragleave が発火するため、ネスト数で判定する
  const dragDepth = useRef(0)

  const openPicker = () => inputRef.current?.click()

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    onFile(files[0])
  }

  const onDragEnter = (e: DragEvent) => {
    e.preventDefault()
    dragDepth.current++
    setDragging(true)
  }
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDragOver = (e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    handleFiles(e.dataTransfer.files)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openPicker()
    }
  }

  const loading = loadingName !== null

  return (
    <Panel index={index} label={label} title="ファイルの読み込み（音声・動画）" className="panel--upload" id={label === 'INPUT' ? 'studio-input' : undefined}>
      <div
        className={`dropzone${dragging ? ' is-dragging' : ''}${loading ? ' is-loading' : ''}`}
        role="button"
        tabIndex={0}
        aria-busy={loading}
        aria-label="音声・動画ファイルを選択、またはここにドロップ"
        onClick={openPicker}
        onKeyDown={onKeyDown}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          hidden
          onChange={(e) => {
            handleFiles(e.target.files)
            // 同じファイルを再選択しても change が発火するようにする
            e.target.value = ''
          }}
        />
        {loading ? (
          <>
            <div className="spinner" aria-hidden="true" />
            <p className="dropzone__title">読み込み中…</p>
            <p className="dropzone__sub" title={loadingName}>
              {loadingName}
            </p>
          </>
        ) : (
          <>
            <div className="dropzone__icon">
              <UploadIcon />
            </div>
            <p className="dropzone__title">
              {dragging ? 'ここにドロップ' : hasAudio ? '別のファイルに差し替え' : 'ここに音声・動画ファイルをドロップ'}
            </p>
            <p className="dropzone__sub">
              または <span className="link-like">ファイルを選択</span>
            </p>
            <p className="dropzone__formats">
              音声: WAV / MP3（FLAC・Ogg・M4A はブラウザが対応していれば可）・最大 {formatBytes(MAX_FILE_BYTES)}
              <br />
              動画: MP4 / MOV / WebM / MKV（音声トラックが必要）・最大 {formatBytes(MAX_VIDEO_BYTES)}
            </p>
          </>
        )}
      </div>

      {error && (
        <div className="alert" role="alert">
          <div className="alert__body">
            <p className="alert__title">{error.message}</p>
            {error.detail && <p className="alert__detail">{error.detail}</p>}
            {hasAudio && <p className="alert__detail">直前に読み込んだファイルはそのまま保持しています。</p>}
          </div>
          <button type="button" className="alert__close" onClick={onDismissError} aria-label="エラーを閉じる">
            ×
          </button>
        </div>
      )}
    </Panel>
  )
})
