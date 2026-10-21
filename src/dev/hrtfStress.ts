// Phase 09: Edge の HRTF の停止の再確認（?suite=hrtfstress、npm run test:hrtf）。
// アプリと同じ手順（再生エンジンを作る → 解析（解析用フレーム）→ 書き出し（書き出し用フレーム）→ エンジンを破棄）を、
// サンプルレートを 44.1 ↔ 48 kHz で切り替えながら繰り返す。途中で書き出しをキャンセルしてすぐに再実行する回も入れる。
// 止まった回（監視で打ち切り・解析の失敗・時間切れ）を数える。メインスレッドごと止まった場合はこの試験自体が終わらない
// （ランナーが TIMEOUT と表示する。結果なしとして扱う）。

import { AudioEngine } from '../audio/AudioEngine'
import { ExportCancelledError, ExportTimeoutError, recentExportTraces, startExport } from '../audio/export/exportRunner'
import { presetToDsp, SPATIAL_PRESETS } from '../audio/presets/spatialPresets'
import type { TestResult } from './dspSelfTest'
import { programStereoMix } from './testSignals'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 48 kHz の楽曲相当の信号を、指定のサンプルレートの AudioBuffer に入れ直す（内容は試験に関係しないので再標本化はしない） */
function bufferAt(rate: number, seconds: number): AudioBuffer {
  const src = programStereoMix(seconds)
  const out = new AudioBuffer({ length: Math.round(seconds * rate), numberOfChannels: 2, sampleRate: rate })
  for (let c = 0; c < 2; c++) out.copyToChannel(src.getChannelData(c).subarray(0, out.length), c)
  return out
}

export async function runHrtfStress(): Promise<TestResult[]> {
  const results: TestResult[] = []
  const q = new URLSearchParams(location.search)
  const rounds = Number(q.get('rounds') ?? 16)
  const group = `97. HRTF の停止の再確認（${rounds} 回、44.1 ↔ 48 kHz、キャンセルと再実行を含む）`
  const rates = [44100, 48000, 48000, 44100]
  const presets = [SPATIAL_PRESETS[3], SPATIAL_PRESETS[0], SPATIAL_PRESETS[2]]
  const log: string[] = []
  let stalls = 0
  let analysisErrors = 0
  let completed = 0
  let cancelled = 0
  for (let i = 0; i < rounds; i++) {
    const rate = rates[i % rates.length]
    const buf = bufferAt(rate, 6)
    const t0 = performance.now()
    // 毎回新しい再生エンジン（AudioContext を作って破棄する）
    const engine = new AudioEngine(1, { sampleRate: rate })
    let analysis = 'idle'
    engine.onDspStatusChange((s) => (analysis = `${s.analysis}/${s.spatial.analysis}`))
    let outcome = ''
    try {
      engine.setBuffer(buf)
      engine.applyDsp(presetToDsp(presets[i % presets.length]))
      const snap = await engine.exportSnapshot(90000)
      engine.holdAnalysis(true)
      await engine.suspendForExport()
      const req = () => ({ channels: [buf.getChannelData(0).slice(), buf.getChannelData(1).slice()], sampleRate: rate, ...snap, bitDepth: 16 as const, ditherSeed: 1 })
      if (i % 3 === 2) {
        // 書き出しのレンダリング中にキャンセル → すぐに再実行
        let rendering = false
        const job = startExport(req(), (p) => {
          if (p.stage === 'rendering') rendering = true
        })
        while (!rendering && performance.now() - t0 < 60000) await sleep(20)
        job.cancel()
        try {
          await job.promise
        } catch (e) {
          if (e instanceof ExportCancelledError) cancelled++
          else throw e
        }
      }
      const r = await startExport(req(), () => {}).promise
      completed++
      outcome = `完了 ${r.blob.size} バイト`
    } catch (e) {
      if (e instanceof ExportTimeoutError) stalls++
      else if (/解析|analysis/i.test(String(e)) || /error/.test(analysis)) analysisErrors++
      outcome = `${e instanceof Error ? e.name : 'Error'}: ${e instanceof Error ? e.message : String(e)}（解析 ${analysis}）`
    } finally {
      engine.holdAnalysis(false)
      engine.dispose()
    }
    log.push(`${i + 1}: ${rate} Hz ${presets[i % presets.length].label} ${(((performance.now() - t0) / 1000)).toFixed(1)} 秒 ${outcome}`)
  }
  const traces = recentExportTraces()
  const retried = traces.filter((t) => t.attempt > 1).length
  results.push({ group, name: `${rounds} 回とも監視の打ち切り・解析の失敗なしで完了`, pass: completed === rounds && stalls === 0 && analysisErrors === 0, detail: `完了 ${completed} / ${rounds}、打ち切り ${stalls}、解析の失敗 ${analysisErrors}、途中のキャンセル ${cancelled}、準備での自動やり直し ${retried} 回（直近 30 件の記録）` })
  results.push({ group, name: '各回の結果', pass: true, info: true, detail: log.join('\n      ') })
  return results
}
