// 書き出し用の使い捨てフレーム（export-frame.html）。親ウィンドウから要求を受け取り、レンダリングと WAV への変換を行って返す。
// Chrome は AudioWorklet を読み込んだ OfflineAudioContext を解放しないため、親は書き出しが終わる（またはキャンセルする）と
// このフレームごと削除する。フレームの文書が破棄されると、その中の文脈・ワークレット・バッファーも解放される。

import type { ExportRequest } from './exportSpec'
import type { FrameMessage, ParentMessage } from './exportProtocol'
import { renderExport } from './renderExport'

const post = (m: FrameMessage, transfer: Transferable[] = []) => parent.postMessage(m, location.origin, transfer)

window.addEventListener('message', (e: MessageEvent<ParentMessage>) => {
  if (e.origin !== location.origin || e.source !== parent) return
  const m = e.data
  if (m.type !== 'render') return
  const req: ExportRequest = m.request
  renderExport(req, (p) => post({ type: 'progress', progress: p }))
    .then((result) => post({ type: 'done', result }, result.float ? result.float.map((x) => x.buffer) : []))
    .catch((err: unknown) => {
      const name = err instanceof Error ? err.name : 'Error'
      const message = err instanceof Error ? err.message : String(err)
      post({ type: 'error', name, message })
    })
})

post({ type: 'ready' })
