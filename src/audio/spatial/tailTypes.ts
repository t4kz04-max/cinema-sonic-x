/** Dynamic Tail（csx-tail ワークレット）の設定 */
export interface TailDynamics {
  /** DYNAMIC TAIL ON: 演奏が密な間は残響の戻りを下げ、音の切れ目で設定レベルへ戻す */
  dynamic: boolean
  /** 演奏が密なときに下げる量（dB、正の値） */
  duckDb: number
  /** 残響が原音の平均レベル − この値（dB）を超えて蓄積したら抑える */
  guardMarginDb: number
}

export interface TailWorkletOptions extends TailDynamics {
  /** 状態の通知間隔（ms）。0 で送信しない */
  reportIntervalMs: number
}

export type TailMessage = { type: 'dynamics'; dynamics: TailDynamics }

export interface TailReport {
  /** Dynamic Tail による現在の減衰（dB、0 以下） */
  duckDb: number
  /** 蓄積防止による現在の減衰（dB、0 以下） */
  guardDb: number
}

/** 検出器の時定数（秒）。DSP と説明文で共有する */
export const TAIL_DETECTOR = {
  /** 短時間レベル（音の立ち上がり・切れ目の検出） */
  fastAttack: 0.005,
  fastRelease: 0.03,
  /** 曲の平均的なレベル（100 ms 平均パワーを上昇 0.4 秒・下降この秒数で追従。無音中は更新しない） */
  programTc: 2,
  /** 短時間レベルが平均よりこの dB 以上低いと「切れ目」 */
  gapBelowDb: 15,
  /** 「演奏中」と「切れ目」の間の遷移幅（dB） */
  rangeDb: 12,
  /** 次の音が始まったら素早く残響を下げる（直接音の明瞭さ） */
  attack: 0.025,
  /** 切れ目がこの時間続くまでは残響を戻さない（リズムの細かい隙間でポンピングさせない） */
  hold: 0.15,
  /** 残響を設定レベルへ戻す速さ（余韻が自然に広がる） */
  release: 0.25,
  /** ゲインの最終平滑化（ジッパーノイズ防止） */
  smoothing: 0.01,
  /** 蓄積防止の時定数 */
  guardAttack: 0.2,
  guardRelease: 1,
  /** これより小さい音は無音とみなし、平均レベルを更新しない（dBFS） */
  silenceDb: -70,
} as const
