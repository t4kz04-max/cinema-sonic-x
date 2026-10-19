// 残響（余韻）の測定（純粋関数、テスト専用）。
// インパルス応答・停止後の出力から、残響時間（Schroeder 積分）・帯域別残響時間・時間窓ごとの
// 両耳間相関（IACC）・Side/Mid 比・スペクトル重心を求める。HALL のベースラインと Spatial Tail の比較に使う。

/** RBJ バンドパス（0 dB ピーク）を 2 段重ねたオクターブ帯域フィルター */
export function octaveBand(x: Float32Array, fc: number, rate: number): Float32Array {
  let y = x
  for (let stage = 0; stage < 2; stage++) {
    const w0 = (2 * Math.PI * fc) / rate
    const q = Math.SQRT2
    const alpha = Math.sin(w0) / (2 * q)
    const a0 = 1 + alpha
    const b0 = alpha / a0
    const b2 = -alpha / a0
    const a1 = (-2 * Math.cos(w0)) / a0
    const a2 = (1 - alpha) / a0
    const out = new Float32Array(y.length)
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    for (let i = 0; i < y.length; i++) {
      const v = b0 * y[i] + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = y[i]
      y2 = y1
      y1 = v
      out[i] = v
    }
    y = out
  }
  return y
}

/** Schroeder の後ろ向き積分による減衰曲線（dB、from 以降の全エネルギーを 0 dB） */
export function energyDecayCurve(channels: Float32Array[], from: number): Float64Array {
  const n = channels[0].length - from
  const edc = new Float64Array(n)
  let acc = 0
  for (let i = n - 1; i >= 0; i--) {
    for (const ch of channels) acc += ch[from + i] * ch[from + i]
    edc[i] = acc
  }
  const total = edc[0] || 1e-30
  for (let i = 0; i < n; i++) edc[i] = 10 * Math.log10(edc[i] / total + 1e-30)
  return edc
}

/** EDC の hi dB → lo dB 区間の回帰直線から 60 dB 減衰時間を求める（T20: −5→−25、T30: −5→−35、EDT: 0→−10） */
export function decayTime(edc: Float64Array, rate: number, hi: number, lo: number): number {
  let i0 = -1
  let i1 = -1
  for (let i = 0; i < edc.length; i++) {
    if (i0 < 0 && edc[i] <= hi) i0 = i
    if (edc[i] <= lo) {
      i1 = i
      break
    }
  }
  if (i0 < 0 || i1 <= i0 + 2) return NaN
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  const step = Math.max(1, Math.floor((i1 - i0) / 2000))
  let n = 0
  for (let i = i0; i <= i1; i += step) {
    const x = i / rate
    sx += x
    sy += edc[i]
    sxx += x * x
    sxy += x * edc[i]
    n++
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx)
  return slope < 0 ? -60 / slope : NaN
}

/** EDC が level dB を下回る時刻（秒） */
export function timeToLevel(edc: Float64Array, rate: number, level: number): number {
  for (let i = 0; i < edc.length; i++) if (edc[i] <= level) return i / rate
  return NaN
}

export interface WindowStats {
  from: number
  to: number
  /** 窓のエネルギー（dB、基準は呼び出し側で引く） */
  levelDb: number
  /** 両耳間相関の最大値（±1 ms のずれ）。1 = 中央の一点、0 = 完全に拡散 */
  iacc: number
  /** Side/Mid エネルギー比（dB）。大きいほど広い */
  sideToMidDb: number
  /** スペクトル重心（Hz） */
  centroidHz: number
  /** 右 − 左のレベル差（dB） */
  ildDb: number
}

function fftMag(x: Float64Array): Float64Array {
  const n = x.length
  const re = Float64Array.from(x)
  const im = new Float64Array(n)
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k)
        const wi = Math.sin(ang * k)
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * wr - im[b] * wi
        const ti = re[b] * wi + im[b] * wr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
  const mag = new Float64Array(n / 2)
  for (let k = 0; k < n / 2; k++) mag[k] = re[k] * re[k] + im[k] * im[k]
  return mag
}

