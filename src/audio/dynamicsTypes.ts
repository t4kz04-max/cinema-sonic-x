/** AudioWorklet（csx-bass-dynamics）の設定。メインスレッドとワークレットで共有する型 */
export interface DynamicsSettings {
  bassThresholdDb: number
  bassRatio: number
  bassKneeDb: number
  bassAttackMs: number
  bassReleaseMs: number
  trimDb: number
  ceilingDb: number
  lookaheadMs: number
  limiterReleaseMs: number
  /** false で計測用（リミッターなし、遅延のみ） */
  limiterEnabled: boolean
  /** メーター送信間隔。0 で送信しない（オフライン計測用） */
  reportIntervalMs: number
}

export interface DynamicsMeter {
  /** 直近区間の最大ゲインリダクション（dB, 正の値） */
  bassGrDb: number
  limiterGrDb: number
  /** 最終保護でクランプしたサンプル数（累計。0 であるべき） */
  clamped: number
}
