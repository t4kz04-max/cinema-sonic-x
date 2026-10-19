// AudioWorklet: 整数サンプルの遅延（ORIGINAL/PROCESSED 比較の時刻合わせ）
//
//   input ──→ リングバッファ（delay サンプル遅らせる）──→ output
//
// BYPASS（ORIGINAL）経路を処理経路と同じ遅延にそろえ、切替で再生位置が飛ばないようにする。
// DelayNode は遅延時間が float32 の秒で、サンプル数に丸めると小数が残り補間されるため原音と一致しない。
// ここではサンプルをそのままコピーするので、遅延した原音とビット一致する。
// delay は k-rate の AudioParam（予約した時刻から切り替わる）。値が変わる瞬間は出力が飛ぶため、
// 呼び出し側は BYPASS 経路が無音（ゲイン 0）のときだけ変更する。

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: { processorOptions?: unknown })
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: unknown }) => AudioWorkletProcessor): void

/** 最大遅延（秒）。Motion の STFT 遅延 + HRTF 遅延 + 重低音の先読みより十分長く */
const MAX_DELAY_SECONDS = 0.25

class AlignProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'delay', defaultValue: 0, minValue: 0, maxValue: Math.round(MAX_DELAY_SECONDS * sampleRate), automationRate: 'k-rate' }]
  }

  private readonly size = Math.round(MAX_DELAY_SECONDS * sampleRate) + 256
  private buf: Float32Array[] = []
  private pos = 0

  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    const input = inputs[0]
    const output = outputs[0]
    const d = Math.min(Math.max(Math.round(params.delay[0]), 0), this.size - 129)
    const n = output[0].length
    const channels = output.length
    while (this.buf.length < channels) this.buf.push(new Float32Array(this.size))
    for (let c = 0; c < channels; c++) {
      // 入力が未接続・モノラルの場合は 0ch 目を使う（channelInterpretation 'speakers' の upmix と同じ）
      const x = input[c] ?? input[0]
      const b = this.buf[c]
      const y = output[c]
      let w = this.pos
      for (let i = 0; i < n; i++) {
        b[w] = x ? x[i] : 0
        let r = w - d
        if (r < 0) r += this.size
        y[i] = b[r]
        if (++w === this.size) w = 0
      }
    }
    this.pos = (this.pos + n) % this.size
    return true
  }
}

registerProcessor('csx-align', AlignProcessor)
