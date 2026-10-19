import type { Envelope, MotionControl, MotionLayout } from './motion'

/**
 * STFT サイズ・ホップ（レイヤー分解）。遅延 = MOTION_FFT_SIZE サンプル。
 * 50% オーバーラップ（√Hann² = Hann の和が 1）で完全再構成しつつ、FFT の計算量を 75% オーバーラップの半分にする
 */
export const MOTION_FFT_SIZE = 2048
export const MOTION_HOP = 1024
/** これより下の帯域は BED（固定）に送る（低域の不要な移動を防ぐ） */
export const MOTION_BED_LOW_HZ = 120
export const MOTION_BED_HIGH_HZ = 200

/**
 * 再生位置の基準。mediaTime(ctxTime) = playing ? ctxTime − startedAt : pausedAt
 * （startedAt = 再生開始時の ctx.currentTime − 開始位置）
 */
export interface MotionTransport {
  playing: boolean
  startedAt: number
  pausedAt: number
}

export interface MotionWorkletOptions {
  layout: MotionLayout
  control: MotionControl
  transport: MotionTransport
  envelope: Envelope | null
  /** 位置レポートの送信間隔（ms）。0 で送信しない */
  reportIntervalMs: number
  /** テスト用: 出力 1 を分解したレイヤー（7ch）にする */
  debugLayers?: boolean
}

export type MotionMessage =
  | { type: 'params'; layout: MotionLayout; control: MotionControl }
  | { type: 'transport'; transport: MotionTransport }
  | { type: 'envelope'; envelope: Envelope | null }

export interface MotionReport {
  /** このレポートの位置が対応するメディア時刻（出力中の音の時刻） */
  mediaTime: number
  /** [方位角, 距離] × 7 レイヤー（実際に DSP で使っている平滑化後の値） */
  positions: Float32Array
}
