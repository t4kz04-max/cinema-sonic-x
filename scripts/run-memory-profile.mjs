// Phase 09: 通常の利用でのメモリ・CPU の測定（合否なし）。
// 本番ビルド（vite preview）を、新しいプロファイルのヘッドレスの Chrome / Edge で開き、実際のアプリを操作して段階ごとに測る。
// 使い方: npm run build && npm run measure:memory
//         CSX_BROWSER=<実行ファイル> node scripts/run-memory-profile.mjs [--out=<結果の JSON>] [--quick]
// --quick: 待ち時間を短くする（スクリプトの確認用。測定値としては使わない）
//
// 測るもの（各段階）:
//   - ブラウザ全体（このプロファイルのプロセスすべて）のワーキングセット・プライベート（Windows のみ。プロセスの種類ごと）
//   - ブラウザを起動しただけ（about:blank）の値をベースラインとした差
//   - JS ヒープ（CDP Runtime.getHeapUsage。ページと同じオリジンの iframe を含む）、GC の後の値
//   - AudioContext / OfflineAudioContext / AudioWorkletNode / addModule の数、Object URL の数、iframe の数（トップのページだけを数える。
//     書き出し用の iframe の中で作られる文脈は数えない）
//   - デコード済みの PCM（計算値）、Windows の空きメモリ
//   - 再生中の CPU: ブラウザの全プロセスの CPU 時間 / 経過時間（音声スレッドを含む）、メインスレッドの時間（CDP Performance）
// 音声は --mute-audio で鳴らさない（処理は通常どおり行われる）。

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { freemem, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, preview } from 'vite'

const CANDIDATES = [process.env.CSX_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean)
const browser = CANDIDATES.find((p) => existsSync(p))
if (!browser) {
  console.error('Chrome / Edge が見つかりません。CSX_BROWSER に実行ファイルのパスを指定してください。')
  process.exit(2)
}
if (!existsSync('dist/index.html')) {
  console.error('dist がありません。先に npm run build を実行してください。')
  process.exit(2)
}
const quick = process.argv.includes('--quick')
// --endurance: 耐久試験（連続再生・モード 10 回・プリセット 20 回・WAV 5 回・動画 3 回・書き出し中のキャンセルと再実行）
const endurance = process.argv.includes('--endurance')
// --endurance-video-cancel: 耐久試験の最後の段階（動画の書き出し中のキャンセル → 再実行）だけ
const enduranceVideoCancel = process.argv.includes('--endurance-video-cancel')
const PLAY_MINUTES = Number(process.argv.find((a) => a.startsWith('--play-minutes='))?.slice(15) ?? 30)
const outPath = process.argv.find((a) => a.startsWith('--out='))?.slice(6)
const MIN_FREE_MB = Number(process.env.CSX_MIN_FREE_MB ?? 1500)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const W = (s) => (quick ? Math.min(s, 3) : s) * 1000

const work = mkdtempSync(join(tmpdir(), 'csx-memprof-files-'))

/** 楽曲相当の 16-bit ステレオ WAV（和音・低音・拍ごとのキック・ハイハット、乱数は固定の種） */
function makeWav(path, seconds, sampleRate = 48000) {
  const n = Math.round(seconds * sampleRate)
  const data = Buffer.alloc(n * 4)
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  const chords = [
    [110, 220, 277.18, 329.63],
    [98, 196, 246.94, 293.66],
    [87.31, 174.61, 220, 261.63],
    [98, 196, 246.94, 311.13],
  ]
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const beat = t % 0.5
    const chord = chords[Math.floor(t / 2) % chords.length]
    let l = 0
    let r = 0
    chord.forEach((f, k) => {
      const v = (k === 0 ? 0.12 : 0.07) * Math.sin(2 * Math.PI * f * t) + 0.02 * Math.sin(4 * Math.PI * f * t)
      l += v * (k === 1 ? 1 : 0.7)
      r += v * (k === 3 ? 1 : 0.7)
    })
    const kick = beat < 0.12 ? 0.35 * Math.sin(2 * Math.PI * (50 + 60 * Math.exp(-beat * 40)) * beat) * Math.exp(-beat * 18) : 0
    const hat = beat > 0.25 && beat < 0.28 ? 0.05 * rnd() : 0
    const vox = 0.06 * Math.sin(2 * Math.PI * (440 + 20 * Math.sin(2 * Math.PI * 5 * t)) * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.25 * t))
    l += kick + hat + vox + 0.01 * rnd()
    r += kick + hat * 0.8 + vox + 0.01 * rnd()
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

