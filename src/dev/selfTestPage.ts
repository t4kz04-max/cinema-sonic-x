import { runDspSelfTest, type TestResult } from './dspSelfTest'
import { runMotionCpuTest, runMotionSelfTest } from './motionSelfTest'
import { runSpatialSelfTest } from './spatialSelfTest'
import { runTailBaseline } from './tailBaseline'
import { runTailCpuTest, runTailSelfTest } from './tailSelfTest'

const out = document.getElementById('out')!
out.textContent = '実行中…'
const suiteName = new URLSearchParams(location.search).get('suite')
const SUITES: Record<string, () => Promise<TestResult[]>> = { spatial: runSpatialSelfTest, spatialcore: () => runSpatialSelfTest(false), motion: runMotionSelfTest, cpu: runMotionCpuTest, baseline: runTailBaseline, tail: runTailSelfTest, tailcpu: runTailCpuTest }
const suite = (suiteName && SUITES[suiteName]) || runDspSelfTest
suite()
  .then((results) => {
    const failed = results.filter((r) => !r.pass).length
    let group = ''
    out.textContent = results
      .map((r) => {
        const head = r.group !== group ? `\n■ ${(group = r.group)}\n` : ''
        return `${head}${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`
      })
      .join('\n')
    document.title = failed === 0 ? `ALL PASS (${results.length})` : `FAIL ${failed}/${results.length}`
    document.body.dataset.done = 'true'
  })
  .catch((e: unknown) => {
    out.textContent = `ERROR: ${e instanceof Error ? e.stack : String(e)}`
    document.title = 'ERROR'
    document.body.dataset.done = 'true'
  })
