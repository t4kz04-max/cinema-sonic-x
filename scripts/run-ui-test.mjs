// Phase 08: UI の試験（SIMPLE / STUDIO）。実際のアプリ（index.html）をヘッドレスの Chrome / Edge で開き、
// ボタン・スライダー・ファイルの選択を操作して確認する。
// 使い方: npm run test:ui                      （Chrome → Edge の順に自動検出した 1 つ）
//         CSX_BROWSER=<実行ファイル> npm run test:ui
//         node scripts/run-ui-test.mjs --session=audio|video   （一部だけ）
//         node scripts/run-ui-test.mjs --screens=<フォルダー>   （確認用の画面写真を保存）
// 依存追加なし: Vite の開発サーバー + Chrome DevTools Protocol（Node 22+ の組み込み WebSocket）
// 試験用の音声（WAV）は Node で合成し、試験用の動画は src/dev/videoFixtures.ts（WebCodecs）でブラウザ内で作る。
// 2 つのセッション（音声 / 動画）を別々のブラウザで順に実行する（メモリを積み上げない）。

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
const onlySession = process.argv.find((a) => a.startsWith('--session='))?.slice(10)
const screensDir = process.argv.find((a) => a.startsWith('--screens='))?.slice(10)
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

// ---------- ページに入れる計測（トップのページだけ。書き出し用の iframe には入れない） ----------
const INSTRUMENT = `(() => {
  if (window !== window.top) return
  const c = (window.__csxUi = { audioCtx: 0, offlineCtx: 0, created: 0, revoked: 0, urls: new Set() })
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
const server = await createServer({ logLevel: 'error', server: { port: 5299, strictPort: false } })
await server.listen()
const baseUrl = server.resolvedUrls.local[0]

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
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
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
  return { send, ev, waitFor, setFile, shot, viewport, navigate, close, errors, download, browserMemoryMb, metrics }
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
    const afterCancel = await b.ev(`({ live: u.counters().live.length, btn: u.$('[data-ui="export"]').disabled, frames: document.querySelectorAll('iframe').length, result: !!u.$('[data-ui="result"]') })`)
    check(15, 'キャンセル: レンダリング中に止めて「キャンセルしました」・結果なし・iframe なし', rendering && cx.cancelled && !afterCancel.result && afterCancel.frames === 0 && afterCancel.live === urlsBeforeCancel && !afterCancel.btn, JSON.stringify({ ...afterCancel, seen: cx.seen }))
    // キャンセルの後にもう一度書き出せる
    await startExport(b)
    const re = await waitExport(b, 300000)
    const reWav = re.done ? await b.ev(`u.wavInfo(u.$('[data-ui="download"]').href)`) : null
    const depthNow = (await b.ev(`u.byText('.simple-option .ab-switch__item', '24-bit').getAttribute('aria-checked')`)) === 'true' ? 24 : 16
    check(15, 'キャンセルの後にもう一度書き出せる（90 秒 + 余韻、選んだビット深度）', re.done && reWav.seconds >= 90 && reWav.bits === depthNow, re.done ? `${reWav.seconds.toFixed(2)} 秒・${re.ms} ms` : String(re.err))
    info('ブラウザのメモリ（音声のセッションの終わり、MB）', String(b.browserMemoryMb()?.toFixed(0)))
    const errs = b.errors.filter((e) => !/favicon/.test(e))
    check(18, 'ページのエラー（例外・console.error）なし', errs.length === 0, errs.slice(0, 3).join(' | '))
  } finally {
    await b.close()
  }
}

// ================= セッション 2: 動画 =================
async function videoSession() {
  currentSession = 'video'
  const b = await launch()
  try {
    await b.navigate()
    // 試験用の動画をブラウザ内で作り（WebCodecs）、ファイルとして保存してから読み込む（実際のファイルの選択と同じ経路）
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

console.log(`ブラウザ: ${browser}\n`)
let aborted = null
for (const [name, fn] of [
  ['audio', audioSession],
  ['video', videoSession],
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
await server.close()
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
