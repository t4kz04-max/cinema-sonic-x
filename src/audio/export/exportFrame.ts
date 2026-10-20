// 書き出し用の使い捨てフレーム（export-frame.html）。親ウィンドウから要求を受け取り、レンダリングと WAV への変換を行って返す。
// Chrome は AudioWorklet を読み込んだ OfflineAudioContext を解放しないため、親は書き出しが終わる（またはキャンセルする）と
// このフレームごと削除する。フレームの文書が破棄されると、その中の文脈・ワークレット・バッファーも解放される。
// 2 段階: prepare（音源なし。文脈・ワークレットを準備）→ render（音源を受け取ってレンダリング）。各段階の開始・完了・失敗を親へ送る（監視・記録用）

import type { ExportRequest } from './exportSpec'
import type { FrameMessage, ParentMessage, PrepareRequest } from './exportProtocol'
import { prepareRender, renderExport, type PreparedRender, type TraceFn } from './renderExport'

const post = (m: FrameMessage, transfer: Transferable[] = []) => parent.postMessage(m, location.origin, transfer)
let jobId = '?'
let jobAttempt = 0
/**
 * 段階の記録: 親へ送る（監視・記録）と同時に console.debug にも出す。このフレームは親と同じスレッドで動くため、
 * フレーム内でスレッドが止まると親は記録を受け取れない。console の出力は呼んだ時点で DevTools に送られるので、
 * 止まる直前の段階まで残る（試験のランナーが --log で表示する）。音声の内容・ファイル名は出さない
 */
const trace: TraceFn = (stage, phase, detail) => {
  console.debug('[CINEMA SONIC X] export-trace', JSON.stringify({ id: jobId, attempt: jobAttempt, stage, phase, t: Math.round(performance.now()), detail }))
  post({ type: 'trace', stage, phase, detail })
}
const fail = (err: unknown) => post({ type: 'error', name: err instanceof Error ? err.name : 'Error', message: err instanceof Error ? err.message : String(err) })

let pending: { request: PrepareRequest; attempt: number; prepared: Promise<PreparedRender> } | null = null

window.addEventListener('message', (e: MessageEvent<ParentMessage>) => {
  if (e.origin !== location.origin || e.source !== parent) return
  const m = e.data
  if (m.type === 'prepare') {
    jobId = m.id
    jobAttempt = m.attempt
    const prepared = prepareRender(m.request, trace, m.attempt)
    pending = { request: m.request, attempt: m.attempt, prepared }
    prepared.then(() => post({ type: 'prepared' }), fail)
  } else if (m.type === 'render' && pending) {
    const { request, attempt, prepared } = pending
    pending = null
    trace('transfer', 'end')
    const req: ExportRequest = { ...request, channels: m.channels }
    prepared
      .then((p) => renderExport(req, (progress) => post({ type: 'progress', progress }), { trace, prepared: p, attempt, releaseInput: true }))
      .then((result) => post({ type: 'done', result }, result.float ? result.float.map((x) => x.buffer) : []))
      .catch(fail)
  }
})

post({ type: 'ready' })
