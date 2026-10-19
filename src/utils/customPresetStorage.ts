// CUSTOM 設定のブラウザ内保存（localStorage）。音声データ・ファイル名は保存しない（DSP 設定の数値だけ）。
// localStorage はプライベートモード・容量超過・サイト データのブロックで例外を投げることがあるため、
// すべて try/catch で包み、失敗しても音声再生には影響させない（呼び出し側には失敗理由を返す）。

import { parseDspConfig, type DspConfig } from '../audio/dspConfig'
import { getPreset, isPresetId, type PresetId } from '../audio/presets/spatialPresets'

const STORAGE_KEY = 'cinema-sonic-x.custom-preset'
/** 保存形式の版（形式を変えたら上げ、古い版は読み込まない） */
export const CUSTOM_SCHEMA_VERSION = 1

export interface SavedCustom {
  dsp: DspConfig
  /** CUSTOM の元になったプリセットと、その版（null = プリセットを使わずに設定） */
  base: { id: PresetId; version: number } | null
  /** 保存日時（ISO 8601） */
  savedAt: string
}

export type StorageResult<T> = { ok: true; value: T } | { ok: false; message: string }

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function saveCustom(dsp: DspConfig, base: PresetId | null): StorageResult<SavedCustom> {
  const s = storage()
  if (!s) return { ok: false, message: 'このブラウザではブラウザ内保存が使えません（プライベートモード・サイトデータのブロックなど）。設定は保存されていませんが、再生には影響しません。' }
  const value: SavedCustom = { dsp, base: base ? { id: base, version: getPreset(base).version } : null, savedAt: new Date().toISOString() }
  try {
    s.setItem(STORAGE_KEY, JSON.stringify({ schema: CUSTOM_SCHEMA_VERSION, ...value }))
    return { ok: true, value }
  } catch (e) {
    return { ok: false, message: `保存できませんでした（${e instanceof Error ? e.name : '不明なエラー'}）。設定は保存されていませんが、再生には影響しません。` }
  }
}

/** 保存した CUSTOM を読む。保存なしは ok: true / value: null。壊れた・古い形式のデータは読み込まない */
export function loadCustom(): StorageResult<SavedCustom | null> {
  const s = storage()
  if (!s) return { ok: true, value: null }
  let raw: string | null
  try {
    raw = s.getItem(STORAGE_KEY)
  } catch {
    return { ok: false, message: '保存した CUSTOM 設定を読み込めませんでした（ブラウザ内保存にアクセスできません）。' }
  }
  if (raw === null) return { ok: true, value: null }
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    if (v.schema !== CUSTOM_SCHEMA_VERSION) return { ok: false, message: '保存した CUSTOM 設定の形式が古いため読み込みませんでした。' }
    const dsp = parseDspConfig(v.dsp)
    if (!dsp) return { ok: false, message: '保存した CUSTOM 設定が壊れているため読み込みませんでした。' }
    const b = v.base as { id?: unknown; version?: unknown } | null
    const base = b && isPresetId(b.id) && typeof b.version === 'number' ? { id: b.id, version: b.version } : null
    return { ok: true, value: { dsp, base, savedAt: typeof v.savedAt === 'string' ? v.savedAt : '' } }
  } catch {
    return { ok: false, message: '保存した CUSTOM 設定が壊れているため読み込みませんでした。' }
  }
}

export function deleteCustom(): StorageResult<null> {
  const s = storage()
  if (!s) return { ok: true, value: null }
  try {
    s.removeItem(STORAGE_KEY)
    return { ok: true, value: null }
  } catch {
    return { ok: false, message: '保存した CUSTOM 設定を削除できませんでした。' }
  }
}
