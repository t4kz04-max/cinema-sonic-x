// Phase 08: UI の試験（SIMPLE / STUDIO）。実際のアプリ（index.html）をヘッドレスの Chrome / Edge で開き、
// ボタン・スライダー・ファイルの選択を操作して確認する。
// 使い方: npm run test:ui                      （Chrome → Edge の順に自動検出した 1 つ）
//         CSX_BROWSER=<実行ファイル> npm run test:ui
//         node scripts/run-ui-test.mjs --session=audio|video   （一部だけ）
//         node scripts/run-ui-test.mjs --screens=<フォルダー>   （確認用の画面写真を保存）
//         vercel env run -- node scripts/run-ui-test.mjs --session=demo --url=<Preview の URL>   （公開した Preview。保護は VERCEL_OIDC_TOKEN のヘッダーで通す）
//         node scripts/run-ui-test.mjs --preview   （本番ビルド（dist、先に npm run build）を vite preview で開く。Phase 10: 公開前の確認）
// 依存追加なし: Vite の開発サーバー + Chrome DevTools Protocol（Node 22+ の組み込み WebSocket）
// 試験用の音声（WAV）は Node で合成し、試験用の動画は src/dev/videoFixtures.ts（WebCodecs）でブラウザ内で作る。
// 2 つのセッション（音声 / 動画）を別々のブラウザで順に実行する（メモリを積み上げない）。

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { freemem, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, preview } from 'vite'

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
const onlySession = process.argv.find((a) => a.startsWith('--session='))?.slice(10)
const screensDir = process.argv.find((a) => a.startsWith('--screens='))?.slice(10)
const usePreview = process.argv.includes('--preview')
const MIN_FREE_MB = Number(process.env.CSX_MIN_FREE_MB ?? 400)
if (screensDir) mkdirSync(screensDir, { recursive: true })

// ---------- 試験用のファイル（Node で合成） ----------
const work = mkdtempSync(join(tmpdir(), 'csx-uitest-files-'))

/** 16-bit ステレオの WAV。和音（基音 + 倍音）・低音・拍ごとのノイズで楽曲相当の信号にする（乱数は固定の種） */
function makeWav(path, seconds, sampleRate = 48000) {
  const n = Math.round(seconds * sampleRate)
  const data = Buffer.alloc(n * 4)
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  const chords = [
    [220, 277.18, 329.63],
    [196, 246.94, 293.66],
    [174.61, 220, 261.63],
    [196, 246.94, 311.13],
  ]
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const beat = t % 0.5
    const chord = chords[Math.floor(t / 2) % chords.length]
    let l = 0
    let r = 0
    chord.forEach((f, k) => {
      const v = 0.08 * Math.sin(2 * Math.PI * f * t) + 0.03 * Math.sin(4 * Math.PI * f * t)
      l += v * (k === 0 ? 1 : 0.7)
      r += v * (k === 2 ? 1 : 0.7)
    })
    const kick = beat < 0.12 ? 0.35 * Math.sin(2 * Math.PI * (50 + 60 * Math.exp(-beat * 40)) * beat) * Math.exp(-beat * 18) : 0
    const hat = beat > 0.25 && beat < 0.28 ? 0.05 * rnd() : 0
    l += kick + hat
    r += kick + hat * 0.8
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l)) * 32767), i * 4)
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r)) * 32767), i * 4 + 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(2, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 4, 28)
  h.writeUInt16LE(4, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([h, data]))
  return path
}

const FILES = {
  music: makeWav(join(work, 'ui-test-music.wav'), 12),
  music2: makeWav(join(work, 'ui-test-music-2.wav'), 6, 44100),
  long: makeWav(join(work, 'ui-test-long.wav'), 90),
  text: join(work, 'not-audio.txt'),
  broken: join(work, 'broken.wav'),
}
writeFileSync(FILES.text, 'this is not audio')
writeFileSync(FILES.broken, Buffer.concat([Buffer.from('RIFF\x10\x00\x00\x00WAVEjunk'), Buffer.alloc(4000, 7)]))

// ---------- ページに入れる計測（文脈・Object URL はトップのページだけ。AudioWorklet の読み込みは iframe も） ----------
const INSTRUMENT = `(() => {
  if (window === window.top) window.__csxUi = { audioCtx: 0, offlineCtx: 0, created: 0, revoked: 0, urls: new Set(), worklets: [] }
  // Phase 10: AudioWorklet の読み込み（addModule）の成否を、ページ・解析用 iframe・書き出し用 iframe で記録する。
  // 読み込みに失敗するとアプリは簡易モード（DynamicsCompressor）に切り替えて動き続けるため、ほかの項目では気づけない（本番ビルドの URL の誤りなど）
  const where = window === window.top ? 'page' : location.pathname.replace(/^.*\\//, '')
  const log = (x) => {
    try {
      window.top.__csxUi.worklets.push(where + ':' + x)
    } catch {
      // トップのページの計測がない（試験の外）
    }
  }
  const W = window.AudioWorklet
  if (W) {
    const add = W.prototype.addModule
    W.prototype.addModule = function (url, ...rest) {
      const name = (String(url).match(/(\\w+)\\.worklet/) || [null, String(url)])[1]
      return add.call(this, url, ...rest).then(
        (v) => (log(name + ':ok'), v),
        (e) => {
          log(name + ':fail ' + e)
          throw e
        },
      )
    }
  }
  if (window !== window.top) return
  const c = window.__csxUi
  for (const [name, key] of [['AudioContext', 'audioCtx'], ['OfflineAudioContext', 'offlineCtx']]) {
    const O = window[name]
    if (!O) continue
    window[name] = class extends O {
      constructor(...a) {
        super(...a)
        c[key]++
      }
    }
  }
  const cu = URL.createObjectURL.bind(URL)
  const ru = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = (o) => {
    const u = cu(o)
    c.urls.add(u)
    c.created++
    return u
  }
  URL.revokeObjectURL = (u) => {
    c.urls.delete(u)
    c.revoked++
    return ru(u)
  }
})()`

// ページ内の操作の小道具（文字列で渡す）
const HELPERS = `(() => {
  const $ = (s) => document.querySelector(s)
  const $$ = (s) => [...document.querySelectorAll(s)]
  const byText = (sel, text) => $$(sel).find((e) => e.textContent.includes(text))
  const visible = (e) => !!e && e.getClientRects().length > 0 && !e.closest('[hidden]')
  /** React の制御されたスライダーを動かす（ネイティブの setter + input イベント + keyup で確定） */
  const setRange = (sel, v) => {
    const el = $(sel)
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }))
  }
  const parseTime = (s) => {
    const m = /(?:(\\d+):)?(\\d+):(\\d+)\\.(\\d+)/.exec(s || '')
    return m ? (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100) : NaN
  }
  const position = () => parseTime($('[data-ui="position"]')?.textContent)
  const view = () => $('[data-view]')?.dataset.view ?? null
  const counters = () => { const c = window.__csxUi; return { audioCtx: c.audioCtx, offlineCtx: c.offlineCtx, created: c.created, revoked: c.revoked, live: [...c.urls] } }
  async function wavInfo(url) {
    const b = new DataView(await (await fetch(url)).arrayBuffer())
    const tag = (o) => String.fromCharCode(b.getUint8(o), b.getUint8(o + 1), b.getUint8(o + 2), b.getUint8(o + 3))
    let o = 12, fmt = null, dataBytes = 0
    while (o + 8 <= b.byteLength) {
      const id = tag(o), len = b.getUint32(o + 4, true)
      if (id === 'fmt ') fmt = { channels: b.getUint16(o + 10, true), sampleRate: b.getUint32(o + 12, true), bits: b.getUint16(o + 22, true) }
      if (id === 'data') { dataBytes = len; break }
      o += 8 + len + (len % 2)
    }
    return { riff: tag(0), wave: tag(8), ...fmt, seconds: fmt ? dataBytes / (fmt.channels * fmt.bits / 8) / fmt.sampleRate : 0, bytes: b.byteLength }
  }
  async function headTag(url) {
    const b = new Uint8Array(await (await fetch(url)).arrayBuffer())
    return { size: b.length, tag: String.fromCharCode(...b.slice(4, 8)), ebml: b[0] === 0x1a && b[1] === 0x45 }
  }
  window.__ui = { $, $$, byText, visible, setRange, position, view, counters, wavInfo, headTag }
})()`

// ---------- ブラウザ ----------
// --preview: アプリは本番ビルド（dist）を開く。試験用の動画は src/dev（本番ビルドに含めない）で作るため、開発サーバーは動画の作成だけに使う
if (usePreview && !existsSync('dist/index.html')) {
  console.error('dist がありません。先に npm run build を実行してください。')
  process.exit(2)
}
const devServer = await createServer({ logLevel: 'error', server: { port: 5299, strictPort: false } })
await devServer.listen()
const fixtureUrl = devServer.resolvedUrls.local[0]
const server = usePreview ? await preview({ logLevel: 'error', preview: { port: 4299, strictPort: false } }) : devServer
// --url=<https://…>: 公開したデプロイ（Vercel の Preview など）を開く（--session=demo を想定。動画の試験用ファイルの作成には開発サーバーを使う）。
// 保護された Preview は、環境変数 VERCEL_OIDC_TOKEN（`vercel env run -- node …` が渡す短期のトークン）を、その URL のオリジンへの要求だけにヘッダーで付ける。値は表示しない
const remoteUrl = process.argv.find((a) => a.startsWith('--url='))?.slice(6) ?? null
const baseUrl = remoteUrl ? `${remoteUrl.replace(/\/$/, '')}/` : server.resolvedUrls.local[0]
const trustedToken = remoteUrl ? (process.env.VERCEL_OIDC_TOKEN ?? null) : null

