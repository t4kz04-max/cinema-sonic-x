// 解析用フレーム（analysis-frame.html、Phase 09）。親から解析用の抜粋と呼び出しを受け取り、処理計画（重低音・空間のラウドネス合わせ）を
// このフレームの OfflineAudioContext で計算して返す。
// Chrome は AudioWorklet を読み込んだ OfflineAudioContext を解放しない（解析 1 回あたり数 MB〜20 MB 以上が残る）。親はしばらく使わないと
// このフレームごと削除する。フレームの文書が破棄されると、中の文脈・ワークレットも解放される（書き出し用フレームと同じ仕組み）。
// 計算は解析の関数（analysis.ts / spatialAnalysis.ts）をそのまま使う（解析の内容は変えない）

import { analyzeSource, planProcessing } from '../analysis'
import { analysisStats } from '../analysisStats'
import { analyzeSpatialSource, planSpatial } from '../spatial/spatialAnalysis'
import type { AnalysisCall, AnalysisFrameMessage, AnalysisParentMessage } from './analysisProtocol'

const post = (m: AnalysisFrameMessage) => parent.postMessage(m, location.origin)
const excerpts = new Map<string, AudioBuffer>()

function excerptOf(id: string): AudioBuffer {
  const b = excerpts.get(id)
  if (!b) throw new Error(`解析用の抜粋がありません（${id}）`)
  return b
}

function run(call: AnalysisCall): Promise<unknown> {
  switch (call.kind) {
    case 'analyzeSource':
      return analyzeSource(excerptOf(call.excerpt))
    case 'planProcessing':
      return planProcessing(excerptOf(call.excerpt), call.source, call.params, call.opts)
    case 'analyzeSpatialSource':
      return analyzeSpatialSource(excerptOf(call.excerpt))
    case 'planSpatial':
      return planSpatial(excerptOf(call.excerpt), call.before, call.params, call.opts)
  }
}

window.addEventListener('message', (e: MessageEvent<AnalysisParentMessage>) => {
  if (e.origin !== location.origin || e.source !== parent) return
  const m = e.data
  if (m.type === 'excerpt') {
    const b = new AudioBuffer({ length: m.channels[0].length, numberOfChannels: m.channels.length, sampleRate: m.sampleRate })
    m.channels.forEach((ch, c) => b.copyToChannel(ch, c))
    excerpts.set(m.id, b)
    return
  }
  // 1 つずつ順に実行する（呼び出しごとの文脈の数を正しく数えるため。親の解析の回数の表示・試験に使う）
  queue = queue.then(async () => {
    const r0 = analysisStats.renders
    const w0 = analysisStats.workletRenders
    try {
      const value = await run(m.call)
      post({ type: 'result', callId: m.callId, value, renders: analysisStats.renders - r0, workletRenders: analysisStats.workletRenders - w0 })
    } catch (err) {
      post({ type: 'error', callId: m.callId, name: err instanceof Error ? err.name : 'Error', message: err instanceof Error ? err.message : String(err) })
    }
  })
})

let queue: Promise<void> = Promise.resolve()

post({ type: 'ready' })
