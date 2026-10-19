// 書き出しの実行（親ウィンドウ側）。使い捨ての iframe（export-frame.html）でレンダリングし、終わったら iframe ごと削除する。
// キャンセルは iframe の削除（OfflineAudioContext には途中で止める API がないため、文書ごと破棄して止める）。
// 完了したときだけ結果（WAV の Blob）を返し、キャンセル・失敗時は結果を一切返さない。

import type { ExportProgress, ExportRequest, ExportResult } from './exportSpec'
import type { FrameMessage, ParentMessage } from './exportProtocol'

export class ExportCancelledError extends Error {
  constructor() {
    super('書き出しをキャンセルしました')
    this.name = 'ExportCancelledError'
  }
}

export interface ExportJob {
  promise: Promise<ExportResult>
  cancel(): void
}

/** フレームの準備（モジュールの読み込み）を待つ上限 */
const FRAME_READY_TIMEOUT_MS = 30000

/** 現在フレームが存在するか（試験用: キャンセル・完了後に残っていないことの確認） */
export const exportFrameCount = () => document.querySelectorAll('iframe[data-csx-export]').length

export function startExport(request: ExportRequest, onProgress: (p: ExportProgress) => void, frameUrl = `${import.meta.env.BASE_URL}export-frame.html`): ExportJob {
  let cancel: () => void = () => {}
  const promise = new Promise<ExportResult>((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.dataset.csxExport = ''
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden'
    let settled = false
    let readyTimer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      settled = true
      window.removeEventListener('message', onMessage)
      if (readyTimer) clearTimeout(readyTimer)
      frame.remove()
    }
    const onMessage = (e: MessageEvent<FrameMessage>) => {
      if (settled || e.source !== frame.contentWindow || e.origin !== location.origin) return
      const m = e.data
      if (m.type === 'ready') {
        if (readyTimer) clearTimeout(readyTimer)
        const msg: ParentMessage = { type: 'render', request }
        // 音源の PCM は転送する（呼び出し側はコピーを渡す）
        frame.contentWindow!.postMessage(msg, location.origin, request.channels.map((c) => c.buffer))
      } else if (m.type === 'progress') onProgress(m.progress)
      else if (m.type === 'done') {
        cleanup()
        resolve(m.result)
      } else if (m.type === 'error') {
        cleanup()
        const err = new Error(m.message)
        err.name = m.name
        reject(err)
      }
    }
    cancel = () => {
      if (settled) return
      cleanup()
      reject(new ExportCancelledError())
    }
    window.addEventListener('message', onMessage)
    readyTimer = setTimeout(() => {
      if (settled) return
      cleanup()
      reject(new Error('書き出し用のフレームを準備できませんでした'))
    }, FRAME_READY_TIMEOUT_MS)
    frame.src = frameUrl
    document.body.appendChild(frame)
  })
  return { promise, cancel: () => cancel() }
}
