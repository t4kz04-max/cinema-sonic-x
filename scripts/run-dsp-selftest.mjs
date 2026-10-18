// DSP 自己診断（tests/dsp-selftest.html）をヘッドレスの Chrome / Edge で実行する。
// 使い方: npm run test:dsp            （重低音エンジン。Chrome → Edge の順に自動検出）
//         npm run test:spatial        （空間音響プロトタイプ）
//         CSX_BROWSER=<実行ファイル> npm run test:dsp
// 依存追加なし: Vite の開発サーバー + Chrome DevTools Protocol（Node 22+ の組み込み WebSocket）

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
const server = await createServer({ logLevel: 'error', server: { port: 5199, strictPort: false } })
await server.listen()
const suite = process.argv.includes('--spatial') ? '?suite=spatial' : ''
const pageUrl = new URL(`tests/dsp-selftest.html${suite}`, server.resolvedUrls.local[0]).href

const port = 9300 + Math.floor(Math.random() * 500)
const profile = mkdtempSync(join(tmpdir(), 'csx-selftest-'))
const proc = spawn(
  browser,
  ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'],
  { stdio: 'ignore' },
)

let exitCode = 1
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
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id
      pending.set(i, r)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value

  await send('Page.navigate', { url: pageUrl })
  const deadline = Date.now() + 600_000
  let done = false
  while (!done && Date.now() < deadline) {
    await sleep(500)
    done = await evaluate(`document.body?.dataset.done === 'true'`)
  }
  const [title, text] = (await evaluate(`[document.title, document.getElementById('out')?.textContent ?? '']`)) ?? []
  console.log(`ブラウザ: ${browser}\n`)
  console.log(text)
  console.log(`\n${done ? title : 'TIMEOUT'}`)
  exitCode = done && title?.startsWith('ALL PASS') ? 0 : 1
  ws.close()
} catch (e) {
  console.error(e)
} finally {
  proc.kill()
  await server.close()
  await sleep(300)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // ブラウザがロックを保持している場合は残す
  }
}
process.exit(exitCode)