const results = []
let currentSession = ''
function check(id, name, ok, detail = '') {
  results.push({ session: currentSession, id, name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${detail ? ` — ${detail}` : ''}`)
}
const info = (name, detail) => console.log(`INFO ${name} — ${detail}`)

async function launch() {
  const port = 9600 + Math.floor(Math.random() * 300)
  const profile = mkdtempSync(join(tmpdir(), 'csx-selftest-ui-'))
  const download = mkdtempSync(join(tmpdir(), 'csx-uitest-dl-'))
  const proc = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-sync',
      '--no-default-browser-check',
      '--renderer-process-limit=2',
      '--window-size=1440,900',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  let target
  for (let i = 0; i < 80 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page')
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
  const errors = []
  /** CDP のイベント（Fetch.requestPaused など）の受け取り */
  const handlers = new Map()
  const on = (method, fn) => handlers.set(method, fn)
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
    if (m.method && handlers.has(m.method)) handlers.get(m.method)(m.params)
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id
      pending.set(i, resolve)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  /** ページで式を評価する（Promise は待つ）。例外は文字列で返す */
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${HELPERS}; const u = window.__ui; return (${expr}) })()`, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(`評価に失敗: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}\n式: ${expr.slice(0, 200)}`)
    return r.result?.result?.value
  }
  /** 条件が真になるまで待つ（ms）。時間切れは false */
  const waitFor = async (expr, timeout = 20000, every = 100) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if (freemem() / 2 ** 20 < MIN_FREE_MB) throw new Error(`空きメモリが ${MIN_FREE_MB} MB 未満のため中断`)
      try {
        if (await ev(expr)) return true
      } catch {
        // 画面の切替中など
      }
      await sleep(every)
    }
    return false
  }
  const setFile = async (path) => {
    const doc = await send('DOM.getDocument', { depth: -1, pierce: false })
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' })
    await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [path] })
  }
  const shot = async (name) => {
    if (!screensDir) return
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    if (r.result?.data) writeFileSync(join(screensDir, `${name}.png`), Buffer.from(r.result.data, 'base64'))
  }
  const viewport = (width, height, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  const navigate = async (hash = '') => {
    await send('Page.navigate', { url: `${baseUrl}${hash}` })
    return waitFor(`!!document.querySelector('[data-view]')`, 30000)
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('DOM.enable')
  await send('Performance.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT })
  // 要求の差し替え（CDP の Fetch）。保護された Preview の認証ヘッダーと、試験のための応答の差し替え（デモの取得の失敗・保留）を 1 つにまとめる。
  // 認証ヘッダーは Network.setExtraHTTPHeaders では AudioWorklet の addModule の要求に付かない（SSO へ転送されて読み込みに失敗する）ため、
  // ネットワークの層（Fetch.continueRequest）で、開いたデプロイのオリジンへの要求だけに付ける。ほかのオリジンには付けない
  let interceptHook = null
  const authOrigin = trustedToken ? new URL(baseUrl).origin : null
  const continuePaused = (p) => {
    const add = authOrigin && new URL(p.request.url).origin === authOrigin
    const headers = add ? [...Object.entries(p.request.headers).map(([name, value]) => ({ name, value })), { name: 'x-vercel-trusted-oidc-idp-token', value: trustedToken }] : undefined
    return send('Fetch.continueRequest', { requestId: p.requestId, ...(headers ? { headers } : {}) })
  }
  handlers.set('Fetch.requestPaused', (p) => {
    if (interceptHook?.(p)) return
    void continuePaused(p)
  })
  /** hook(p) が true を返した要求は hook が応答する（fulfill / 保留）。null で差し替えをやめる（認証ヘッダーは付け続ける） */
  const intercept = async (hook, urlPattern) => {
    interceptHook = hook
    const patterns = [...(authOrigin ? [{ urlPattern: `${authOrigin}/*` }] : []), ...(hook && urlPattern ? [{ urlPattern }] : [])]
    await send(patterns.length ? 'Fetch.enable' : 'Fetch.disable', patterns.length ? { patterns } : {})
  }
  if (authOrigin) await intercept(null)
  // 公開したデプロイを開くとき: 同じオリジン以外への要求を記録する（音声・ファイル名を外へ送っていないことの確認。トークンを付けた要求が外へ出ていないことの確認）
  const foreign = []
  if (remoteUrl) {
    await send('Network.enable')
    const origin = new URL(baseUrl).origin
    handlers.set('Network.requestWillBeSent', (p) => {
      const u = p.request.url
      if (/^https?:/.test(u) && new URL(u).origin !== origin) foreign.push(u.slice(0, 120))
    })
  }
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: download })
  await viewport(1440, 900)
  const close = async () => {
    ws.close()
    if (process.platform === 'win32' && proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    else proc.kill()
    await sleep(1000)
    for (const d of [profile, download]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        // ロックが残っている場合は残す
      }
    }
  }
  const browserMemoryMb = () => {
    if (process.platform !== 'win32') return null
    try {
      const dir = profile.replace(/'/g, "''")
      const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir}') } | Measure-Object -Property WorkingSetSize -Sum).Sum`], { encoding: 'utf8' })
      return Number(out.trim()) / 2 ** 20
    } catch {
      return null
    }
  }
  const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]))
  return { send, on, intercept, continuePaused, ev, waitFor, setFile, shot, viewport, navigate, close, errors, foreign, download, browserMemoryMb, metrics }
}

/** 書き出しを始める（段階の表示の変化を記録する監視を付けてから押す） */
async function startExport(b) {
  await b.ev(`(() => {
    window.__stagesSeen = []
    window.__stageObs?.disconnect()
    const rec = () => { const c = document.querySelector('.export-stages li.is-current'); if (c && !window.__stagesSeen.includes(c.dataset.stage)) window.__stagesSeen.push(c.dataset.stage) }
    window.__stageObs = new MutationObserver(rec)
    window.__stageObs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
    u.$('[data-ui="export"]').click()
    return true
  })()`)
}

/** 書き出しが終わるまで待ち、途中で表示された段階を集める */
async function waitExport(b, timeout = 180000) {
  // 短い段階（ENCODING など）も取りこぼさないよう、段階の表示の変化を MutationObserver で集める
  const seen = new Set(await b.ev(`(window.__stagesSeen ?? []).slice()`))
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const s = await b.ev(`({ cur: u.$('.export-stages li.is-current')?.dataset.stage ?? null, done: !!u.$('[data-ui="result"]'), err: u.$('.alert--export .alert__title')?.textContent ?? null, cancelled: !!u.byText('.output-stage__note', 'キャンセルしました') })`)
    if (s.cur) seen.add(s.cur)
    for (const x of await b.ev(`window.__stagesSeen ?? []`)) seen.add(x)
    if (s.done || s.err || s.cancelled) return { ...s, seen: [...seen], ms: Date.now() - t0 }
    await sleep(50)
  }
  return { cur: null, done: false, err: 'TIMEOUT', seen: [...seen], ms: Date.now() - t0 }
}

/** 再生中の CPU（メインスレッドのスクリプト・レイアウト・スタイルの時間 / 経過時間） */
async function cpuDuring(b, ms) {
  const a = await b.metrics()
  const t0 = Date.now()
  await sleep(ms)
  const z = await b.metrics()
  const wall = (Date.now() - t0) / 1000
  const pct = (k) => ((100 * (z[k] - a[k])) / wall).toFixed(1)
  return { script: Number(pct('ScriptDuration')), layout: Number(pct('LayoutDuration')), style: Number(pct('RecalcStyleDuration')), task: Number(pct('TaskDuration')) }
}

/** 横にはみ出していないか・主な要素が見えているか */
async function layoutCheck(b, label) {
  return b.ev(`(() => {
    const over = document.documentElement.scrollWidth - window.innerWidth
    const wide = u.$$('.app *').filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && e.getClientRects().length && getComputedStyle(e).position !== 'fixed').slice(0, 3).map((e) => e.className || e.tagName)
    const clipped = u.$$('.simple-card *, .panel *').filter((e) => { if (!e.getClientRects().length || e.closest('[hidden]')) return false; const box = e.closest('.simple-card, .panel').getBoundingClientRect(); const r = e.getBoundingClientRect(); return r.width > 0 && r.right > box.right + 1 }).slice(0, 3).map((e) => (e.className || e.tagName) + ':' + (e.textContent || '').slice(0, 12))
    return { width: window.innerWidth, over, wide: [...wide, ...clipped], toggle: u.visible(u.$('.mode-toggle')), cols: getComputedStyle(u.$('.simple-presets') ?? document.body).gridTemplateColumns.split(' ').length, label: ${JSON.stringify(label)} }
  })()`)
}