/** 時間窓 [from, to)（秒）の空間・音色の統計 */
export function windowStats(L: Float32Array, R: Float32Array, rate: number, from: number, to: number): WindowStats {
  const a = Math.max(0, Math.round(from * rate))
  const b = Math.min(L.length, Math.round(to * rate))
  let el = 0
  let er = 0
  let em = 0
  let es = 0
  for (let i = a; i < b; i++) {
    el += L[i] * L[i]
    er += R[i] * R[i]
    const m = (L[i] + R[i]) / 2
    const s = (L[i] - R[i]) / 2
    em += m * m
    es += s * s
  }
  const maxLag = Math.round(rate * 0.001)
  let iacc = 0
  const norm = Math.sqrt(el * er) || 1e-30
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let c = 0
    for (let i = Math.max(a, a - lag); i < Math.min(b, b - lag); i++) c += L[i] * R[i + lag]
    iacc = Math.max(iacc, Math.abs(c) / norm)
  }
  // スペクトル重心: 4096 点の窓を重ねて平均したパワースペクトル
  const n = 4096
  const pow = new Float64Array(n / 2)
  const buf = new Float64Array(n)
  for (let s = a; s + n <= b || s === a; s += n / 2) {
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
      const k = s + i
      buf[i] = k < b ? ((L[k] + R[k]) / 2) * w : 0
    }
    const m = fftMag(buf)
    for (let k = 0; k < n / 2; k++) pow[k] += m[k]
    if (s + n > b) break
  }
  let num = 0
  let den = 0
  for (let k = 1; k < n / 2; k++) {
    num += ((k * rate) / n) * pow[k]
    den += pow[k]
  }
  return {
    from,
    to,
    levelDb: 10 * Math.log10((el + er) / Math.max(1, b - a) + 1e-30),
    iacc,
    sideToMidDb: 10 * Math.log10((es + 1e-30) / (em + 1e-30)),
    centroidHz: den > 0 ? num / den : 0,
    ildDb: 10 * Math.log10((er + 1e-30) / (el + 1e-30)),
  }
}

export const TAIL_WINDOWS: [number, number][] = [
  [0, 0.05],
  [0.05, 0.2],
  [0.2, 0.5],
  [0.5, 1],
  [1, 2],
  [2, 3],
]
export const OCTAVE_CENTERS = [250, 500, 1000, 2000, 4000, 8000]

export interface TailReport {
  t20: number
  t30: number
  edt: number
  /** EDC が −60 dB に達する時刻（秒）= 余韻が聞こえなくなる目安 */
  to60: number
  bandT20: { fc: number; t20: number }[]
  windows: WindowStats[]
}

/** start（サンプル）以降をインパルス応答・停止後の余韻とみなして測定する */
export function analyzeTail(L: Float32Array, R: Float32Array, rate: number, start: number): TailReport {
  const edc = energyDecayCurve([L, R], start)
  const bandT20 = OCTAVE_CENTERS.map((fc) => {
    const e = energyDecayCurve([octaveBand(L, fc, rate), octaveBand(R, fc, rate)], start)
    return { fc, t20: decayTime(e, rate, -5, -25) }
  })
  const sub = (x: Float32Array) => x.subarray(start)
  const ref = windowStats(sub(L), sub(R), rate, 0, 0.05).levelDb
  const windows = TAIL_WINDOWS.map(([f, t]) => {
    const w = windowStats(sub(L), sub(R), rate, f, t)
    return { ...w, levelDb: w.levelDb - ref }
  })
  return {
    t20: decayTime(edc, rate, -5, -25),
    t30: decayTime(edc, rate, -5, -35),
    edt: decayTime(edc, rate, 0, -10),
    to60: timeToLevel(edc, rate, -60),
    bandT20,
    windows,
  }
}

export async function sha256Hex(channels: Float32Array[]): Promise<string> {
  const bytes = new Uint8Array(channels.reduce((n, c) => n + c.byteLength, 0))
  let o = 0
  for (const c of channels) {
    bytes.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), o)
    o += c.byteLength
  }
  const h = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function formatTail(r: TailReport): string {
  const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—')
  return [
    `T20 ${f(r.t20)} s / T30 ${f(r.t30)} s / EDT ${f(r.edt)} s / −60 dB 到達 ${f(r.to60)} s`,
    `帯域 T20: ${r.bandT20.map((b) => `${b.fc >= 1000 ? `${b.fc / 1000}k` : b.fc}=${f(b.t20)}`).join(' ')}`,
    ...r.windows.map(
      (w) =>
        `${(w.from * 1000).toFixed(0)}–${(w.to * 1000).toFixed(0)} ms: レベル ${f(w.levelDb, 1)} dB・IACC ${f(w.iacc)}・S/M ${f(w.sideToMidDb, 1)} dB・重心 ${w.centroidHz.toFixed(0)} Hz`,
    ),
  ].join(' | ')
}
