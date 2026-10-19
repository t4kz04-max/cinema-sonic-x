// DSP 自己診断（tests/dsp-selftest.html）をヘッドレスの Chrome / Edge で実行する。
// 使い方: npm run test:dsp            （重低音エンジン。Chrome → Edge の順に自動検出）
//         npm run test:spatial        （空間音響プロトタイプ ＋ Motion。スイートごとにブラウザを起動し直す）
//         npm run test:tail           （Phase 04: Spatial Tail / Loop / STOP・PAUSE・CUT。4 つに分けて実行）
//         npm run test:preset         （Phase 05: プリセット / A/B 比較 / CUSTOM / 解析の最適化。13 に分けて実行）
//         npm run test:export         （Phase 06: 書き出し / WAV / リアルタイムとの一致 / メモリ / キャンセル）
//         node scripts/run-dsp-selftest.mjs --suite=cpu   （個別スイート。--log で途中経過を表示）
//         node scripts/run-dsp-selftest.mjs --suite=tail --query=groups=26-32   （一部のグループだけ）
//         CSX_BROWSER=<実行ファイル> npm run test:dsp
// 依存追加なし: Vite の開発サーバー + Chrome DevTools Protocol（Node 22+ の組み込み WebSocket）
//
// Chrome は AudioWorklet を読み込んだ OfflineAudioContext を解放しないため、試験が進むほどヘッドレスブラウザの
// メモリが増える。重いスイートはブラウザを起動し直して分けて実行し、空きメモリが少なくなったら中断する。

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { freemem, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'

const CANDIDATES = [
  process.env.CSX_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

const browser = CANDIDATES.find((p) => existsSync(p))
if (!browser) {
  console.error('Chrome / Edge が見つかりません。CSX_BROWSER に実行ファイルのパスを指定してください。')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const showLog = process.argv.includes('--log')
// --suite=<名前>: 個別のスイート / --spatial: 空間音響一式（spatialcore → motion を別々のブラウザで）
const named = process.argv.find((a) => a.startsWith('--suite='))?.slice(8)
// --query=<k=v>: ページに渡す追加のパラメーター
const extra = process.argv.find((a) => a.startsWith('--query='))?.slice(8)
// --tail: Phase 04 一式（グループを 4 つに分けて別々のブラウザで） / --preset: Phase 05 一式
const suites = named
  ? [named]
  : process.argv.includes('--spatial')
    ? ['spatialcore', 'motion']
    : process.argv.includes('--tail')
      ? ['tail&groups=20-28', 'tail&groups=29-32', 'tail&groups=33-35', 'tail&groups=36-39']
      : process.argv.includes('--preset')
        ? [
            'preset&groups=40-41',
            'preset&groups=42-42',
            'preset&groups=43-43',
            'preset&groups=44-45',
            'preset&groups=46-46',
            'preset&groups=47-47',
            'preset&groups=48-48',
            'preset&groups=49-49&program=pop',
            'preset&groups=49-49&program=mix',
            'preset&groups=49-49&program=acoustic',
            'preset&groups=50-50',
            'preset&groups=51-51',
            'presetcpu',
          ]
        : process.argv.includes('--export')
          ? [
              'export&groups=60-62',
              'export&groups=63-64',
              'export&groups=65-65&cases=0,1,2,3',
              'export&groups=65-65&cases=4,5,6,7',
              'export&groups=66-66',
              'export&groups=67-67',
              'export&groups=68-68',
              'export&groups=69-71',
            ]
          : ['']
const MIN_FREE_MB = Number(process.env.CSX_MIN_FREE_MB ?? 400)

const server = await createServer({ logLevel: 'error', server: { port: 5199, strictPort: false } })
await server.listen()

/** 1 つのスイートを新しいブラウザで実行する */
async function runSuite(suite) {
  const params = [suite && `suite=${suite}`, extra].filter(Boolean).join('&')
  const pageUrl = new URL(`tests/dsp-selftest.html${params ? `?${params}` : ''}`, server.resolvedUrls.local[0]).href
  const port = 9300 + Math.floor(Math.random() * 500)
  const profile = mkdtempSync(join(tmpdir(), 'csx-selftest-'))
  const proc = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--js-flags=--expose-gc',
      // performance.memory を丸めずに更新する（メモリ使用量の試験の参考値）
      '--enable-precise-memory-info',
      // 実時間の再生エンジンの試験（ユーザー操作なしで AudioContext を動かす）
      '--autoplay-policy=no-user-gesture-required',
      // 常駐メモリを減らす（テスト中に他のアプリを圧迫しないように）
      '--disable-extensions',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-sync',
      '--no-default-browser-check',
      '--renderer-process-limit=1',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  /** 起動したブラウザ（このプロファイルを使うプロセス群）の物理メモリ使用量（MB）。測れない環境では null */
  const browserMemoryMb = () => {
    try {
      if (process.platform === 'win32') {
        const dir = profile.replace(/'/g, "''")
        const out = execFileSync(
          'powershell',
          ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir}') } | Measure-Object -Property WorkingSetSize -Sum).Sum`],
          { encoding: 'utf8' },
        )
        return Number(out.trim()) / 2 ** 20
      }
      const out = execFileSync('ps', ['-axo', 'rss=,command='], { encoding: 'utf8' })
      return out
        .split('\n')
        .filter((l) => l.includes(profile))
        .reduce((s, l) => s + Number(l.trim().split(/\s+/)[0]) / 1024, 0)
    } catch {
      return null
    }
  }

  const result = { done: false, lowMemory: false, title: '', text: '' }
  try {
    let target
    for (let i = 0; i < 80 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
        target = list.find((t) => t.type === 'page')
      } catch {
        // 起動待ち
      }
      if (!target) await sleep(250)
    }
    if (!target) throw new Error('ブラウザの DevTools に接続できませんでした')

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((r) => ws.addEventListener('open', r))
    let id = 0
    const pending = new Map()
    const send = (method, p = {}) =>
      new Promise((r) => {
        const i = ++id
        pending.set(i, r)
        ws.send(JSON.stringify({ id: i, method, params: p }))
      })
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      // --log: ページの console.info（試験の途中経過）をそのまま表示する
      if (showLog && m.method === 'Runtime.consoleAPICalled' && m.params.type === 'info') console.log(m.params.args.map((a) => a.value ?? a.description).join(' '))
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m)
        pending.delete(m.id)
      }
      // ページからのメモリ測定の依頼（window.csxMemSample(id)）: 測った値を window.__csxMem[id] に書き戻す
      if (m.method === 'Runtime.bindingCalled' && m.params.name === 'csxMemSample') {
        const mb = browserMemoryMb()
        void send('Runtime.evaluate', { expression: `(window.__csxMem ||= {})[${JSON.stringify(m.params.payload)}] = ${mb === null ? 'null' : mb.toFixed(1)}` })
      }
    })

    await send('Runtime.enable')
    await send('Runtime.addBinding', { name: 'csxMemSample' })
    await send('Page.navigate', { url: pageUrl })
    const deadline = Date.now() + 1_800_000 // Motion・Tail のスイートはそれぞれ数分〜10 分かかる
    while (!result.done && Date.now() < deadline) {
      await sleep(500)
      // 空きメモリが少なくなったら中断する（ヘッドレスブラウザが他のアプリを圧迫しないように）
      if (freemem() / 2 ** 20 < MIN_FREE_MB) {
        result.lowMemory = true
        break
      }
      result.done = await evaluate(`document.body?.dataset.done === 'true'`)
    }
    const [title, text] = (await evaluate(`[document.title, document.getElementById('out')?.textContent ?? '']`)) ?? []
    result.title = title ?? ''
    result.text = text ?? ''
    ws.close()
  } catch (e) {
    console.error(e)
  } finally {
    // Windows では proc.kill() だと子プロセス（レンダラー等）が残るため、起動したブラウザのプロセスツリーごと終了する
    if (process.platform === 'win32' && proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    else proc.kill()
    await sleep(1000)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      // ブラウザがロックを保持している場合は残す
    }
  }
  return result
}

let exitCode = 0
console.log(`ブラウザ: ${browser}\n`)
for (const suite of suites) {
  const r = await runSuite(suite)
  if (suites.length > 1) console.log(`━━ スイート: ${suite} ━━`)
  console.log(r.text)
  console.log(`\n${r.done ? r.title : r.lowMemory ? `ABORTED（空きメモリ ${MIN_FREE_MB} MB 未満のため中断。結果は未完了）` : 'TIMEOUT'}\n`)
  if (!(r.done && r.title.startsWith('ALL PASS'))) exitCode = 1
  if (!r.done) break
}
await server.close()
process.exit(exitCode)
