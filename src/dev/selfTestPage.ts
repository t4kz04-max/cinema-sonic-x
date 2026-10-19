import { runDspSelfTest, type TestResult } from './dspSelfTest'
import { runMotionCpuTest, runMotionSelfTest } from './motionSelfTest'
import { runPresetCpuTest, runPresetSelfTest } from './presetSelfTest'
import { runSpatialSelfTest } from './spatialSelfTest'
import { runTailBaseline } from './tailBaseline'
import { runTailCpuTest, runTailSelfTest } from './tailSelfTest'

const out = document.getElementById('out')!
out.textContent = '実行中…'
const suiteName = new URLSearchParams(location.search).get('suite')
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
