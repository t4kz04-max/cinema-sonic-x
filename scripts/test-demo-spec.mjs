// 公式デモ音源の定義（区間・判定）の試験。ブラウザなしで実行できる純粋関数だけを確かめる。
// 使い方: npm run test:demo（Node 22.18+ / 24 の TypeScript の型の除去で src/demo/demoSpec.ts を直接読み込む）
import { existsSync, readFileSync } from 'node:fs'
import { demoOfSource, getDemo, sectionIndexAt, sectionsCover, SPATIAL_SHOWCASE } from '../src/demo/demoSpec.ts'

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const d = SPATIAL_SHOWCASE
const S = d.sections
check('区間は 5 つ（Intro / Groove / Main / Space / Outro）', S.map((s) => s.label).join('|') === 'Intro|Groove|Main|Space|Outro')
check('区間の境目（0 / 4 / 12 / 28 / 36 / 40 秒）', S.map((s) => `${s.start}-${s.end}`).join(',') === '0-4,4-12,12-28,28-36,36-40')
check('区間が 0 秒から 40 秒まで隙間・重なりなく覆う', sectionsCover(S, d.durationSeconds))
const at = (t) => (sectionIndexAt(S, t) >= 0 ? S[sectionIndexAt(S, t)].id : null)
const cases = [
  [0, 'intro'], [3.999, 'intro'], [4, 'groove'], [11.99, 'groove'], [12, 'main'], [27.99, 'main'],
  [28, 'space'], [35.99, 'space'], [36, 'outro'], [40, 'outro'], [40.01, null], [-0.01, null], [NaN, null],
]
const bad = cases.filter(([t, id]) => at(t) !== id)
check('再生位置 → 区間（境目は後ろの区間・終わりの 40 秒は Outro・範囲外は なし）', bad.length === 0, bad.map(([t, id]) => `${t}: ${at(t)}≠${id}`).join(', '))
check('定義は凍結（書き換えない）', Object.isFrozen(d) && Object.isFrozen(d.sections))
check('出どころでの判定（ファイル名ではなく source）', demoOfSource({ kind: 'demo', demoId: 'spatial-showcase' }) === d && demoOfSource({ kind: 'upload' }) === null && demoOfSource(null) === null && getDemo('spatial-showcase') === d)
check('URL は同じサイトの静的ファイル（外部のサーバーではない）', d.url.startsWith('/') && !d.url.startsWith('//'))
check('ファイル名の拡張子が .wav（通常の読み込みと同じ形式の判定）', /\.wav$/.test(d.fileName))

// 配置した音源のヘッダー（48 kHz・ステレオ・24-bit PCM・40 秒）
const path = new URL('../public/audio/spatial-showcase.wav', import.meta.url)
if (!existsSync(path)) check('音源ファイル public/audio/spatial-showcase.wav がある', false, '未配置')
else {
  const b = readFileSync(path)
  let o = 12
  let fmt = null
  let data = 0
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4)
    const len = b.readUInt32LE(o + 4)
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(o + 8), channels: b.readUInt16LE(o + 10), sampleRate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) }
    if (id === 'data') {
      data = len
      break
    }
    o += 8 + len + (len % 2)
  }
  const seconds = fmt ? data / (fmt.channels * (fmt.bits / 8)) / fmt.sampleRate : 0
  check('音源のヘッダー: RIFF/WAVE・PCM・ステレオ・48 kHz・24-bit・40 秒', b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' && fmt?.format === 1 && fmt.channels === 2 && fmt.sampleRate === 48000 && fmt.bits === 24 && Math.abs(seconds - d.durationSeconds) < 1e-6, `${JSON.stringify(fmt)} ${seconds} 秒 ${b.length} バイト`)
  check('取得前に表示する大きさの目安が実際と一致', b.length === d.approxBytes, `${b.length} / ${d.approxBytes}`)
}

const failed = results.filter((r) => !r).length
console.log(failed === 0 ? `\nALL PASS (${results.length})` : `\nFAIL ${failed}/${results.length}`)
process.exit(failed === 0 ? 0 : 1)
