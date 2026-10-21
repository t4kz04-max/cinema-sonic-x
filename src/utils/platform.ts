/**
 * 端末・ブラウザによる機能の制限（Phase 08）。
 * 主な対象は PC の Chrome / Edge。スマートフォン・タブレットでは動画の書き出し（映像のコピー + 音声のエンコードを
 * すべてメモリ上で行い、1 GiB までの動画を扱う）を無理に実行させず、理由を表示する
 */
export interface PlatformLimits {
  /** スマートフォン・タブレット（タッチ主体の端末） */
  mobile: boolean
  /** 動画の書き出し（立体音響化した動画） */
  videoExport: { ok: true } | { ok: false; reason: string }
  /** 画面に出す注意（なければ null） */
  notice: string | null
}

interface NavigatorUAData {
  mobile?: boolean
}

function detect(): PlatformLimits {
  if (typeof navigator === 'undefined') return { mobile: false, videoExport: { ok: true }, notice: null }
  const ua = navigator.userAgent
  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData }).userAgentData
  // iPadOS は PC の Safari と同じ UA を名乗るため、タッチ点の数で見分ける
  const mobile = uaData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  const webCodecs = typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined'
  const videoExport: PlatformLimits['videoExport'] = mobile
    ? { ok: false, reason: 'スマートフォン・タブレットでは動画の書き出しに対応していません（メモリと処理時間の制約のため）。PC の Chrome / Edge で書き出してください。音声（WAV）の書き出しは利用できます。' }
    : !webCodecs
      ? { ok: false, reason: 'このブラウザは WebCodecs に対応していないため、動画を書き出せません。PC の Chrome / Edge の最新版を使ってください。' }
      : { ok: true }
  const notice = mobile
    ? 'スマートフォン・タブレットでは一部の機能を制限しています: 動画の書き出しは不可、長い音源の書き出しはメモリ不足で失敗する場合があります。主な対象は PC の Chrome / Edge です。'
    : null
  return { mobile, videoExport, notice }
}

let cached: PlatformLimits | null = null

/** 端末の制限（ページの読み込み中は変わらないため 1 回だけ判定する） */
export function platformLimits(): PlatformLimits {
  cached ??= detect()
  return cached
}
