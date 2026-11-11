import type { DemoTrack } from './demoSpec'

/**
 * 公式デモ音源を同じサイトの静的ファイルから取得し、通常のアップロードと同じ File にする
 * （以降は loadAudioFile → 同じ DSP・書き出しの経路）。
 *
 * - 取得するのはサイトに置いたデモ音源だけ。利用者の音声・ファイル名はどこにも送らない（GET のみ・本文なし）
 * - 見つからないパスは開発サーバー・ホスティングの設定によって index.html が 200 で返ることがあるため、
 *   中身が RIFF / WAVE であることを確かめてから File にする
 */

export type DemoFetchReason = 'http' | 'network' | 'timeout' | 'not-wav' | 'aborted'

export class DemoFetchError extends Error {
  readonly reason: DemoFetchReason
  readonly status: number | null
  constructor(reason: DemoFetchReason, message: string, status: number | null = null) {
    super(message)
    this.name = 'DemoFetchError'
    this.reason = reason
    this.status = status
  }
}

/** 取得の上限時間（ms）。遅い回線で 11 MB を取得できる程度の長さにし、止まったままにしない */
export const DEMO_FETCH_TIMEOUT_MS = 90_000

const isRiffWave = (b: Uint8Array) =>
  b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45

/**
 * signal: 別のファイルを読み込み始めたときなどに呼び出し側が中止する。
 * 時間切れはこの関数の中で中止し、reason = 'timeout' で返す
 */
export async function fetchDemoFile(demo: DemoTrack, signal: AbortSignal, timeoutMs = DEMO_FETCH_TIMEOUT_MS): Promise<File> {
  // 取得してよいのは同じサイト（オリジン）の /audio/ の静的ファイルだけ（CLAUDE.md 絶対条件 1 の例外の範囲）。外部の URL は取得しない
  const target = new URL(demo.url, window.location.href)
  if (target.origin !== window.location.origin || !target.pathname.startsWith('/audio/')) {
    throw new DemoFetchError('http', 'サンプル音源の取得先が同じサイトの /audio/ ではないため取得しません。')
  }
  // 呼び出し側の中止と時間切れを 1 つの AbortController にまとめる（リスナーは終わったら外す。CLAUDE.md: 長く残るリスナーを作らない）
  const ac = new AbortController()
  let timedOut = false
  const onAbort = () => ac.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) ac.abort()
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, timeoutMs)
  try {
    let res: Response
    try {
      res = await fetch(target, { method: 'GET', signal: ac.signal, credentials: 'same-origin', referrerPolicy: 'no-referrer' })
    } catch (e) {
      throw abortOr(e, timedOut, signal, 'ネットワークに接続できないか、取得が中断されました。')
    }
    if (!res.ok) throw new DemoFetchError('http', `サーバーが HTTP ${res.status} を返しました。`, res.status)
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await res.arrayBuffer())
    } catch (e) {
      throw abortOr(e, timedOut, signal, '取得の途中で通信が切れました。')
    }
    if (!isRiffWave(bytes)) {
      const type = res.headers.get('content-type') ?? '不明'
      throw new DemoFetchError('not-wav', `取得した内容が WAV ではありません（Content-Type: ${type}、${bytes.length} バイト）。音源ファイルが配置されていない可能性があります。`)
    }
    return new File([bytes as Uint8Array<ArrayBuffer>], demo.fileName, { type: 'audio/wav' })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

function abortOr(e: unknown, timedOut: boolean, outer: AbortSignal, fallback: string): DemoFetchError {
  if (timedOut) return new DemoFetchError('timeout', `${Math.round(DEMO_FETCH_TIMEOUT_MS / 1000)} 秒以内に取得できませんでした。`)
  if (outer.aborted) return new DemoFetchError('aborted', '取得を中止しました。')
  return new DemoFetchError('network', `${fallback}（${e instanceof Error ? e.message : String(e)}）`)
}
