// HALL モードの後期残響用インパルス応答の合成（純粋関数）。
// 左右で無相関のノイズに指数減衰をかけ、時間とともにカットオフが下がるローパスで
// 「高域ほど早く減衰する」実際のホールの性質を近似する。エネルギーは各チャンネル 1 に正規化。

function prng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000 - 0.5
  }
}

/** 残響のビルドアップ時間（拡散音場が立ち上がるまで） */
const BUILD_UP_SECONDS = 0.012
export const MAX_IR_SECONDS = 4.5

/** maxSeconds: IR の最大長（HALL は 4.5 秒。Spatial Tail は長い残響時間のために延ばす。rt60 × 1.3 より短ければ結果は同じ） */
export function synthesizeHallIR(rt60: number, sampleRate: number, seed = 1, maxSeconds = MAX_IR_SECONDS): [Float32Array, Float32Array] {
  const length = Math.ceil(Math.min(rt60 * 1.3, maxSeconds) * sampleRate)
  const out: Float32Array[] = []
  for (let c = 0; c < 2; c++) {
    const rnd = prng(seed * 7919 + c * 104729)
    const x = new Float32Array(length)
    let lp = 0
    let a = 0
    let energy = 0
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate
      if ((i & 63) === 0) {
        // 高域減衰: カットオフ 10 kHz → RT60 の半分の時定数で低下（下限 1.2 kHz）
        const fc = Math.max(1200, 10000 * Math.exp(-t / (rt60 * 0.5)))
        a = Math.exp((-2 * Math.PI * fc) / sampleRate)
      }
      lp = (1 - a) * rnd() + a * lp
      const env = Math.exp((-6.907755 * t) / rt60) * (1 - Math.exp(-t / BUILD_UP_SECONDS))
      const v = lp * env
      x[i] = v
      energy += v * v
    }
    const g = energy > 0 ? 1 / Math.sqrt(energy) : 0
    for (let i = 0; i < length; i++) x[i] *= g
    out.push(x)
  }
  return [out[0], out[1]]
}