// ================= セッション 1: 音声 =================
async function audioSession() {
  currentSession = 'audio'
  const b = await launch()
  try {
    // ---- 1. SIMPLE の表示 ----
    await b.navigate()
    const s1 = await b.ev(`({ view: u.view(), steps: u.$$('.simple-steps li').length, cards: u.$$('[data-preset]').map((e) => e.querySelector('.simple-preset__label').textContent), detail: !!u.byText('label', 'SPATIAL INTENSITY'), ranges: u.$$('input[type=range]').map((e) => e.id), upload: u.visible(u.$('.dropzone')), formats: u.$('.dropzone__formats').textContent, exportDisabled: u.$('[data-ui="export"]').disabled, hint: u.byText('.simple-note', 'ファイルを読み込んで')?.textContent ?? '' })`)
    check(1, 'SIMPLE の表示（既定・手順 5・プリセット 4 枚・詳細設定なし）', s1.view === 'simple' && s1.steps === 5 && s1.cards.join('|') === 'CINEMA 3D|LIVE ARENA|360° MOTION|IMMERSIVE X' && !s1.detail && s1.ranges.every((id) => /^simple-(seek|volume)$/.test(id)) && s1.upload, JSON.stringify({ cards: s1.cards, ranges: s1.ranges }))
    check(5, 'アップロード欄に実際に扱える形式（音声・動画）を表示', /WAV \/ MP3/.test(s1.formats) && /MP4 \/ MOV \/ WebM \/ MKV/.test(s1.formats), s1.formats)
    check(16, 'ファイルがないとき書き出しを押せず理由を表示', s1.exportDisabled && s1.hint.length > 0, s1.hint)
    await b.shot('01-simple-empty-1440')

    // ---- 17. レスポンシブ（空の状態） ----
    for (const [w, h, name] of [
      [1920, 1080, 'desktop'],
      [1366, 768, 'laptop'],
      [1024, 1366, 'tablet'],
      [768, 1024, 'tablet-portrait'],
      [390, 844, 'phone'],
    ]) {
      await b.viewport(w, h, w < 800)
      await sleep(300)
      const l = await layoutCheck(b, name)
      check(17, `レスポンシブ ${name} ${w}px: 横にはみ出さない・モード切替が見える`, l.over <= 0 && l.wide.length === 0 && l.toggle, `はみ出し ${l.over}px、プリセットの列 ${l.cols}${l.wide.length ? `、はみ出した要素 ${l.wide.join(', ')}` : ''}`)
      await b.shot(`02-simple-empty-${name}`)
    }
    await b.viewport(1440, 900)

    // ---- 16. エラー表示 ----
    await b.setFile(FILES.text)
    const e1 = await b.waitFor(`u.$('.alert[role=alert]')?.textContent.includes('非対応のファイル形式')`, 10000)
    check(16, 'エラー表示: 非対応の形式（.txt）', e1, await b.ev(`u.$('.alert[role=alert] .alert__title')?.textContent ?? ''`))
    await b.ev(`u.$('.alert__close').click()`)
    await b.setFile(FILES.broken)
    const e2 = await b.waitFor(`!!u.$('.alert[role=alert]')`, 15000)
    const e2text = await b.ev(`u.$('.alert[role=alert]')?.textContent ?? ''`)
    check(16, 'エラー表示: 壊れた WAV（読み込めない理由を表示・音源なしのまま）', e2 && e2text.length > 10 && !(await b.ev(`!!u.$('[data-ui="file-summary"]')`)), e2text.slice(0, 120))
    await b.ev(`u.$('.alert__close')?.click()`)

    // ---- 5. 音声のアップロード ----
    await b.setFile(FILES.music)
    const loaded = await b.waitFor(`!!u.$('[data-ui="file-summary"]')`, 30000)
    const summary = await b.ev(`u.$('[data-ui="file-summary"]').innerText`)
    check(5, '音声のアップロード: ファイル名・種類・再生時間・サンプルレート・チャンネル数', loaded && /ui-test-music\.wav/.test(summary) && /音声（WAV）/.test(summary) && /00:12\.00/.test(summary) && /48(\.0)? ?kHz/.test(summary) && /ステレオ|2/.test(summary), summary.replace(/\n/g, ' / '))
    const urlsAfterLoad = await b.ev(`u.counters()`)
    const ctxAfterLoad = urlsAfterLoad.audioCtx
    check(10, '再生エンジンの AudioContext は 1 つ', ctxAfterLoad === 1, `AudioContext ${ctxAfterLoad}`)

    const np = await b.ev(`({ disabled: u.$('[data-ui="export"]').disabled, hint: u.byText('.simple-note', 'プリセットを選んでください')?.textContent ?? '' })`)
    check(16, 'プリセットを選ぶ前は書き出しを押せず理由を表示', np.disabled && np.hint.length > 0, np.hint)
    // ---- 7. プリセットの選択 ----
    const picked = []
    for (const id of ['cinema-3d', 'live-arena', 'motion-360', 'immersive-x']) {
      await b.ev(`u.$('[data-preset="${id}"]').click()`)
      const ok = await b.waitFor(`u.$('[data-preset="${id}"]').getAttribute('aria-checked') === 'true' && u.$$('[data-preset][aria-checked=true]').length === 1`, 5000)
      picked.push(`${id}:${ok}`)
    }
    check(7, '4 つのプリセットを選択できる（1 つだけ選択中）', picked.every((p) => p.endsWith('true')), picked.join(' '))
    const cardText = await b.ev(`u.$('[data-preset="immersive-x"]').innerText`)
    check(7, 'カードに専門用語なしの説明と選択中の表示', /選択中/.test(cardText) && !/HRTF|STFT|IR|LUFS/.test(cardText), cardText.replace(/\n/g, ' / '))
    await b.waitFor(`!u.byText('.output-stage__note', '測定中')`, 30000)

    // ---- 9（Phase 09）. アクセシビリティ・キーボード操作 ----
    const names = await b.ev(`(() => {
      const els = u.$$('button, [role=button], [role=radio], input, select, a[href]').filter((e) => u.visible(e) && e.type !== 'file')
      const nameOf = (e) => (e.getAttribute('aria-label') || (e.labels && [...e.labels].map((l) => l.textContent).join(' ')) || e.textContent || e.title || '').trim()
      const missing = els.filter((e) => !nameOf(e)).map((e) => e.outerHTML.slice(0, 80))
      return { total: els.length, missing }
    })()`)
    check(9, 'アクセシビリティ: ボタン・スライダー・リンクに名前がある（SIMPLE）', names.missing.length === 0, `${names.total} 個中 名前なし ${names.missing.length}${names.missing.length ? `: ${names.missing.slice(0, 3).join(' | ')}` : ''}`)
    const radios = await b.ev(`u.$$('[role=radiogroup]').filter(u.visible).map((g) => ({ label: g.getAttribute('aria-label'), checked: g.querySelectorAll('[role=radio][aria-checked=true]').length, n: g.querySelectorAll('[role=radio]').length }))`)
    check(9, 'アクセシビリティ: 選択肢のグループに名前があり、選択中が 1 つ', radios.every((r) => r.label && r.checked === 1), radios.map((r) => `${r.label}:${r.checked}/${r.n}`).join(', '))
    // Tab キーで主な操作に届く（モード切替・プリセット・再生・書き出し）
    await b.ev(`(document.activeElement?.blur(), document.body.focus(), true)`)
    const reached = new Set()
    for (let i = 0; i < 60; i++) {
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      const tag = await b.ev(`(() => { const e = document.activeElement; return e?.dataset.mode ? 'mode' : e?.dataset.preset ? 'preset' : e?.closest('.dropzone') || e?.classList.contains('dropzone') ? 'upload' : e?.getAttribute('aria-label') === '再生' ? 'play' : e?.dataset.ui === 'export' ? 'export' : e?.id === 'simple-volume' ? 'volume' : e?.id === 'simple-seek' ? 'seek' : e?.textContent?.includes('PROCESSED') ? 'ab' : '' })()`)
      if (tag) reached.add(tag)
    }
    const need = ['mode', 'upload', 'preset', 'seek', 'play', 'ab', 'volume', 'export']
    check(9, 'キーボード: Tab で主な操作（モード・アップロード・プリセット・シーク・再生・比較・音量・書き出し）に届く', need.every((t) => reached.has(t)), `届いた: ${[...reached].join(', ')}`)
    const focusRule = await b.ev(`[...document.styleSheets].flatMap((ss) => { try { return [...ss.cssRules] } catch { return [] } }).map((r) => r.cssText).find((t) => /^:focus-visible/.test(t)) ?? ''`)
    check(9, 'キーボード: フォーカスの表示（:focus-visible に outline）', /outline/.test(focusRule), focusRule)
    // アップロード欄で Enter → ファイルの選択を開く（input.click を数える）
    const opened = await b.ev(`(() => {
      let n = 0
      const orig = HTMLInputElement.prototype.click
      HTMLInputElement.prototype.click = function () { if (this.type === 'file') n++; else orig.call(this) }
      const z = u.$('.dropzone')
      z.focus()
      z.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      z.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      HTMLInputElement.prototype.click = orig
      return n
    })()`)
    check(9, 'キーボード: アップロード欄で Enter / Space がファイルの選択を開く', opened === 2, `${opened} 回`)
    // Space で再生 / 一時停止（ボタン以外にフォーカスがあるとき）
    await b.ev(`(document.activeElement?.blur(), true)`)
    await b.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))`)
    await sleep(600)
    const spacePlay = await b.ev(`!!u.$('.simple-preview [aria-label="一時停止"]')`)
    await b.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))`)
    await sleep(400)
    const spacePause = await b.ev(`!!u.$('.simple-preview [aria-label="再生"]')`)
    check(9, 'キーボード: Space で再生 / 一時停止', spacePlay && spacePause)
    await b.ev(`u.$('.simple-preview [aria-label="停止"]').click()`)

    // ---- 10. 再生操作 / 9. ORIGINAL / PROCESSED ----
    await b.ev(`u.$('.simple-preview [aria-label="再生"]').click()`)
    await sleep(1500)
    const p1 = await b.ev(`u.position()`)
    const playing = await b.ev(`!!u.$('.simple-preview [aria-label="一時停止"]')`)
    check(10, '再生: 再生位置が進む・ボタンが一時停止に変わる', playing && p1 > 0.8, `位置 ${p1} 秒`)
    await b.ev(`u.byText('.simple-preview .ab-switch__item', 'ORIGINAL').click()`)
    await sleep(600)
    const p2 = await b.ev(`({ pos: u.position(), orig: u.byText('.simple-preview .ab-switch__item', 'ORIGINAL').getAttribute('aria-checked'), playing: !!u.$('.simple-preview [aria-label="一時停止"]') })`)
    await b.ev(`u.byText('.simple-preview .ab-switch__item', 'PROCESSED').click()`)
    await sleep(600)
    const p3 = await b.ev(`({ pos: u.position(), proc: u.byText('.simple-preview .ab-switch__item', 'PROCESSED').getAttribute('aria-checked') })`)
    check(9, 'ORIGINAL / PROCESSED を再生中に切替（止まらず位置が進み続ける）', p2.orig === 'true' && p2.playing && p3.proc === 'true' && p2.pos > p1 && p3.pos > p2.pos, `位置 ${p1} → ${p2.pos} → ${p3.pos}`)
    await b.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true }))`)
    await sleep(200)
    const keyB = await b.ev(`u.byText('.simple-preview .ab-switch__item', 'ORIGINAL').getAttribute('aria-checked')`)
    await b.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true }))`)
    check(9, 'B キーで切替', keyB === 'true')

    // CPU（参考値。合否なし）
    const cpuSimple = await cpuDuring(b, 5000)
    info('CPU（SIMPLE・IMMERSIVE X 再生中、メインスレッドの時間 / 経過時間 %）', JSON.stringify(cpuSimple))
    await b.ev(`u.$('.simple-preview [aria-label="一時停止"]').click()`)
    await sleep(400)
    const pa = await b.ev(`u.position()`)
    await sleep(800)
    const pb = await b.ev(`u.position()`)
    check(10, '一時停止: 位置が止まる', Math.abs(pb - pa) < 0.02, `${pa} → ${pb}`)
    await b.ev(`u.$('.simple-preview [aria-label="停止"]').click()`)
    await sleep(400)
    check(10, '停止: 先頭へ戻る', (await b.ev(`u.position()`)) === 0)
    await b.shot('03-simple-loaded')

    // ---- 2. STUDIO の表示 ----
    const t0 = Date.now()
    await b.ev(`u.$('[data-mode="studio"]').click()`)
    await b.waitFor(`u.view() === 'studio'`, 5000)
    const switchMs = Date.now() - t0
    const s2 = await b.ev(`({
      hash: location.hash,
      sections: u.$$('.studio-nav a').map((a) => a.textContent),
      panels: ['studio-spatial', 'studio-motion', 'studio-tail', 'studio-bass', 'studio-export', 'studio-video', 'studio-preset', 'studio-transport'].filter((id) => !!document.getElementById(id)),
      spatial: ['SPATIAL INTENSITY', 'ROOM SIZE', 'DEPTH', 'WET / DRY'].filter((t) => !!u.byText('#studio-spatial label', t)),
      modes: ['OFF', 'WIDE', 'CINEMA', 'HALL'].filter((t) => !!u.byText('#studio-spatial .spatial-mode__label', t)),
      motion: ['MOTION SPEED', 'MOTION DEPTH', 'CENTER LOCK'].filter((t) => !!u.byText('#studio-motion label', t)),
      motionPresets: u.$$('#studio-motion .motion-preset .spatial-mode__label').map((e) => e.textContent),
      motionToggle: !!u.byText('#studio-motion .bypass-btn__label', 'MOTION'),
      tail: u.$$('#studio-tail .motion-preset .spatial-mode__label').map((e) => e.textContent),
      tailSliders: ['TAIL LENGTH', 'TAIL INTENSITY'].filter((t) => !!u.byText('#studio-tail label', t)),
      dynamicTail: !!u.byText('#studio-tail .bypass-btn__label', 'DYNAMIC TAIL'),
      bass: ['BASS BOOST', 'SUB BASS'].filter((t) => !!u.byText('#studio-bass .module__name', t)),
      bassMode: ['NORMAL', 'EXTREME'].filter((t) => !!u.byText('#studio-bass .mode-switch__item', t)),
      engine: !!u.byText('#studio-bass .bypass-btn__label', 'ENGINE'),
      comp: !!u.$('#studio-bass select'),
      depth: ['16-bit', '24-bit'].filter((t) => !!u.byText('#studio-export .ab-switch__item', t)),
      tailEnd: !!u.byText('#studio-export li', '−100 dBFS'),
    })`)
    check(2, 'STUDIO の表示（#studio・セクションのリンク）', s2.hash === '#studio' && s2.sections.join('|') === 'INPUT|PLAYER|PRESET|SPATIAL|MOTION|TAIL|BASS|EXPORT', `${s2.sections.join(' ')}・切替 ${switchMs} ms`)
    check(2, 'STUDIO: SPATIAL（モード・INTENSITY・ROOM SIZE・DEPTH・WET/DRY）', s2.spatial.length === 4 && s2.modes.length === 4, JSON.stringify([s2.spatial, s2.modes]))
    check(2, 'STUDIO: MOTION（ON/OFF・CINEMATIC/ORBIT/SWEEP/PULSE・速度・深さ・CENTER LOCK）', s2.motionToggle && s2.motion.length === 3 && s2.motionPresets.map((t) => t.split(' ')[0]).join('|') === 'CINEMATIC|ORBIT|SWEEP|PULSE', JSON.stringify(s2.motionPresets))
    check(2, 'STUDIO: TAIL（NATURAL/DISTANCE/RIPPLE・Length・Level・Dynamic Tail）', s2.tail.includes('NATURAL') && s2.tail.includes('DISTANCE') && s2.tail.includes('RIPPLE') && s2.tailSliders.length === 2 && s2.dynamicTail, JSON.stringify(s2.tail))
    check(2, 'STUDIO: BASS（ENGINE・NORMAL/EXTREME・BASS BOOST・SUB BASS・出力補正）', s2.engine && s2.bassMode.length === 2 && s2.bass.length === 2 && s2.comp)
    check(2, 'STUDIO: EXPORT（16/24-bit・余韻の終端処理の説明）', s2.depth.length === 2 && s2.tailEnd)
    await b.shot('04-studio')
    const sNames = await b.ev(`(() => { const els = u.$$('button, [role=button], [role=radio], input, select, a[href]').filter((e) => u.visible(e) && e.type !== 'file'); const nameOf = (e) => (e.getAttribute('aria-label') || (e.labels && [...e.labels].map((l) => l.textContent).join(' ')) || e.textContent || e.title || '').trim(); return { total: els.length, missing: els.filter((e) => !nameOf(e)).map((e) => e.outerHTML.slice(0, 80)) } })()`)
    check(9, 'アクセシビリティ: ボタン・スライダー・リンクに名前がある（STUDIO）', sNames.missing.length === 0, `${sNames.total} 個中 名前なし ${sNames.missing.length}${sNames.missing.length ? `: ${sNames.missing.slice(0, 3).join(' | ')}` : ''}`)
    // STUDIO で再生中の CPU（参考値）
    await b.ev(`u.$('#studio-transport [aria-label="再生"]').click()`)
    await sleep(800)
    const cpuStudio = await cpuDuring(b, 5000)
    info('CPU（STUDIO・IMMERSIVE X 再生中、メインスレッドの時間 / 経過時間 %）', JSON.stringify(cpuStudio))
    await b.ev(`u.$('#studio-transport [aria-label="一時停止"]').click()`)
    await sleep(300)

    // ---- 8. CUSTOM 設定 ----
    const before = await b.ev(`Number(u.$('#sp-intensity').value)`)
    await b.ev(`u.setRange('#sp-intensity', ${before + 12})`)
    await b.ev(`u.setRange('#mo-motionSpeed', 70)`)
    await b.ev(`u.setRange('#tail-tailLength', 30)`)
    const customStudio = await b.waitFor(`/CUSTOM/.test(u.$('#studio-preset .badge:last-child')?.textContent ?? '')`, 5000)
    check(8, 'STUDIO で詳細設定を変えると CUSTOM になる', customStudio, await b.ev(`u.$('#studio-preset .panel__aside').textContent`))
    await b.ev(`u.$('[data-mode="simple"]').click()`)
    await b.waitFor(`u.view() === 'simple'`, 5000)
    const cs = await b.ev(`({ note: u.$('[data-ui="custom-note"]')?.textContent ?? '', modified: u.$('[data-preset="immersive-x"]').classList.contains('is-modified'), checked: u.$$('[data-preset][aria-checked=true]').length })`)
    check(8, 'SIMPLE に CUSTOM（IMMERSIVE X を調整）と表示', /CUSTOM/.test(cs.note) && /IMMERSIVE X/.test(cs.note) && cs.modified && cs.checked === 0, cs.note)
    await b.ev(`u.$('[data-mode="studio"]').click()`)
    await b.waitFor(`u.view() === 'studio'`, 5000)
    const kept = await b.ev(`[Number(u.$('#sp-intensity').value), Number(u.$('#mo-motionSpeed').value), Number(u.$('#tail-tailLength').value)]`)
    check(8, 'CUSTOM の値がモードの切替で残る', kept[0] === before + 12 && kept[1] === 70 && kept[2] === 30, JSON.stringify(kept))
    await b.ev(`u.byText('#studio-preset .btn-chip', 'CUSTOM として保存').click()`)
    check(8, 'CUSTOM を保存できる', await b.waitFor(`/保存した CUSTOM を適用中/.test(u.$('#studio-preset .panel__aside').textContent)`, 3000))
    await b.ev(`u.byText('#studio-preset .btn-chip', '削除').click()`)

    // ---- 3・4. モードの切替と状態の保持 ----
    await b.ev(`u.$('[data-mode="simple"]').click()`)
    await b.waitFor(`u.view() === 'simple'`, 5000)
    await b.ev(`u.setRange('#simple-volume', 55)`)
    await b.ev(`u.setRange('#simple-seek', 4.5)`)
    await b.ev(`u.byText('.simple-option .ab-switch__item', '24-bit').click()`)
    await b.waitFor(`!u.byText('.output-stage__note', '測定中')`, 30000)
    await sleep(1500)
    const c0 = await b.ev(`u.counters()`)
    const st0 = await b.ev(`({ pos: u.position(), vol: u.$('#simple-volume').value })`)
    let switchTimes = []
    for (let i = 0; i < 6; i++) {
      const target = i % 2 === 0 ? 'studio' : 'simple'
      const t = Date.now()
      await b.ev(`u.$('[data-mode="${target}"]').click()`)
      await b.waitFor(`u.view() === '${target}'`, 5000, 20)
      switchTimes.push(Date.now() - t)
      if (target === 'studio') {
        const st = await b.ev(`({ pos: u.position(), vol: u.$('#studio-volume').value, depth: u.byText('#studio-export .ab-switch__item', '24-bit').getAttribute('aria-checked'), file: u.$('#studio-input + * .file-name, .panel--info .file-name')?.textContent })`)
        if (i === 0) check(4, '状態の保持 SIMPLE → STUDIO（ファイル・再生位置・音量・書き出し設定）', st.pos === st0.pos && st.vol === '55' && st.depth === 'true' && /ui-test-music\.wav/.test(st.file ?? ''), JSON.stringify(st))
      }
    }
    await sleep(1500)
    const c1 = await b.ev(`u.counters()`)
    const st1 = await b.ev(`({ pos: u.position(), vol: u.$('#simple-volume').value, depth: u.byText('.simple-option .ab-switch__item', '24-bit').getAttribute('aria-checked') })`)
    check(4, '状態の保持 STUDIO → SIMPLE（6 回切り替えた後）', st1.pos === st0.pos && st1.vol === '55' && st1.depth === 'true', JSON.stringify(st1))
    check(3, 'モードの切替で再解析・AudioContext の作成が起きない（6 回）', c1.offlineCtx === c0.offlineCtx && c1.audioCtx === c0.audioCtx && c1.created === c0.created, `OfflineAudioContext ${c0.offlineCtx} → ${c1.offlineCtx}、AudioContext ${c0.audioCtx} → ${c1.audioCtx}、Object URL の作成 ${c0.created} → ${c1.created}`)
    info('モードの切替の時間（クリック → 表示、ms）', switchTimes.join(', '))
    await b.navigate('#studio')
    check(3, '#studio で開くと STUDIO・ハッシュなしは SIMPLE', (await b.ev(`u.view()`)) === 'studio')
    await b.navigate()
    check(3, 'ハッシュなしで開くと SIMPLE', (await b.ev(`u.view()`)) === 'simple')
    // 読み込み直したのでファイルとプリセットを入れ直す
    await b.setFile(FILES.music)
    await b.waitFor(`!!u.$('[data-ui="file-summary"]')`, 30000)
    await b.ev(`u.$('[data-preset="immersive-x"]').click()`)
    await b.waitFor(`!u.byText('.output-stage__note', '測定中')`, 30000)

    // ---- 11. WAV の書き出し ----
    await startExport(b)
    const ex = await waitExport(b)
    const wavUrl = ex.done ? await b.ev(`u.$('[data-ui="download"]').getAttribute('href')`) : null
    const wav = wavUrl ? await b.ev(`u.wavInfo(${JSON.stringify(wavUrl)})`) : null
    check(11, 'WAV の書き出し: PREPARING → RENDERING → ENCODING → COMPLETE を表示', ex.done && ['preparing', 'rendering', 'encoding'].every((s) => ex.seen.includes(s)) && (await b.ev(`!!u.$('.export-stages li.is-complete')`)), `表示した段階 ${ex.seen.join(' → ')}・${ex.ms} ms${ex.err ? `・${ex.err}` : ''}`)
    check(11, 'WAV のヘッダー・長さ（音源 12 秒 + 余韻、16-bit・48 kHz・ステレオ）', !!wav && wav.riff === 'RIFF' && wav.wave === 'WAVE' && wav.sampleRate === 48000 && wav.bits === 16 && wav.channels === 2 && wav.seconds >= 12 && wav.seconds < 20, JSON.stringify(wav))
    const fileName = ex.done ? await b.ev(`u.$('[data-ui="download"]').getAttribute('download')`) : ''
    check(11, 'ファイル名に設定名とビット深度', /IMMERSIVE_X_16bit\.wav$/.test(fileName), fileName)

    // ---- 13. 完成ファイルのプレビュー ----
    const pv = await b.ev(`(async () => {
      const ex = u.$('audio[data-preview="exported"]'), or = u.$('audio[data-preview="original"]')
      await ex.play()
      await new Promise((r) => setTimeout(r, 1200))
      const t1 = ex.currentTime
      u.byText('.export-preview .ab-switch__item', 'ORIGINAL').click()
      await new Promise((r) => setTimeout(r, 600))
      const res = { t1, exPaused: ex.paused, orPlaying: !or.paused, orTime: or.currentTime, exHidden: ex.hidden, orHidden: or.hidden, vol: or.volume, dur: ex.duration }
      or.pause()
      return res
    })()`)
    check(13, '完成ファイルのプレビュー: EXPORTED を再生', pv.t1 > 0.8 && Math.abs(pv.dur - wav.seconds) < 0.05, `再生位置 ${pv.t1.toFixed(2)} 秒、長さ ${pv.dur?.toFixed?.(2)} 秒`)
    check(13, 'EXPORTED → ORIGINAL を同じ位置から（フェードして切替）', pv.exPaused && pv.orPlaying && pv.exHidden && !pv.orHidden && Math.abs(pv.orTime - pv.t1) < 1.2 && pv.vol > 0, JSON.stringify(pv))
    const volPct = await b.ev(`Number(u.$('#simple-volume').value)`)
    check(13, 'プレビューの音量はモニター音量にそろえる', Math.abs(pv.vol - (volPct / 100) ** 2) < 0.01, `音量 ${volPct}% → volume ${pv.vol.toFixed(3)}`)
    // 再生エンジンで試聴を始めたらプレビューを止める
    await b.ev(`u.$('audio[data-preview="original"]').play()`)
    await sleep(300)
    await b.ev(`u.$('.simple-preview [aria-label="再生"]').click()`)
    await sleep(500)
    check(13, '再生エンジンの再生でプレビューが止まる（二重に鳴らさない）', await b.ev(`u.$('audio[data-preview="original"]').paused`))
    await b.ev(`u.$('.simple-preview [aria-label="一時停止"]').click()`)

    // ---- 14. ダウンロード ----
    const blobSize = await b.ev(`(async () => (await (await fetch(u.$('[data-ui="download"]').href)).blob()).size)()`)
    await b.ev(`u.$('[data-ui="download"]').click()`)
    let dl = null
    for (let i = 0; i < 60 && !dl; i++) {
      await sleep(250)
      const f = readdirSync(b.download).find((n) => n === fileName)
      if (f && statSync(join(b.download, f)).size === blobSize) dl = f
    }
    check(14, 'ダウンロード: 同じファイル名・同じサイズで保存される', !!dl, `${fileName} ${blobSize} bytes`)

    // ---- 4. 完成ファイルもモードの切替で残る ----
    await b.ev(`u.$('[data-mode="studio"]').click()`)
    await b.waitFor(`u.view() === 'studio'`, 5000)
    const studioHref = await b.ev(`u.$('#studio-export a[download]')?.getAttribute('href') ?? null`)
    await b.ev(`u.$('[data-mode="simple"]').click()`)
    await b.waitFor(`u.view() === 'simple'`, 5000)
    const simpleHref = await b.ev(`u.$('[data-ui="download"]')?.getAttribute('href') ?? null`)
    check(4, '完成ファイルがモードの切替で残る（同じ Object URL）', studioHref === wavUrl && simpleHref === wavUrl, `${studioHref === wavUrl} / ${simpleHref === wavUrl}`)
    await b.shot('05-simple-complete')

    // ---- 10. Object URL の解放（別のファイルを読み込むと前の結果・元のファイルの URL を解放） ----
    const before2 = await b.ev(`u.counters()`)
    await b.setFile(FILES.music2)
    await b.waitFor(`/ui-test-music-2\\.wav/.test(u.$('[data-ui="file-summary"]')?.textContent ?? '')`, 30000)
    const after2 = await b.ev(`u.counters()`)
    check(10, 'Object URL の解放: 読み込み直すと前の完成ファイル・元のファイルの URL を解放（残るのは新しい元のファイルだけ）', !after2.live.includes(wavUrl) && after2.live.length === 1 && !(await b.ev(`!!u.$('[data-ui="result"]')`)), `生きている URL ${before2.live.length} → ${after2.live.length}`)
    check(5, '44.1 kHz の音源の情報', /44\.1 ?kHz/.test(await b.ev(`u.$('[data-ui="file-summary"]').innerText`)))

    // ---- 15. キャンセル（90 秒の音源をレンダリング中に） ----
    await b.setFile(FILES.long)
    await b.waitFor(`/ui-test-long\\.wav/.test(u.$('[data-ui="file-summary"]')?.textContent ?? '')`, 30000)
    await b.waitFor(`!u.byText('.output-stage__note', '測定中')`, 60000)
    const urlsBeforeCancel = (await b.ev(`u.counters()`)).live.length
    await startExport(b)
    const rendering = await b.waitFor(`u.$('.export-stages li.is-current')?.dataset.stage === 'rendering'`, 60000, 50)
    await b.ev(`u.$('[data-ui="cancel"]').click()`)
    const cx = await waitExport(b, 30000)
    const afterCancel = await b.ev(`({ live: u.counters().live.length, btn: u.$('[data-ui="export"]').disabled, frames: document.querySelectorAll('iframe[data-csx-export]').length, result: !!u.$('[data-ui="result"]') })`)
    check(15, 'キャンセル: レンダリング中に止めて「キャンセルしました」・結果なし・iframe なし', rendering && cx.cancelled && !afterCancel.result && afterCancel.frames === 0 && afterCancel.live === urlsBeforeCancel && !afterCancel.btn, JSON.stringify({ ...afterCancel, seen: cx.seen }))
    // キャンセルの後にもう一度書き出せる
    await startExport(b)
    const re = await waitExport(b, 300000)
    const reWav = re.done ? await b.ev(`u.wavInfo(u.$('[data-ui="download"]').href)`) : null
    const depthNow = (await b.ev(`u.byText('.simple-option .ab-switch__item', '24-bit').getAttribute('aria-checked')`)) === 'true' ? 24 : 16
    check(15, 'キャンセルの後にもう一度書き出せる（90 秒 + 余韻、選んだビット深度）', re.done && reWav.seconds >= 90 && reWav.bits === depthNow, re.done ? `${reWav.seconds.toFixed(2)} 秒・${re.ms} ms` : String(re.err))
    info('ブラウザのメモリ（音声のセッションの終わり、MB）', String(b.browserMemoryMb()?.toFixed(0)))
    const errs = b.errors.filter((e) => !/favicon/.test(e))
    await workletCheck(b)
    check(18, 'ページのエラー（例外・console.error）なし', errs.length === 0, errs.slice(0, 3).join(' | '))
  } finally {
    await b.close()
  }
}

