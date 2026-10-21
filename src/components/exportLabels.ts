import { getPreset } from '../audio/presets/spatialPresets'
import type { AudioPlayer } from '../hooks/useAudioPlayer'

// 書き出しの段階の表示名・設定の名前（SIMPLE / STUDIO で共通）

export type UiStage = 'preparing' | 'rendering' | 'encoding' | 'muxing'

export const STAGE_LABEL: Record<UiStage, string> = { preparing: 'PREPARING', rendering: 'RENDERING', encoding: 'ENCODING', muxing: 'MUXING' }

/** 段階の短い説明（SIMPLE MODE で表示） */
export const STAGE_HINT: Record<UiStage, string> = {
  preparing: '準備中（処理の設定・メモリを確認）',
  rendering: '音を加工中',
  encoding: 'ファイルに変換中',
  muxing: '動画に音声を書き込み中',
}

/** 現在の設定の名前（ファイル名・表示に使う） */
export function settingsLabel(player: AudioPlayer): string {
  const ps = player.presetState
  if (ps.activeId) return getPreset(ps.activeId).label
  if (ps.savedActive) return 'CUSTOM（保存）'
  if (ps.custom) return 'CUSTOM'
  return player.spatialParams.mode === 'off' && !player.bassEnabled ? 'ORIGINAL 相当（処理なし）' : '手動設定'
}

