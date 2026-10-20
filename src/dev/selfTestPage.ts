import { runDspSelfTest, type TestResult } from './dspSelfTest'
import { runMotionCpuTest, runMotionSelfTest } from './motionSelfTest'
import { runExportSelfTest } from './exportSelfTest'
import { runVideoSelfTest } from './videoSelfTest'
import { runPresetCpuTest, runPresetSelfTest } from './presetSelfTest'
import { runSpatialSelfTest } from './spatialSelfTest'
import { runTailBaseline } from './tailBaseline'
import { runTailCpuTest, runTailSelfTest } from './tailSelfTest'

const out = document.getElementById('out')!
out.textContent = '実行中…'
const suiteName = new URLSearchParams(location.search).get('suite')
// 調査用: nohrtfkeeper=1 で HRTF のデータの保持（hrtfKeeper.ts）を使わない（効果の比較）
if (new URLSearchParams(location.search).get('nohrtfkeeper') === '1') (globalThis as { __csxNoHrtfKeeper?: boolean }).__csxNoHrtfKeeper = true
// 調査用: traceaudio=1 でページ内の OfflineAudioContext のレンダリングの開始・完了を console.debug に出す（どのレンダリングで止まるか）
if (new URLSearchParams(location.search).get('traceaudio') === '1') {
  const orig = OfflineAudioContext.prototype.startRendering
  let n = 0
  OfflineAudioContext.prototype.startRendering = function (this: OfflineAudioContext) {
    const k = ++n
    const tag = JSON.stringify({ side: 'page', render: k, sampleRate: this.sampleRate, frames: this.length, channels: this.destination.channelCount })
    const stack = (new Error().stack ?? '').split('\n').slice(2, 5).map((l) => l.trim().replace(/\(?https?:\/\/[^/]+/, '').replace(/\?[^:]*/, '')).join(' < ')
    console.debug('[CINEMA SONIC X] export-trace', `start ${tag} ${stack}`)
    const p = orig.call(this)
    p.then(() => console.debug('[CINEMA SONIC X] export-trace', `end ${tag}`))
    return p
  }
}
const SUITES: Record<string, () => Promise<TestResult[]>> = {
  spatial: runSpatialSelfTest,
  spatialcore: () => runSpatialSelfTest(false),
  motion: runMotionSelfTest,
  cpu: runMotionCpuTest,
  baseline: runTailBaseline,
  tail: runTailSelfTest,
  tailcpu: runTailCpuTest,
  preset: runPresetSelfTest,
  presetcpu: runPresetCpuTest,
  export: runExportSelfTest,
  video: runVideoSelfTest,
}
const suite = (suiteName && SUITES[suiteName]) || runDspSelfTest
suite()
  .then((results) => {
    // INFO（合否を判定しない測定値）は PASS / FAIL の件数に含めない
    const judged = results.filter((r) => !r.info)
    const failed = judged.filter((r) => !r.pass).length
    const infos = results.length - judged.length
    let group = ''
    out.textContent = results
      .map((r) => {
        const head = r.group !== group ? `\n■ ${(group = r.group)}\n` : ''
        return `${head}${r.info ? 'INFO' : r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`
      })
      .join('\n')
    const note = infos > 0 ? ` + INFO ${infos}` : ''
    document.title = failed === 0 ? `ALL PASS (${judged.length})${note}` : `FAIL ${failed}/${judged.length}${note}`
    document.body.dataset.done = 'true'
  })
  .catch((e: unknown) => {
    out.textContent = `ERROR: ${e instanceof Error ? e.stack : String(e)}`
    document.title = 'ERROR'
    document.body.dataset.done = 'true'
  })