/** AudioWorklet の読み込み（ページ・解析用 iframe・書き出し用 iframe）に失敗がなく、それぞれで読み込めている（Phase 10） */
async function workletCheck(b) {
  const wl = (await b.ev(`window.__csxUi?.worklets ?? []`)) ?? []
  const fails = wl.filter((x) => x.includes(':fail'))
  const okIn = (w) => [...new Set(wl.filter((x) => x.startsWith(w + ':') && x.endsWith(':ok')).map((x) => x.split(':')[1]))].sort()
  const page = okIn('page')
  const analysis = okIn('analysis-frame.html')
  const exp = okIn('export-frame.html')
  check(
    19,
    'AudioWorklet の読み込み: 失敗なし・ページ（再生）・解析用 iframe・書き出し用 iframe で読み込める',
    fails.length === 0 && page.includes('bassDynamics') && analysis.length > 0 && exp.includes('bassDynamics'),
    `ページ [${page.join(', ')}]、解析用 [${analysis.join(', ')}]、書き出し用 [${exp.join(', ')}]${fails.length ? `、失敗 ${fails.slice(0, 3).join(' | ')}` : ''}`,
  )
}

// ================= セッション 2: 動画 =================
async function videoSession() {
  currentSession = 'video'
  const b = await launch()
  try {
    // 試験用の動画をブラウザ内で作り（WebCodecs）、ファイルとして保存してから読み込む（実際のファイルの選択と同じ経路）
    if (usePreview) {
      await b.send('Page.navigate', { url: fixtureUrl })
      await b.waitFor(`!!document.querySelector('[data-view]')`, 30000)
    } else await b.navigate()
    const b64 = await b.ev(`(async () => {
      const { makeFixtureVideo } = await import('/src/dev/videoFixtures.ts')
      const { blob } = await makeFixtureVideo({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', seconds: 8, width: 640, height: 360, tone: 0.2 })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return btoa(s)
    })()`)
    const videoPath = join(work, 'ui-test-video.mp4')
    writeFileSync(videoPath, Buffer.from(b64, 'base64'))
    if (usePreview) await b.navigate()

    // ---- 6. 動画のアップロード ----
    await b.setFile(videoPath)
    const loaded = await b.waitFor(`!!u.$('[data-ui="file-summary"]')`, 60000)
    const summary = loaded ? await b.ev(`u.$('[data-ui="file-summary"]').innerText`) : ''
    check(6, '動画のアップロード: 種類・再生時間・解像度・サンプルレート・チャンネル数', /動画（MP4）/.test(summary) && /640×360/.test(summary) && /00:08\.0/.test(summary) && /48(\.0)? ?kHz/.test(summary), summary.replace(/\n/g, ' / '))
    const choice = await b.ev(`u.$$('[data-output]').map((e) => e.dataset.output + ':' + e.getAttribute('aria-checked'))`)
    check(6, '動画の出力を選べる（立体音響の動画 / 音声だけ）', choice.join(',') === 'video:true,wav:false', choice.join(','))

    // ---- 12. 動画の書き出し ----
    await b.ev(`u.$('[data-preset="cinema-3d"]').click()`)
    await b.waitFor(`!u.byText('.output-stage__note', '測定中')`, 30000)
    await startExport(b)
    const vx = await waitExport(b, 240000)
    const vUrl = vx.done ? await b.ev(`u.$('[data-ui="download"]').href`) : null
    const head = vUrl ? await b.ev(`u.headTag(${JSON.stringify(vUrl)})`) : null
    check(12, '動画の書き出し: PREPARING → RENDERING → ENCODING → MUXING → COMPLETE', vx.done && ['preparing', 'rendering', 'muxing'].every((s) => vx.seen.includes(s)), `表示した段階 ${vx.seen.join(' → ')}・${vx.ms} ms${vx.err ? `・${vx.err}` : ''}`)
    check(12, '出力は MP4（ftyp）', head?.tag === 'ftyp' && head.size > 10000, JSON.stringify(head))
    const vName = vx.done ? await b.ev(`u.$('[data-ui="download"]').getAttribute('download')`) : ''
    check(12, 'ファイル名（設定名・.mp4）', /CINEMA_3D\.mp4$/.test(vName), vName)

    // ---- 13. 動画のプレビュー ----
    const vp = await b.ev(`(async () => {
      const v = u.$('video[data-preview="exported"]')
      if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }))
      await v.play().catch((e) => String(e))
      await new Promise((r) => setTimeout(r, 1200))
      const res = { t: v.currentTime, dur: v.duration, w: v.videoWidth, orig: !!u.$('video[data-preview="original"]') }
      v.pause()
      return res
    })()`)
    check(13, '完成した動画のプレビュー（再生・解像度・ORIGINAL の動画も比較できる）', vp.t > 0.5 && vp.w === 640 && Math.abs(vp.dur - 8) < 0.2 && vp.orig, JSON.stringify(vp))
    await b.shot('06-simple-video-complete')

    // ---- 14. 動画のダウンロード ----
    const size = await b.ev(`(async () => (await (await fetch(u.$('[data-ui="download"]').href)).blob()).size)()`)
    await b.ev(`u.$('[data-ui="download"]').click()`)
    let dl = false
    for (let i = 0; i < 60 && !dl; i++) {
      await sleep(250)
      dl = readdirSync(b.download).some((n) => n === vName && statSync(join(b.download, n)).size === size)
    }
    check(14, '動画のダウンロード（同じサイズ）', dl, `${vName} ${size} bytes`)

    // ---- 12. 動画 → 音声だけ（立体音響化した WAV） ----
    await b.ev(`u.$('[data-output="wav"]').click()`)
    const wavResultHidden = !(await b.ev(`!!u.$('[data-ui="result"]')`))
    await startExport(b)
    const wx = await waitExport(b, 180000)
    const wi = wx.done ? await b.ev(`u.wavInfo(u.$('[data-ui="download"]').href)`) : null
    check(12, '動画から音声だけ（立体音響化した WAV）', wavResultHidden && wx.done && wi.sampleRate === 48000 && wi.seconds >= 8, wi ? `${wi.seconds.toFixed(2)} 秒` : String(wx.err))
    await b.ev(`u.$('[data-output="video"]').click()`)
    check(4, '出力を戻すと動画の完成ファイルが残っている', (await b.ev(`u.$('[data-ui="download"]')?.href`)) === vUrl)

    // ---- STUDIO の動画パネル（元の音声の WAV・余韻の選択） ----
    await b.ev(`u.$('[data-mode="studio"]').click()`)
    await b.waitFor(`u.view() === 'studio'`, 5000)
    const sv = await b.ev(`({ tail: ['映像の長さを保つ', '最後のフレームを延ばして余韻を残す'].filter((t) => !!u.byText('#studio-video .ab-switch__item', t)), orig: !!u.byText('#studio-video .btn-chip', '元の音声を WAV に'), same: u.$('#studio-video a[download]')?.href === ${JSON.stringify(vUrl)}, res: !!u.byText('#studio-video dd', '640×360') })`)
    check(2, 'STUDIO: 動画の書き出し（余韻の終端処理 2 種・元の音声の抽出・同じ完成ファイル）', sv.tail.length === 2 && sv.orig && sv.same && sv.res, JSON.stringify(sv))
    await b.shot('07-studio-video')

    // 次の項目でページを読み込み直す（計測が消える）ため、その前に確かめる
    await workletCheck(b)

    // ---- 17. スマートフォン: 動画の書き出しを制限して理由を表示 ----
    await b.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36' })
    await b.viewport(390, 844, true)
    await b.navigate()
    await b.setFile(videoPath)
    await b.waitFor(`!!u.$('[data-ui="file-summary"]')`, 60000)
    await b.ev(`u.$('[data-preset="live-arena"]').click()`)
    const mob = await b.ev(`({ notice: u.$('.simple-platform')?.textContent ?? '', videoDisabled: u.$('[data-output="video"]').disabled, wavChecked: u.$('[data-output="wav"]').getAttribute('aria-checked'), reason: u.$('[data-ui="video-limit"]')?.textContent ?? '', exportEnabled: !u.$('[data-ui="export"]').disabled, label: u.$('[data-ui="export"]').textContent })`)
    check(17, 'スマートフォン: 制限を表示し、動画の書き出しを選べなくして理由を表示', /スマートフォン/.test(mob.notice) && mob.videoDisabled && mob.wavChecked === 'true' && /PC の Chrome/.test(mob.reason), mob.reason)
    check(17, 'スマートフォン: 音声（WAV）の書き出しは押せる', mob.exportEnabled && /WAV/.test(mob.label), mob.label)
    const lm = await layoutCheck(b, 'phone-loaded')
    check(17, 'スマートフォン（読み込み後）: 横にはみ出さない・プリセット 1 列', lm.over <= 0 && lm.wide.length === 0 && lm.cols === 1, `はみ出し ${lm.over}px${lm.wide.length ? `、${lm.wide.join(', ')}` : ''}`)
    await b.shot('08-phone-video')
    info('ブラウザのメモリ（動画のセッションの終わり、MB）', String(b.browserMemoryMb()?.toFixed(0)))
    const errs = b.errors.filter((e) => !/favicon/.test(e))
    check(18, 'ページのエラー（例外・console.error）なし', errs.length === 0, errs.slice(0, 3).join(' | '))
  } finally {
    await b.close()
  }
}

