// ORIGINAL/PROCESSED 比較の時刻合わせ（BYPASS 経路を処理経路と同じだけ遅らせる整数サンプル遅延）。
// 重低音・空間の両グラフが使う。AudioWorklet が使えない環境では作らない（時刻合わせなし = 従来どおり）。

import alignWorkletUrl from './worklets/align.worklet.ts?worker&url'

const alignLoads = new WeakMap<BaseAudioContext, Promise<boolean>>()
const alignReady = new WeakSet<BaseAudioContext>()

/** 時刻合わせ用の AudioWorklet を読み込む。非対応なら false */
export function loadAlignWorklet(ctx: BaseAudioContext): Promise<boolean> {
  let p = alignLoads.get(ctx)
  if (!p) {
    p =
      typeof AudioWorkletNode === 'undefined' || !ctx.audioWorklet
        ? Promise.resolve(false)
        : ctx.audioWorklet.addModule(alignWorkletUrl).then(
            () => {
              alignReady.add(ctx)
              return true
            },
            () => false,
          )
    alignLoads.set(ctx, p)
  }
  return p
}

export interface AlignDelay {
  node: AudioNode
  /** 現在有効な遅延（サンプル） */
  readonly frames: number
  /** 時刻 at から遅延を seconds（サンプルに丸める）にする（未適用の予約は取り消す）。BYPASS 経路が無音のときだけ呼ぶこと */
  setDelay(seconds: number, at: number): void
  /** 未適用の予約を取り消し、今の遅延を保つ（BYPASS 経路が鳴り始めるとき） */
  cancelPending(): void
}

/** 整数サンプル遅延を作る。loadAlignWorklet が済んでいない文脈では null */
export function createAlignDelay(ctx: BaseAudioContext, seconds: number): AlignDelay | null {
  if (!alignReady.has(ctx)) return null
  const toFrames = (s: number) => Math.max(0, Math.round(s * ctx.sampleRate))
  let active = toFrames(seconds)
  let pending: { frames: number; at: number } | null = null
  // 出力は常に 2ch（入力が無音・切断で 0〜1ch になっても、遅延線に残っている音を最後まで出す。
  // 出力のチャンネル数が入力に追従すると、音源の終わりで右チャンネルの残り（遅延分）が失われていた）
  const node = new AudioWorkletNode(ctx, 'csx-align', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    parameterData: { delay: active },
  })
  const param = node.parameters.get('delay')!
  /** 予約時刻を過ぎた予約を「有効」に移す */
  const settle = () => {
    if (pending && ctx.currentTime >= pending.at) {
      active = pending.frames
      pending = null
    }
  }
  const cancelPending = () => {
    settle()
    if (!pending) return
    param.cancelScheduledValues(ctx.currentTime)
    pending = null
  }
  return {
    node,
    get frames() {
      settle()
      return active
    },
    setDelay(s, at) {
      cancelPending()
      const f = toFrames(s)
      if (f === active) return
      const t = Math.max(at, ctx.currentTime)
      param.setValueAtTime(f, t)
      pending = { frames: f, at: t }
    },
    cancelPending,
  }
}