const INSTRUMENT = `(() => {
  if (window !== window.top) return
  const c = (window.__csxMem = { ctx: [], offline: 0, worklets: [], addModule: 0, created: 0, revoked: 0, urls: new Set() })
  const wrap = (name, onNew) => {
    const O = window[name]
    if (!O) return
    window[name] = class extends O {
      constructor(...a) {
        super(...a)
        onNew(this)
      }
    }
  }
  wrap('AudioContext', (x) => c.ctx.push(new WeakRef(x)))
  wrap('OfflineAudioContext', () => c.offline++)
  wrap('AudioWorkletNode', (x) => c.worklets.push(new WeakRef(x)))
  if (window.AudioWorklet) {
    const add = AudioWorklet.prototype.addModule
    AudioWorklet.prototype.addModule = function (...a) { c.addModule++; return add.apply(this, a) }
  }
  const cu = URL.createObjectURL.bind(URL)
  const ru = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = (o) => { const u = cu(o); c.urls.add(u); c.created++; return u }
  URL.revokeObjectURL = (u) => { c.urls.delete(u); c.revoked++; return ru(u) }
  // 何もしていないときのタイマー・アニメーションの数（起動時の軽量化の確認用）
  c.timeouts = 0; c.intervals = 0; c.raf = 0
  const st = window.setTimeout, si = window.setInterval, ra = window.requestAnimationFrame
  window.setTimeout = function (...a) { c.timeouts++; return st.apply(this, a) }
  window.setInterval = function (...a) { c.intervals++; return si.apply(this, a) }
  window.requestAnimationFrame = function (...a) { c.raf++; return ra.apply(this, a) }
})()`

const COUNTERS = `(() => {
  const c = window.__csxMem
  const ctxAlive = c.ctx.map((r) => r.deref()).filter((x) => x && x.state !== 'closed')
  return {
    audioContexts: ctxAlive.length,
    audioContextStates: ctxAlive.map((x) => x.state).join(','),
    offlineCreated: c.offline,
    workletNodesAlive: c.worklets.filter((r) => r.deref()).length,
    workletNodesCreated: c.worklets.length,
    addModule: c.addModule,
    objectUrls: c.urls.size,
    exportFrames: document.querySelectorAll('iframe[data-csx-export]').length,
    analysisFrames: document.querySelectorAll('iframe[data-csx-analysis]').length,
    timeouts: c.timeouts, intervals: c.intervals, raf: c.raf,
  }
})()`