// ================= セッション 3: 公式デモ音源（Spatial Showcase） =================
// 取得の失敗・競合は CDP の Fetch で応答を差し替えて再現する（実際の通信の失敗と同じ経路: fetch → アプリのエラー処理）
const DEMO_PATH = '/audio/spatial-showcase.wav'
async function demoSession() {
  currentSession = 'demo'
  if (!existsSync(join('public', 'audio', 'spatial-showcase.wav'))) {
    check(20, 'デモ音源ファイル public/audio/spatial-showcase.wav がある', false, '音源が配置されていないため、このセッションの残りは実行しない')
    return
  }
  const b = await launch()
  try {
    await b.navigate()
    const demoState = () => b.ev(`({ summary: u.$('[data-ui="file-summary"]')?.innerText ?? '', badge: !!u.$('[data-ui="demo-source"]'), sections: u.$$('[data-section]').map((e) => e.dataset.section), alert: u.$('.alert[role=alert] .alert__title')?.textContent ?? '', alertAll: u.$('.alert[role=alert]')?.textContent ?? '', loading: !!u.$('.dropzone.is-loading') })`)
    const clickDemo = () => b.ev(`(u.$('[data-ui="demo-load"]').click(), true)`)

    // ---- 20. 最初の表示: デモの案内があり、音源はまだ取得しない ----
    const d0 = await b.ev(`({ btn: u.visible(u.$('[data-ui="demo-load"]')), text: u.$('[data-ui="demo-load"]')?.innerText ?? '', fetched: performance.getEntriesByType('resource').some((e) => e.name.includes(${JSON.stringify(DEMO_PATH)})), sections: !!u.$('[data-ui="demo-sections"]'), about: !!u.$('[data-ui="about"] [lang=en]') })`)
    check(20, 'SIMPLE に「サンプル音源で試す」があり、押す前は音源を取得しない・区間は出さない', d0.btn && /サンプル音源で試す/.test(d0.text) && !d0.fetched && !d0.sections, JSON.stringify(d0))
    check(20, 'サイトの説明（日本語・英語）を表示', d0.about)

    // ---- 21. 取得の失敗（404・WAV でない応答）→ エラーを表示し、もう一度押せる ----
    let mode = 'off'
    let held = null
    const demoHook = (p) => {
      if (!p.request.url.includes(DEMO_PATH)) return false
      if (mode === '404') void b.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 404, responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }], body: Buffer.from('not found').toString('base64') })
      else if (mode === 'html') void b.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from('<!doctype html><title>x</title>').toString('base64') })
      else if (mode === 'hold') held = p
      else return false
      return true
    }
    await b.intercept(demoHook, `*${DEMO_PATH}*`)
    mode = '404'
    await clickDemo()
    await b.waitFor(`!!u.$('.alert[role=alert]')`, 15000)
    const f1 = await demoState()
    const retry1 = await b.ev(`!u.$('[data-ui="demo-load"]').disabled`)
    check(21, 'デモの取得失敗（HTTP 404）: 分かるエラーを表示・音源なしのまま・もう一度押せる', /見つかりませんでした/.test(f1.alert) && !f1.summary && !f1.loading && retry1, f1.alert)
    await b.ev(`u.$('.alert__close').click()`)

    // 既存の音源があるときに失敗しても、その音源を保持する（WAV でない応答 = 未配置で index.html が返る場合）
    await b.setFile(FILES.music)
    await b.waitFor(`/ui-test-music\\.wav/.test(u.$('[data-ui="file-summary"]')?.textContent ?? '')`, 30000)
    mode = 'html'
    await clickDemo()
    await b.waitFor(`!!u.$('.alert[role=alert]')`, 15000)
    const f2 = await demoState()
    check(21, 'デモの取得失敗（WAV でない応答）: 直前の音源を保持して理由を表示', /見つかりませんでした/.test(f2.alert) && /保持/.test(f2.alertAll) && /ui-test-music\.wav/.test(f2.summary) && !f2.badge && f2.sections.length === 0, f2.alert)
    await b.ev(`u.$('.alert__close').click()`)

    // ---- 22. 読み込みの競合: デモの取得中に通常のファイルを選ぶと、ファイルが優先され、デモの結果は反映しない ----
    mode = 'hold'
    held = null
    await clickDemo()
    const pausedOk = await b.waitFor(`true`, 100) && (await (async () => { for (let i = 0; i < 100 && !held; i++) await sleep(50); return !!held })())
    const loadingShown = (await demoState()).loading
    await b.setFile(FILES.music2)
    await b.waitFor(`/ui-test-music-2\\.wav/.test(u.$('[data-ui="file-summary"]')?.textContent ?? '')`, 30000)
    mode = 'off'
    if (held) await b.continuePaused(held)
    await sleep(3000)
    const r1 = await demoState()
    check(22, '読み込みの競合: デモの取得中にファイルを選ぶと、そのファイルだけが反映される（後からデモで上書きしない）', pausedOk && loadingShown && /ui-test-music-2\.wav/.test(r1.summary) && !r1.badge && r1.sections.length === 0 && !r1.loading && !r1.alert, JSON.stringify({ pausedOk, loadingShown, badge: r1.badge, alert: r1.alert }))
    await b.intercept(null)

    // ---- 23. デモ音源の読み込み（実際のファイル） ----
    const c0 = await b.ev(`u.counters()`)
    await clickDemo()
    const ok = await b.waitFor(`!!u.$('[data-ui="demo-source"]')`, 60000)
    const d1 = await demoState()
    const c1 = await b.ev(`u.counters()`)
    check(23, 'デモ音源を読み込める（公式デモの表示・WAV・40 秒・48 kHz・ステレオ）', ok && /Spatial Showcase/.test(d1.summary) && /音声（WAV）/.test(d1.summary) && /00:40\.00/.test(d1.summary) && /48(\.0)? ?kHz/.test(d1.summary) && /ステレオ|2/.test(d1.summary), d1.summary.replace(/\n/g, ' / '))
    check(23, 'デモでも AudioContext は 1 つのまま・元のファイルの Object URL は 1 つ（前のものは解放）', c1.audioCtx === Math.max(1, c0.audioCtx) && c1.live.length === 1, `AudioContext ${c0.audioCtx} → ${c1.audioCtx}、生きている URL ${c1.live.length}`)
    const orig = await b.ev(`({ text: u.$('[data-ui="demo-original"]')?.textContent ?? '', name: u.$('[data-ui="demo-original"] a')?.getAttribute('download') ?? '' })`)
    check(23, '元のデモ音源のダウンロードに「公式デモ音源」と明記', /公式デモ音源/.test(orig.text) && orig.name === 'CINEMA_SONIC_X_Spatial_Showcase_40s_24bit.wav', JSON.stringify(orig))

    // ---- 24. 5 つの区間とシーク ----
    const labels = await b.ev(`u.$$('[data-section] .demo-section__label').map((e) => e.textContent)`)
    check(24, '区間の表示: Intro / Groove / Main / Space / Outro', labels.join('|') === 'Intro|Groove|Main|Space|Outro', labels.join(' '))
    const starts = { intro: 0, groove: 4, main: 12, space: 28, outro: 36 }
    const seekRes = []
    for (const [id, t] of Object.entries(starts)) {
      await b.ev(`u.$('[data-section="${id}"]').click()`)
      await sleep(150)
      const s = await b.ev(`({ pos: u.position(), cur: u.$('[data-section][aria-current="true"]')?.dataset.section ?? null })`)
      seekRes.push({ id, ...s, ok: Math.abs(s.pos - t) < 0.011 && s.cur === id })
    }
    check(24, '区間を押すとその開始位置へシーク（停止中）・その区間を選択中に表示', seekRes.every((r) => r.ok), seekRes.map((r) => `${r.id}:${r.pos}/${r.cur}`).join(' '))

    // ---- 25. 再生中の区間の表示 ----
    await b.ev(`u.$('[data-preset="motion-360"]').click()`)
    await b.waitFor(`!u.byText('.output-stage__note', '測定中')`, 60000)
    await b.ev(`u.$('[data-section="main"]').click()`)
    await b.ev(`u.$('.simple-preview [aria-label="再生"]').click()`)
    await sleep(1200)
    const a1 = await b.ev(`({ pos: u.position(), cur: u.$('[data-section][aria-current="true"]')?.dataset.section, n: u.$$('[data-section].is-active').length })`)
    // 再生中に区間を押す: 再生を続けたままその位置へ（27.4 秒付近から Space へ移る）
    await b.ev(`u.$('[data-section="space"]').click()`)
    await sleep(800)
    const a2 = await b.ev(`({ pos: u.position(), cur: u.$('[data-section][aria-current="true"]')?.dataset.section, playing: !!u.$('.simple-preview [aria-label="一時停止"]') })`)
    await b.ev(`u.$('[data-section="groove"]').click()`)
    await sleep(500)
    await b.ev(`u.setRange('#simple-seek', 11.3)`)
    await sleep(1500)
    const a3 = await b.ev(`({ pos: u.position(), cur: u.$('[data-section][aria-current="true"]')?.dataset.section })`)
    check(25, '再生中の区間: Main を再生中は Main だけを選択中', a1.pos > 12.5 && a1.pos < 16 && a1.cur === 'main' && a1.n === 1, JSON.stringify(a1))
    check(25, '再生中に区間を押すと再生を続けたまま移動', a2.playing && a2.pos >= 28 && a2.pos < 30 && a2.cur === 'space', JSON.stringify(a2))
    check(25, '再生が区間の境目（12 秒）を越えると表示が Groove → Main に変わる', a3.pos > 12 && a3.pos < 14 && a3.cur === 'main', JSON.stringify(a3))

    // ---- 26. 4 つのプリセット・ORIGINAL / PROCESSED（再生中） ----
    const picked = []
    for (const id of ['cinema-3d', 'live-arena', 'motion-360', 'immersive-x']) {
      await b.ev(`u.$('[data-preset="${id}"]').click()`)
      picked.push(`${id}:${await b.waitFor(`u.$('[data-preset="${id}"]').getAttribute('aria-checked') === 'true'`, 5000)}`)
      await sleep(400)
    }
    const measured = await b.waitFor(`!u.byText('.output-stage__note', '測定中')`, 60000)
    const anErr = await b.ev(`u.$$('.badge').map((e) => e.textContent).filter((t) => /エラー|ERROR/.test(t))`)
    check(26, 'デモで 4 つのプリセットを選べる（測定が終わる・エラーなし）', picked.every((p) => p.endsWith('true')) && measured && anErr.length === 0, picked.join(' '))
    const p0 = await b.ev(`u.position()`)
    await b.ev(`u.byText('.simple-preview .ab-switch__item', 'ORIGINAL').click()`)
    await sleep(600)
    const ab1 = await b.ev(`({ pos: u.position(), orig: u.byText('.simple-preview .ab-switch__item', 'ORIGINAL').getAttribute('aria-checked') })`)
    await b.ev(`u.byText('.simple-preview .ab-switch__item', 'PROCESSED').click()`)
    await sleep(600)
    const ab2 = await b.ev(`({ pos: u.position(), proc: u.byText('.simple-preview .ab-switch__item', 'PROCESSED').getAttribute('aria-checked') })`)
    check(26, 'デモで ORIGINAL / PROCESSED を再生中に切替（位置が進み続ける）', ab1.orig === 'true' && ab2.proc === 'true' && ab1.pos > p0 && ab2.pos > ab1.pos, `${p0} → ${ab1.pos} → ${ab2.pos}`)
    await b.ev(`u.$('.simple-preview [aria-label="一時停止"]').click()`)
    await sleep(300)
    await b.ev(`u.$('[data-section="space"]').click()`)
    await sleep(200)
    await b.shot('20-demo-simple')

    // ---- 27. SIMPLE ↔ STUDIO の切替で状態を保つ ----
    // 音源の測定が終わってから数える（音声のセッションの項目 3 と同じ。切替と関係のない処理の終わりを数えない）
    await b.waitFor(`!u.byText('.output-stage__note', '測定中')`, 60000)
    const cIdle0 = await b.ev(`u.counters()`)
    await sleep(3000)
    const cA = await b.ev(`u.counters()`)
    info('切替の前の 3 秒（操作なし）の OfflineAudioContext の作成', `${cIdle0.offlineCtx} → ${cA.offlineCtx}`)
    const sPos = await b.ev(`u.position()`)
    await b.ev(`u.$('[data-mode="studio"]').click()`)
    await b.waitFor(`u.view() === 'studio'`, 5000)
    const st = await b.ev(`({ pos: u.position(), panel: !!u.$('.panel--demo [data-section]'), cur: u.$('.panel--demo [data-section][aria-current="true"]')?.dataset.section ?? null, source: u.byText('.panel--info dd', '公式デモ音源')?.textContent ?? '', file: u.$('.panel--info .file-name')?.textContent ?? '', preset: u.$('#studio-preset .panel__aside')?.textContent ?? '' })`)
    check(27, 'STUDIO: デモ音源・再生位置・プリセット・区間の表示を保つ', st.pos === sPos && st.panel && st.cur === 'space' && /公式デモ音源/.test(st.source) && /Spatial_Showcase/.test(st.file) && /IMMERSIVE X/.test(st.preset), JSON.stringify(st))
    await sleep(1000)
    const cS1 = await b.ev(`u.counters()`)
    await b.ev(`u.$('.panel--demo [data-section="outro"]').click()`)
    await sleep(1000)
    const cS2 = await b.ev(`u.counters()`)
    // STUDIO を初めて表示すると、EQ のグラフ（EqCurve → eqResponse.ts）が周波数特性の計算用の OfflineAudioContext（1 フレーム・ワークレットなし）を 1 つだけ作る（既存の動作。解析ではない）。
    // 音声のセッションの項目 3 と同じく、STUDIO を一度表示した後から数える
    info('OfflineAudioContext: 切替前 → STUDIO を初めて表示（EQ のグラフ用に 1 つ）→ STUDIO の区間でシーク', `${cA.offlineCtx} → ${cS1.offlineCtx} → ${cS2.offlineCtx}`)
    const stPos = await b.ev(`u.position()`)
    await b.shot('21-demo-studio')
    await b.ev(`u.$('[data-mode="simple"]').click()`)
    await b.waitFor(`u.view() === 'simple'`, 5000)
    for (const m of ['studio', 'simple', 'studio', 'simple']) {
      await b.ev(`u.$('[data-mode="${m}"]').click()`)
      await b.waitFor(`u.view() === '${m}'`, 5000)
    }
    await sleep(1000)
    const back = await b.ev(`({ pos: u.position(), cur: u.$('[data-section][aria-current="true"]')?.dataset.section, preset: u.$('[data-preset="immersive-x"]').getAttribute('aria-checked'), badge: !!u.$('[data-ui="demo-source"]') })`)
    const cB = await b.ev(`u.counters()`)
    check(27, 'STUDIO の区間でシーク → SIMPLE に戻っても位置・区間・プリセットを保つ', Math.abs(stPos - 36) < 0.011 && back.pos === stPos && back.cur === 'outro' && back.preset === 'true' && back.badge, JSON.stringify({ stPos, ...back }))
    check(27, 'モードの切替（STUDIO を一度表示した後に 3 往復）・区間のシークで再解析・AudioContext・Object URL の作成が起きない', cB.offlineCtx === cS1.offlineCtx && cB.audioCtx === cA.audioCtx && cB.created === cA.created, `OfflineAudioContext ${cS1.offlineCtx} → ${cB.offlineCtx}、AudioContext ${cA.audioCtx} → ${cB.audioCtx}、Object URL の作成 ${cA.created} → ${cB.created}`)

    // ---- 28. デモの WAV の書き出し（既存の書き出し・余韻で 40 秒より長くてよい） ----
    await startExport(b)
    const ex = await waitExport(b, 300000)
    const wavUrl = ex.done ? await b.ev(`u.$('[data-ui="download"]').getAttribute('href')`) : null
    const wav = wavUrl ? await b.ev(`u.wavInfo(${JSON.stringify(wavUrl)})`) : null
    const name = ex.done ? await b.ev(`u.$('[data-ui="download"]').getAttribute('download')`) : ''
    check(28, 'デモの WAV の書き出し: COMPLETE・48 kHz・ステレオ・40 秒 + 余韻', ex.done && !!wav && wav.riff === 'RIFF' && wav.sampleRate === 48000 && wav.channels === 2 && wav.seconds >= 40 && wav.seconds < 60, `${JSON.stringify(wav)}・${ex.ms} ms${ex.err ? `・${ex.err}` : ''}`)
    check(28, '書き出しのファイル名（デモ音源の名前・設定名・ビット深度）', /^CINEMA_SONIC_X_Spatial_Showcase_40s_24bit_IMMERSIVE_X_16bit\.wav$/.test(name), name)
    if (ex.done) {
      const size = await b.ev(`(async () => (await (await fetch(u.$('[data-ui="download"]').href)).blob()).size)()`)
      await b.ev(`u.$('[data-ui="download"]').click()`)
      let dl = false
      for (let i = 0; i < 80 && !dl; i++) {
        await sleep(250)
        dl = readdirSync(b.download).some((n) => n === name && statSync(join(b.download, n)).size === size)
      }
      check(28, 'デモの完成ファイルをダウンロードできる（同じサイズ）', dl, `${size} bytes`)
    }
    await workletCheck(b)

    // ---- 29. 通常のファイルに差し替えると、区間・デモの表示は出さない ----
    await b.setFile(FILES.music)
    await b.waitFor(`/ui-test-music\\.wav/.test(u.$('[data-ui="file-summary"]')?.textContent ?? '')`, 30000)
    const up = await demoState()
    const upStudio = await b.ev(`(async () => { u.$('[data-mode="studio"]').click(); await new Promise((r) => setTimeout(r, 300)); const r = { panel: !!u.$('.panel--demo'), source: u.byText('.panel--info dd', 'アップロードしたファイル')?.textContent ?? '' }; u.$('[data-mode="simple"]').click(); await new Promise((r) => setTimeout(r, 300)); return r })()`)
    check(29, '通常のファイル: 区間・公式デモの表示なし（SIMPLE / STUDIO）・書き出しの結果は消える', up.sections.length === 0 && !up.badge && !upStudio.panel && /アップロード/.test(upStudio.source) && !(await b.ev(`!!u.$('[data-ui="result"]')`)), JSON.stringify(upStudio))

    // ---- 30. スマートフォンの幅: デモを読み込んだ画面がはみ出さない ----
    await clickDemo()
    await b.waitFor(`!!u.$('[data-ui="demo-source"]')`, 60000)
    for (const [w, h, label] of [
      [390, 844, 'phone'],
      [768, 1024, 'tablet-portrait'],
    ]) {
      await b.viewport(w, h, w < 800)
      await sleep(400)
      const l = await layoutCheck(b, label)
      const sec = await b.ev(`(() => { const r = u.$$('[data-section]').map((e) => e.getBoundingClientRect()); return { n: r.length, minW: Math.min(...r.map((x) => x.width)), inside: r.every((x) => x.right <= window.innerWidth && x.left >= 0) } })()`)
      check(30, `デモ（${label} ${w}px）: 横にはみ出さない・区間 5 つが画面内`, l.over <= 0 && l.wide.length === 0 && sec.n === 5 && sec.inside && sec.minW >= 80, `はみ出し ${l.over}px、区間の最小幅 ${sec.minW.toFixed(0)}px${l.wide.length ? `、${l.wide.join(', ')}` : ''}`)
      await b.shot(`22-demo-${label}`)
    }
    await b.viewport(1440, 900)
    const errs = b.errors.filter((e) => !/favicon/.test(e))
    if (remoteUrl) check(31, `公開したデプロイ: 同じオリジン（${new URL(baseUrl).origin}）以外への通信なし`, b.foreign.length === 0, b.foreign.slice(0, 3).join(' | '))
    check(18, 'ページのエラー（例外・console.error）なし', errs.length === 0, errs.slice(0, 3).join(' | '))
  } finally {
    await b.close()
  }
}

console.log(`ブラウザ: ${browser}${remoteUrl ? `（公開したデプロイ: ${baseUrl}${trustedToken ? '・Vercel の認証ヘッダーあり' : ''}）` : usePreview ? '（本番ビルド: vite preview）' : ''}\n`)
let aborted = null
for (const [name, fn] of [
  ['audio', audioSession],
  ['video', videoSession],
  ['demo', demoSession],
]) {
  if (onlySession && onlySession !== name) continue
  console.log(`━━ セッション: ${name} ━━`)
  try {
    await fn()
  } catch (e) {
    aborted = `${name}: ${e instanceof Error ? e.message : String(e)}`
    console.log(`ERROR ${aborted}`)
    break
  }
}
if (server !== devServer) await server.close()
await devServer.close()
try {
  rmSync(work, { recursive: true, force: true })
} catch {
  // 残っても試験の結果には影響しない
}
const failed = results.filter((r) => !r.ok)
console.log('')
if (aborted) console.log(`ERROR（途中で中断。結果は未完了）: ${aborted}`)
console.log(failed.length === 0 && !aborted ? `ALL PASS (${results.length})` : `FAIL ${failed.length}/${results.length}`)
process.exit(failed.length === 0 && !aborted ? 0 : 1)
