// 検証用の合成信号。純音だけでは実際の楽曲での挙動が分からないため、
// ピンクノイズ（楽曲の平均的なスペクトル傾斜）＋キック＋ベース＋声帯域を
// マスタリング相当（ソフトサチュレーションで -1 dBFS まで詰める）にした「楽曲相当」の信号を作る。

export const TEST_RATE = 48000

function prng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000 - 0.5
  }
}

/** Paul Kellet のピンクノイズフィルタ */
function pinkNoise(n: number, seed: number): Float32Array {
  const rnd = prng(seed)
  const out = new Float32Array(n)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
    b6 = w * 0.115926
  }
  return out
}

/** 1 次ハイパス（ピンクノイズの低域を減らして「低音の少ない曲」を作る） */
function onePoleHighpass(x: Float32Array, fc: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * fc) / TEST_RATE)
  const y = new Float32Array(x.length)
  let px = 0, py = 0
  for (let i = 0; i < x.length; i++) {
    py = a * (py + x[i] - px)
    px = x[i]
    y[i] = py
  }
  return y
}

interface MixSpec {
  seconds: number
  kick: number
  bass: number
  noise: number
  noiseHighpass: number
  voice: number
  /** マスタリング段のドライブ（大きいほど音圧が高い） */
  drive: number
  /**
   * ノイズ（楽器群）の左右独立成分の比率。省略時は左右完全に独立（非常に広いステレオ）。
   * 指定時は 共通成分 + width × 独立成分（一般的なミックスの部分的な相関）
   */
  noiseWidth?: number
  peak: number
}

function makeProgram(spec: MixSpec, seed: number): Float32Array[] {
  const n = Math.round(spec.seconds * TEST_RATE)
  const TAU = 2 * Math.PI
  let nl = pinkNoise(n, seed)
  let nr = pinkNoise(n, seed + 7)
  if (spec.noiseWidth !== undefined) {
    const shared = pinkNoise(n, seed + 99)
    const norm = 1 / Math.sqrt(1 + spec.noiseWidth * spec.noiseWidth)
    for (let i = 0; i < n; i++) {
      nl[i] = (shared[i] + spec.noiseWidth * nl[i]) * norm
      nr[i] = (shared[i] + spec.noiseWidth * nr[i]) * norm
    }
  }
  if (spec.noiseHighpass > 0) {
    nl = onePoleHighpass(onePoleHighpass(nl, spec.noiseHighpass), spec.noiseHighpass)
    nr = onePoleHighpass(onePoleHighpass(nr, spec.noiseHighpass), spec.noiseHighpass)
  }
  const notes = [41.2, 41.2, 55, 49]
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  let kickPhase = 0
  for (let i = 0; i < n; i++) {
    const t = i / TEST_RATE
    const beat = t % 0.5
    if (beat < 1 / TEST_RATE) kickPhase = 0
    const kf = 48 + 90 * Math.exp(-beat * 35)
    kickPhase += (TAU * kf) / TEST_RATE
    const kick = spec.kick * Math.exp(-beat * 7) * Math.sin(kickPhase)
    const f = notes[Math.floor(t / 2) % notes.length]
    const env = 0.65 + 0.35 * Math.exp(-(t % 0.25) * 5)
    const bass = spec.bass * env * (Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * 2 * f * t))
    const vf = 196 * (1 + 0.012 * Math.sin(TAU * 5.5 * t))
    let voice = 0
    for (let h = 1; h <= 16; h++) voice += (Math.sin(TAU * vf * h * t + h) / h) * (h >= 3 && h <= 8 ? 1.6 : 0.7)
    voice *= spec.voice * (0.6 + 0.4 * Math.sin(TAU * 0.4 * t) ** 2)
    const center = kick + bass
    L[i] = center + voice + spec.noise * nl[i]
    R[i] = center + 0.8 * voice + spec.noise * nr[i]
  }
  // マスタリング相当: tanh サチュレーションで音圧を上げ、指定ピークに正規化
  let peak = 0
  for (const ch of [L, R]) {
    for (let i = 0; i < n; i++) {
      ch[i] = Math.tanh(ch[i] * spec.drive)
      peak = Math.max(peak, Math.abs(ch[i]))
    }
  }
  const g = spec.peak / peak
  for (const ch of [L, R]) for (let i = 0; i < n; i++) ch[i] *= g
  return [L, R]
}

export function toBuffer(channels: Float32Array[]): AudioBuffer {
  const buf = new AudioBuffer({ length: channels[0].length, numberOfChannels: channels.length, sampleRate: TEST_RATE })
  channels.forEach((d, c) => buf.copyToChannel(d as Float32Array<ArrayBuffer>, c))
  return buf
}

const DBFS_M1 = Math.pow(10, -1 / 20)

/** EDM/ポップス相当: 低音多め・高音圧（ピーク -1 dBFS） */
export function programEdm(seconds = 12): AudioBuffer {
  return toBuffer(makeProgram({ seconds, kick: 0.55, bass: 0.28, noise: 0.5, noiseHighpass: 0, voice: 0.05, drive: 2.2, peak: DBFS_M1 }, 11))
}

/** 一般的なポップス相当: ピンクノイズに近いバランス・高音圧（ピーク -1 dBFS） */
export function programPop(seconds = 12): AudioBuffer {
  return toBuffer(makeProgram({ seconds, kick: 0.22, bass: 0.09, noise: 0.55, noiseHighpass: 60, voice: 0.09, drive: 2.0, peak: DBFS_M1 }, 17))
}

/** 一般的なステレオミックス相当: 楽器群の左右相関が部分的（中高域の S/M 比 約 -9 dB） */
export function programStereoMix(seconds = 10): AudioBuffer {
  return toBuffer(
    makeProgram({ seconds, kick: 0.22, bass: 0.09, noise: 0.55, noiseHighpass: 60, noiseWidth: 0.45, voice: 0.09, drive: 2.0, peak: DBFS_M1 }, 41),
  )
}

/** アコースティック相当: 低音が少なく、声・中高域主体（ピーク -1 dBFS） */
export function programAcoustic(seconds = 12): AudioBuffer {
  return toBuffer(makeProgram({ seconds, kick: 0.06, bass: 0.04, noise: 0.45, noiseHighpass: 180, voice: 0.08, drive: 1.2, peak: DBFS_M1 }, 23))
}

/** モノラルのポップス相当 */
export function programMono(seconds = 8): AudioBuffer {
  const [L] = makeProgram({ seconds, kick: 0.22, bass: 0.09, noise: 0.55, noiseHighpass: 60, voice: 0.09, drive: 2.0, peak: DBFS_M1 }, 31)
  return toBuffer([L])
}

export function silence(seconds = 4, channels = 2): AudioBuffer {
  return toBuffer(Array.from({ length: channels }, () => new Float32Array(Math.round(seconds * TEST_RATE))))
}