async function launch() {
  const port = 9700 + Math.floor(Math.random() * 200)
  const profile = mkdtempSync(join(tmpdir(), 'csx-selftest-mem-'))
  const proc = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-sync',
      '--no-default-browser-check',
      '--enable-precise-memory-info',
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
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(`評価に失敗: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`)
    return r.result?.result?.value
  }
  const waitFor = async (expr, timeout = 60000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if (freemem() / 2 ** 20 < MIN_FREE_MB) throw new Error(`空きメモリが ${MIN_FREE_MB} MB 未満になったため中断`)
      try {
        if (await ev(expr)) return true
      } catch {
        // 切替中
      }
      await sleep(200)
    }
    return false
  }
  const setFile = async (path) => {
    const doc = await send('DOM.getDocument', { depth: -1 })
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' })
    await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [path] })
  }
  /** このプロファイルのプロセスの種類ごとのワーキングセット・プライベート（MB）・CPU 時間（秒） */
  const procs = () => {
    if (process.platform !== 'win32') return null
    const dir = profile.replace(/'/g, "''")
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir}') } | ForEach-Object { $t = if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'browser' }; if ($_.CommandLine -match 'utility-sub-type=([A-Za-z.]+)') { $t += ':' + ($Matches[1] -replace '^.*\\.(\\w+)\\.mojom\\.(\\w+)$', '$1') }; $cpu = ($_.KernelModeTime + $_.UserModeTime) / 1e7; '{0}|{1}|{2}|{3}' -f $t, $_.WorkingSetSize, $_.PrivatePageCount, $cpu }`],
      { encoding: 'utf8' },
    )
    const byType = {}
    let ws = 0
    let priv = 0
    let cpu = 0
    for (const line of out.trim().split(/\r?\n/)) {
      const [t, w, p, c] = line.split('|')
      if (!t) continue
      const e = (byType[t] ||= { ws: 0, priv: 0, n: 0 })
      e.ws += Number(w) / 2 ** 20
      e.priv += Number(p) / 2 ** 20
      e.n++
      ws += Number(w) / 2 ** 20
      priv += Number(p) / 2 ** 20
      cpu += Number(c)
    }
    for (const e of Object.values(byType)) {
      e.ws = Math.round(e.ws)
      e.priv = Math.round(e.priv)
    }
    return { ws: Math.round(ws), priv: Math.round(priv), cpu, byType }
  }
  const close = async () => {
    ws.close()
    if (process.platform === 'win32' && proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    else proc.kill()
    await sleep(1000)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      // ロックが残る場合は残す
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('DOM.enable')
  await send('Performance.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  return { send, ev, waitFor, setFile, procs, close }
}

// ---------- 試験用の動画（開発サーバーで作る。測定には含めない） ----------
async function makeVideo(path) {
  const dev = await createServer({ logLevel: 'error', server: { port: 5499, strictPort: false } })
  await dev.listen()
  const b = await launch()
  try {
    await b.send('Page.navigate', { url: dev.resolvedUrls.local[0] })
    await sleep(3000)
    const b64 = await b.ev(`(async () => {
      const { makeFixtureVideo } = await import('/src/dev/videoFixtures.ts')
      const { blob } = await makeFixtureVideo({ container: 'mp4', videoCodec: 'avc', audioCodec: 'aac', seconds: ${quick ? 20 : 180}, width: 640, height: 360, tone: 0.2 })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      window.__csxVideoB64 = btoa(s)
      return window.__csxVideoB64.length
    })()`)
    // 大きな文字列を 1 回で受け取ると DevTools の通信が止まる（4 MB で発生）ため、1 MB ずつ受け取る
    let text = ''
    for (let i = 0; i < b64; i += 1 << 20) text += await b.ev(`window.__csxVideoB64.slice(${i}, ${i + (1 << 20)})`)
    writeFileSync(path, Buffer.from(text, 'base64'))
  } finally {
    await b.close()
    await dev.close()
  }
}

const rows = []
let base = null
let decodedMb = 0

async function measure(b, label, extra = {}) {
  const p = b.procs()
  const heap = (await b.send('Runtime.getHeapUsage')).result
  await b.send('HeapProfiler.collectGarbage')
  await sleep(500)
  const heapGc = (await b.send('Runtime.getHeapUsage')).result
  const p2 = b.procs()
  const counters = await b.ev(COUNTERS)
  const row = {
    label,
    browserWs: p?.ws,
    browserPriv: p?.priv,
    browserWsAfterGc: p2?.ws,
    diffWs: p && base ? p.ws - base.ws : null,
    diffPriv: p && base ? p.priv - base.priv : null,
    renderer: p?.byType.renderer ?? null,
    gpu: p?.byType['gpu-process'] ?? null,
    audioService: Object.entries(p?.byType ?? {}).find(([k]) => /audio/i.test(k))?.[1] ?? null,
    jsHeapMb: +(heap.usedSize / 2 ** 20).toFixed(1),
    jsHeapAfterGcMb: +(heapGc.usedSize / 2 ** 20).toFixed(1),
    decodedPcmMb: decodedMb,
    freeMb: Math.round(freemem() / 2 ** 20),
    ...counters,
    ...extra,
  }
  rows.push(row)
  console.log(`[${label}] ブラウザ ${row.browserWs} MB（差 ${row.diffWs ?? '—'}）/ private ${row.browserPriv} MB（差 ${row.diffPriv ?? '—'}）・レンダラー ${row.renderer?.ws ?? '—'} MB・JS ヒープ ${row.jsHeapMb}（GC 後 ${row.jsHeapAfterGcMb}）MB・AudioContext ${counters.audioContexts}・Offline 作成 ${counters.offlineCreated}・WorkletNode ${counters.workletNodesAlive}/${counters.workletNodesCreated}・addModule ${counters.addModule}・Object URL ${counters.objectUrls}・空き ${row.freeMb} MB${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}`)
  return row
}

/** 期間中のブラウザ全体の最大メモリと CPU（全プロセスの CPU 時間 / 経過時間、% は 1 コア = 100%） */
async function sampleWhile(b, untilExpr, timeout) {
  let peak = 0
  const t0 = Date.now()
  const c0 = b.procs()?.cpu ?? 0
  let done = false
  while (Date.now() - t0 < timeout) {
    const p = b.procs()
    if (p && p.ws > peak) peak = p.ws
    if (freemem() / 2 ** 20 < MIN_FREE_MB) throw new Error(`空きメモリが ${MIN_FREE_MB} MB 未満になったため中断`)
    if (untilExpr && (await b.ev(untilExpr))) {
      done = true
      break
    }
    if (!untilExpr && Date.now() - t0 >= timeout - 1000) break
    await sleep(1000)
  }
  const c1 = b.procs()?.cpu ?? 0
  return { peak, done, seconds: (Date.now() - t0) / 1000, cpuPct: +((100 * (c1 - c0)) / ((Date.now() - t0) / 1000)).toFixed(1) }
}

async function mainThread(b, ms) {
  const get = async () => Object.fromEntries((await b.send('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]))
  const a = await get()
  const c0 = b.procs()?.cpu ?? 0
  const t0 = Date.now()
  await sleep(ms)
  const z = await get()
  const c1 = b.procs()?.cpu ?? 0
  const wall = (Date.now() - t0) / 1000
  return { mainScriptPct: +((100 * (z.ScriptDuration - a.ScriptDuration)) / wall).toFixed(1), mainTaskPct: +((100 * (z.TaskDuration - a.TaskDuration)) / wall).toFixed(1), browserCpuPct: +((100 * (c1 - c0)) / wall).toFixed(1) }
}

/** 書き出しを始めて終わるまで（ブラウザのメモリの最大値を記録） */
async function exportOnce(b, timeout) {
  await b.ev(`document.querySelector('[data-ui="export"]').click()`)
  return sampleWhile(b, `!!document.querySelector('[data-ui="result"]') || !!document.querySelector('.alert--export')`, timeout)
}

/** 書き出し。直前の書き出しのメモリが残っていて始めなかった場合は、表示の指示どおり待ってからもう一度（最大 3 回） */
async function exportWithRetry(b, timeout) {
  const r = await exportOnce(b, timeout)
  let err = await b.ev(`document.querySelector('.alert--export .alert__title')?.textContent ?? null`)
  let waited = 0
  while (err && /待ってから/.test(await b.ev(`document.querySelector('.alert--export')?.textContent ?? ''`)) && waited < 3) {
    waited++
    await sleep(50000)
    const again = await exportOnce(b, timeout)
    r.peak = Math.max(r.peak, again.peak)
    r.done = again.done
    r.seconds = again.seconds
    err = await b.ev(`document.querySelector('.alert--export .alert__title')?.textContent ?? null`)
  }
  return { completed: r.done && !err, peakMb: r.peak, exportSeconds: r.seconds, waitedForRetained: waited, error: err }
}

const cancelledShown = `[...document.querySelectorAll('.output-stage__note')].some((e) => e.textContent.includes('キャンセルしました'))`

/** 耐久試験。各段階の後にメモリを測り、再生位置が進み続けているか・エラーが出ていないかを記録する */
async function runEndurance(b, appUrl, music, videoPath) {
  await b.send('Page.navigate', { url: appUrl })
  await b.waitFor(`!!document.querySelector('[data-view]')`, 30000)
  await sleep(2000)
  await measure(b, 'E0. 起動直後')
  await b.setFile(music)
  await b.waitFor(`!!document.querySelector('[data-ui="file-summary"]')`, 60000)
  decodedMb = +(((quick ? 30 : 180) * 48000 * 2 * 4) / 2 ** 20).toFixed(1)
  await b.ev(`document.querySelector('[data-preset="immersive-x"]').click()`)
  await b.waitFor(analysisDone, 60000)
  // 連続再生（3 分の音源を LOOP。LOOP は STUDIO の再生パネル）
  await b.ev(`document.querySelector('[data-mode="studio"]').click()`)
  await b.waitFor(`!!document.querySelector('#studio-transport')`, 5000)
  await b.ev(`document.querySelector('#studio-transport .loop-btn').click()`)
  await b.ev(`document.querySelector('#studio-transport [aria-label="再生"]').click()`)
  await measure(b, 'E1. 連続再生の開始（IMMERSIVE X・LOOP）')
  const minutes = quick ? 1 : PLAY_MINUTES
  let lastPos = ''
  let stalls = 0
  let peak = 0
  for (let m = 1; m <= minutes; m++) {
    const s = await sampleWhile(b, null, 60000)
    peak = Math.max(peak, s.peak)
    const pos = await b.ev(`document.querySelector('[data-ui="position"]')?.textContent ?? ''`)
    const playing = await b.ev(`!!document.querySelector('#studio-transport [aria-label="一時停止"]')`)
    if (!playing || pos === lastPos) stalls++
    lastPos = pos
    if (m % 5 === 0 || m === minutes) await measure(b, `E2. 連続再生 ${m} 分`, { position: pos, playing, peakSoFarMb: peak, browserCpuPct: s.cpuPct })
  }
  await measure(b, 'E3. 連続再生の終わり', { minutes, stalls, peakDuringPlayMb: peak })
  await b.ev(`document.querySelector('#studio-transport [aria-label="一時停止"]')?.click()`)
  await b.ev(`document.querySelector('#studio-transport .loop-btn').click()`)
  // 10 回の SIMPLE / STUDIO 切替
  for (let i = 0; i < 10; i++) {
    await b.ev(`document.querySelector('[data-mode="${i % 2 === 0 ? 'simple' : 'studio'}"]').click()`)
    await sleep(800)
  }
  await b.ev(`document.querySelector('[data-mode="simple"]').click()`)
  await sleep(500)
  await measure(b, 'E4. モード 10 回切替の後')
  // 20 回のプリセット切替（再生中）
  await b.ev(`document.querySelector('.simple-preview [aria-label="再生"]')?.click()`)
  const ids = ['cinema-3d', 'live-arena', 'motion-360', 'immersive-x']
  for (let i = 0; i < 20; i++) {
    await b.ev(`document.querySelector('[data-preset="${ids[i % 4]}"]').click()`)
    await sleep(1500)
  }
  await b.waitFor(analysisDone, 60000)
  await sleep(3000)
  await measure(b, 'E5. プリセット 20 回切替の後（再生中）')
  await b.ev(`document.querySelector('.simple-preview [aria-label="一時停止"]')?.click()`)
  // 5 回の WAV 書き出し（3 分、IMMERSIVE X）
  for (let i = 1; i <= 5; i++) await measure(b, `E6. WAV 書き出し ${i} 回目`, await exportWithRetry(b, 900000))
  // 書き出し中のキャンセル → 再実行
  await b.ev(`document.querySelector('[data-ui="export"]').click()`)
  await b.waitFor(`document.querySelector('.export-stages li.is-current')?.dataset.stage === 'rendering'`, 120000)
  await sleep(2000)
  await b.ev(`document.querySelector('[data-ui="cancel"]').click()`)
  const cancelled = await b.waitFor(cancelledShown, 30000)
  await measure(b, 'E7. WAV 書き出し中のキャンセル', { cancelled, exportFrames: await b.ev(`document.querySelectorAll('iframe[data-csx-export]').length`) })
  await measure(b, 'E8. キャンセル後の再実行（WAV）', await exportWithRetry(b, 900000))
  // 3 回の動画書き出し（3 分 640×360）
  await b.setFile(videoPath)
  await b.waitFor(`/memprof-video/.test(document.querySelector('[data-ui="file-summary"]')?.textContent ?? '')`, 120000)
  await b.ev(`document.querySelector('[data-preset="cinema-3d"]').click()`)
  await b.waitFor(analysisDone, 60000)
  await b.ev(`document.querySelector('[data-output="video"]')?.click()`)
  for (let i = 1; i <= 3; i++) await measure(b, `E9. 動画書き出し ${i} 回目`, await exportWithRetry(b, 900000))
  // 動画の書き出し中のキャンセル → 再実行
  await b.ev(`document.querySelector('[data-ui="export"]').click()`)
  await b.waitFor(`['rendering', 'muxing'].includes(document.querySelector('.export-stages li.is-current')?.dataset.stage)`, 120000)
  await sleep(2000)
  await b.ev(`document.querySelector('[data-ui="cancel"]').click()`)
  const vc = await b.waitFor(cancelledShown, 30000)
  await measure(b, 'E10. 動画のキャンセルと再実行', { cancelled: vc, ...(await exportWithRetry(b, 900000)) })
  await sleep(W(60))
  await measure(b, 'E11. すべての後 60 秒待機')
}

/** 耐久試験の最後の段階だけ: 動画を読み込み、書き出し中にキャンセル → すぐに再実行 */
async function runVideoCancelOnly(b, appUrl, videoPath) {
  await b.send('Page.navigate', { url: appUrl })
  await b.waitFor(`!!document.querySelector('[data-view]')`, 30000)
  await b.setFile(videoPath)
  await b.waitFor(`/memprof-video/.test(document.querySelector('[data-ui="file-summary"]')?.textContent ?? '')`, 120000)
  await b.ev(`document.querySelector('[data-preset="cinema-3d"]').click()`)
  await b.waitFor(analysisDone, 60000)
  await b.ev(`document.querySelector('[data-output="video"]')?.click()`)
  await measure(b, 'V0. 動画の読み込み')
  await b.ev(`document.querySelector('[data-ui="export"]').click()`)
  await b.waitFor(`['rendering', 'muxing'].includes(document.querySelector('.export-stages li.is-current')?.dataset.stage)`, 120000)
  await sleep(2000)
  await b.ev(`document.querySelector('[data-ui="cancel"]').click()`)
  const vc = await b.waitFor(cancelledShown, 30000)
  await measure(b, 'V1. 動画の書き出し中のキャンセル', { cancelled: vc, exportFrames: await b.ev(`document.querySelectorAll('iframe[data-csx-export]').length`) })
  await measure(b, 'V2. キャンセル後の再実行（動画）', await exportWithRetry(b, 900000))
  await sleep(W(60))
  await measure(b, 'V3. 60 秒待機')
}

const analysisDone = `!document.querySelector('.output-stage__note')?.textContent.includes('測定中')`

console.log(`ブラウザ: ${browser}${quick ? '（--quick: 確認用。測定値として使わない）' : ''}\n`)
const music = makeWav(join(work, 'memprof-music-3min.wav'), quick ? 30 : 180)
const videoPath = join(work, 'memprof-video-3min.mp4')
console.log('試験用の動画を作成中（測定には含めない）…')
await makeVideo(videoPath)

const server = await preview({ logLevel: 'error', preview: { port: 4199, strictPort: false } })
const appUrl = server.resolvedUrls.local[0]
const b = await launch()
let aborted = null
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT })
  await sleep(W(10))
  const p0 = b.procs()
  base = p0
  rows.push({ label: '0. ブラウザを起動しただけ（about:blank、ベースライン）', browserWs: p0?.ws, browserPriv: p0?.priv, byType: p0?.byType, freeMb: Math.round(freemem() / 2 ** 20) })
  console.log(`[ベースライン] ブラウザ ${p0?.ws} MB / private ${p0?.priv} MB ${JSON.stringify(p0?.byType)}`)

  if (enduranceVideoCancel) {
    await runVideoCancelOnly(b, appUrl, videoPath)
    throw null
  }
  if (endurance) {
    await runEndurance(b, appUrl, music, videoPath)
    throw null
  }
  await b.send('Page.navigate', { url: appUrl })
  await b.waitFor(`!!document.querySelector('[data-view]')`, 30000)
  await sleep(2000)
  await measure(b, 'A. アプリ起動直後（2 秒後）')
  const t0 = await b.ev(`({ t: window.__csxMem.timeouts, i: window.__csxMem.intervals, r: window.__csxMem.raf })`)
  await sleep(W(60))
  const t1 = await b.ev(`({ t: window.__csxMem.timeouts, i: window.__csxMem.intervals, r: window.__csxMem.raf })`)
  await measure(b, 'B. ファイル未読み込みで 60 秒待機', { idleTimers60s: { setTimeout: t1.t - t0.t, setInterval: t1.i - t0.i, requestAnimationFrame: t1.r - t0.r } })

  await b.setFile(music)
  await b.waitFor(`!!document.querySelector('[data-ui="file-summary"]')`, 60000)
  decodedMb = +((quick ? 30 : 180) * 48000 * 2 * 4 / 2 ** 20).toFixed(1)
  await b.waitFor(analysisDone, 60000)
  await sleep(2000)
  await measure(b, 'C. 3 分の音楽を読み込み（解析の完了後）')

  const presets = [
    ['cinema-3d', 'D. CINEMA 3D で再生'],
    ['live-arena', 'E. LIVE ARENA で再生'],
    ['motion-360', 'F. 360° MOTION で再生'],
    ['immersive-x', 'G. IMMERSIVE X で再生'],
  ]
  for (const [id, label] of presets) {
    await b.ev(`document.querySelector('[data-preset="${id}"]').click()`)
    await b.waitFor(analysisDone, 60000)
    if (await b.ev(`!!document.querySelector('.simple-preview [aria-label="再生"]')`)) await b.ev(`document.querySelector('.simple-preview [aria-label="再生"]').click()`)
    await sleep(W(5))
    const cpu = await mainThread(b, W(15))
    await measure(b, label, cpu)
  }

  // H. 再生しながら 4 つのプリセットを 20 回切り替える（1.5 秒おき）
  const ids = presets.map(([id]) => id)
  for (let i = 0; i < 20; i++) {
    await b.ev(`document.querySelector('[data-preset="${ids[i % 4]}"]').click()`)
    await sleep(1500)
  }
  await b.waitFor(analysisDone, 60000)
  await sleep(3000)
  await measure(b, 'H. 4 プリセットを 20 回切替（再生中）')
  await b.ev(`document.querySelector('.simple-preview [aria-label="一時停止"]')?.click()`)

  // I. WAV の書き出し（IMMERSIVE X、16-bit）
  await b.ev(`document.querySelector('[data-preset="immersive-x"]').click()`)
  await b.waitFor(analysisDone, 60000)
  await b.ev(`document.querySelector('[data-ui="export"]').click()`)
  const ex = await sampleWhile(b, `!!document.querySelector('[data-ui="result"]') || !!document.querySelector('.alert--export')`, 600000)
  await measure(b, 'I. WAV 書き出し（完了の直後）', { peakDuringExportMb: ex.peak, exportSeconds: ex.seconds, browserCpuPctDuringExport: ex.cpuPct, completed: ex.done })
  await sleep(W(60))
  await measure(b, 'J. WAV 書き出し完了の 60 秒後')

  // K〜M. 動画（3 分 640×360 30fps、AVC + AAC）
  await b.setFile(videoPath)
  await b.waitFor(`/memprof-video/.test(document.querySelector('[data-ui="file-summary"]')?.textContent ?? '')`, 120000)
  decodedMb = +((quick ? 20 : 180) * 48000 * 2 * 4 / 2 ** 20).toFixed(1)
  await b.waitFor(analysisDone, 60000)
  await sleep(2000)
  await measure(b, 'K. 動画の読み込み（3 分 640×360、解析の完了後）')
  await b.ev(`document.querySelector('[data-output="video"]')?.click()`)
  await b.ev(`document.querySelector('[data-ui="export"]').click()`)
  const vx = await sampleWhile(b, `!!document.querySelector('[data-ui="result"]') || !!document.querySelector('.alert--export')`, 900000)
  await measure(b, 'L. 動画書き出し（完了の直後）', { peakDuringExportMb: vx.peak, exportSeconds: vx.seconds, browserCpuPctDuringExport: vx.cpuPct, completed: vx.done })
  await sleep(W(60))
  await measure(b, 'M. 動画書き出し完了の 60 秒後')
} catch (e) {
  // throw null: 耐久試験の終わり（エラーではない）
  if (e !== null) {
    aborted = e instanceof Error ? e.message : String(e)
    console.log(`ERROR ${aborted}`)
  }
} finally {
  await b.close()
  await server.close()
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    // 残っても測定に影響しない
  }
}
if (outPath) writeFileSync(outPath, JSON.stringify({ browser, quick, aborted, rows }, null, 2))
console.log(aborted ? `\n中断: ${aborted}` : '\n完了')
