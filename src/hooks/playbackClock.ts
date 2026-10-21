import { useSyncExternalStore } from 'react'
import type { DspMeters } from '../types/audio'

/**
 * 再生位置とメーター（再生中は毎フレーム変わる値）。
 * React の状態にすると毎フレーム画面全体（すべてのパネル）が再描画されるため、別の小さなストアに置き、
 * 必要な部品（時刻・シークバー・メーター）だけが購読する（Phase 08: UI の CPU 負荷を増やさない）
 */
export interface PlaybackClockValue {
  position: number
  meters: DspMeters
}

export interface PlaybackClock {
  get: () => PlaybackClockValue
  set: (patch: Partial<PlaybackClockValue>) => void
  subscribe: (listener: () => void) => () => void
}

export const NO_METERS: DspMeters = { bassGrDb: 0, limiterGrDb: 0, spatialLimiterGrDb: 0 }

export function createPlaybackClock(): PlaybackClock {
  let value: PlaybackClockValue = { position: 0, meters: NO_METERS }
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (patch) => {
      const next = { ...value, ...patch }
      // 変わらない値では通知しない（停止中の重複した更新で再描画しない）
      if (next.position === value.position && next.meters === value.meters) return
      value = next
      for (const l of listeners) l()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** 再生位置・メーターを購読する（この部品だけが毎フレーム再描画される） */
export function usePlaybackClock(clock: PlaybackClock): PlaybackClockValue {
  return useSyncExternalStore(clock.subscribe, clock.get)
}
