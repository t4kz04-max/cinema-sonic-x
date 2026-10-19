import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AudioEngine } from '../audio/AudioEngine'
import { loadAudioFile } from '../audio/loadAudioFile'
import type { LoopRegion, LoopType } from '../audio/loopRegion'
import { DEFAULT_BASS_PARAMS, type BassParams } from '../audio/bassSpec'
import { DEFAULT_SPATIAL_PARAMS, type SpatialParams } from '../audio/spatial/spatialSpec'
import { cloneDsp, dspEquals, type DspConfig } from '../audio/dspConfig'
import { getPreset, matchPreset, presetToDsp, type PresetId } from '../audio/presets/spatialPresets'
import { deleteCustom, loadCustom, saveCustom, type SavedCustom } from '../utils/customPresetStorage'
import type { DspMeters, DspStatus, LoadError, LoadedAudio, PlaybackStatus } from '../types/audio'

/** 初期音量（%）。gain = (40/100)^2 = 0.16 ≒ -15.9 dB と控えめにする */
export const DEFAULT_VOLUME_PERCENT = 40

/** スライダー位置を聴感に近い二乗カーブで linear gain に変換する */
export function volumePercentToGain(percent: number): number {
  const v = Math.min(Math.max(percent, 0), 100) / 100
  return v * v
}

export interface LoopState {
  enabled: boolean
  type: LoopType
}

const INITIAL_LOOP: LoopState = { enabled: false, type: 'normal' }

/**
 * プリセットパネルの UI 状態（DSP 設定とは別に持つ）。
 * 最後にカードから適用した設定の出どころ。詳細設定を変えると DSP 設定がこれと一致しなくなり CUSTOM になる
 */
export type PresetSource = { kind: 'preset'; id: PresetId } | { kind: 'saved' } | null

export interface PresetState {
  source: PresetSource
  /** 現在の DSP 設定と完全に一致するプリセット */
  activeId: PresetId | null
  /** カードから適用した後に詳細設定を変えた状態 */
  custom: boolean
  /** 保存した CUSTOM と現在の設定が一致する */
  savedActive: boolean
  saved: SavedCustom | null
  /** 保存・読み込みの失敗メッセージ（再生には影響しない） */
  storageMessage: string | null
}

const NO_METERS: DspMeters = { bassGrDb: 0, limiterGrDb: 0, spatialLimiterGrDb: 0 }

export function useAudioPlayer() {
  const engineRef = useRef<AudioEngine | null>(null)
  const volumeRef = useRef(DEFAULT_VOLUME_PERCENT)
  const loadTokenRef = useRef(0)
  const bassParamsRef = useRef<BassParams>(DEFAULT_BASS_PARAMS)
  const spatialParamsRef = useRef<SpatialParams>(DEFAULT_SPATIAL_PARAMS)
  const loopRef = useRef<LoopState>(INITIAL_LOOP)

  const [audio, setAudio] = useState<LoadedAudio | null>(null)
  const [status, setStatus] = useState<PlaybackStatus>('stopped')
  const [position, setPosition] = useState(0)
  const [volume, setVolumeState] = useState(DEFAULT_VOLUME_PERCENT)
  const [loadingName, setLoadingName] = useState<string | null>(null)
  const [error, setError] = useState<LoadError | null>(null)
  const [bassParams, setBassParamsState] = useState<BassParams>(DEFAULT_BASS_PARAMS)
  const [bypass, setBypassState] = useState(false)
  const [bassEnabled, setBassEnabledState] = useState(false)
  const [spatialParams, setSpatialParamsState] = useState<SpatialParams>(DEFAULT_SPATIAL_PARAMS)
  const [dsp, setDsp] = useState<DspStatus | null>(null)
  const [meters, setMeters] = useState<DspMeters>(NO_METERS)
  const [loop, setLoopState] = useState<LoopState>(INITIAL_LOOP)
  const [musicRegion, setMusicRegion] = useState<LoopRegion | null>(null)
  const [presetSource, setPresetSource] = useState<PresetSource>(null)
  const [initialSaved] = useState(loadCustom)
  const [saved, setSaved] = useState<SavedCustom | null>(initialSaved.ok ? initialSaved.value : null)
  const [storageMessage, setStorageMessage] = useState<string | null>(initialSaved.ok ? null : initialSaved.message)

  const getEngine = useCallback((): AudioEngine => {
    if (!engineRef.current) {
      const engine = new AudioEngine(volumePercentToGain(volumeRef.current))
      engine.onStatusChange((s) => {
        setStatus(s)
        setPosition(engine.getPosition())
      })
      engine.onDspStatusChange(setDsp)
      engineRef.current = engine
    }
    return engineRef.current
  }, [])

  useEffect(() => {
    return () => {
      engineRef.current?.dispose()
      engineRef.current = null
    }
  }, [])

  // 再生中のみ毎フレーム位置を更新する
  useEffect(() => {
    if (status !== 'playing') return
    let id = 0
    const tick = () => {
      if (engineRef.current) {
        setPosition(engineRef.current.getPosition())
        setMeters(engineRef.current.getMeters())
      }
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(id)
      setMeters(NO_METERS)
    }
  }, [status])

  const loadFile = useCallback(
    async (file: File) => {
      const token = ++loadTokenRef.current
      setLoadingName(file.name)
      setError(null)
      const engine = getEngine()
      try {
        const result = await loadAudioFile(file, (data) => engine.decode(data))
        // 読み込み中に別ファイルが選ばれた場合は古い結果を捨てる
        if (token !== loadTokenRef.current) return
        if (!result.ok) {
          // 失敗時は直前の音源をそのまま保持する
          setError(result.error)
          return
        }
        engine.setBuffer(result.audio.buffer)
        setMusicRegion(engine.getMusicRegion())
        setAudio(result.audio)
        setPosition(0)
      } finally {
        if (token === loadTokenRef.current) setLoadingName(null)
      }
    },
    [getEngine],
  )

  const play = useCallback(async () => {
    try {
      await getEngine().play()
    } catch (e) {
      setError({
        kind: 'context',
        message: '再生を開始できませんでした。',
        detail: e instanceof Error ? e.message : String(e),
      })
    }
  }, [getEngine])

  const pause = useCallback(() => getEngine().pause(), [getEngine])
  const stop = useCallback(() => getEngine().stop(), [getEngine])
  const cut = useCallback(() => getEngine().cut(), [getEngine])

  const setLoop = useCallback(
    (patch: Partial<LoopState>) => {
      const next = { ...loopRef.current, ...patch }
      loopRef.current = next
      setLoopState(next)
      getEngine().setLoop(next.enabled, next.type)
    },
    [getEngine],
  )

  const togglePlay = useCallback(() => {
    if (status === 'playing') pause()
    else void play()
  }, [status, pause, play])

  const seek = useCallback(
    (seconds: number) => {
      const engine = getEngine()
      engine.seek(seconds)
      setPosition(engine.getPosition())
    },
    [getEngine],
  )

  const setVolume = useCallback(
    (percent: number) => {
      volumeRef.current = percent
      setVolumeState(percent)
      getEngine().setVolume(volumePercentToGain(percent))
    },
    [getEngine],
  )

  const clearError = useCallback(() => setError(null), [])

  const setBassParams = useCallback(
    (patch: Partial<BassParams>) => {
      const next = { ...bassParamsRef.current, ...patch }
      bassParamsRef.current = next
      setBassParamsState(next)
      getEngine().setBassParams(next)
    },
    [getEngine],
  )

  const setSpatialParams = useCallback(
    (patch: Partial<SpatialParams>) => {
      const next = { ...spatialParamsRef.current, ...patch }
      spatialParamsRef.current = next
      setSpatialParamsState(next)
      getEngine().setSpatialParams(next)
    },
    [getEngine],
  )

  const setBassEnabled = useCallback(
    (value: boolean) => {
      setBassEnabledState(value)
      getEngine().setBassEnabled(value)
    },
    [getEngine],
  )

  /** DSP 設定一式を適用する（プリセット・保存した CUSTOM）。元データはコピーして渡す */
  const applyDspConfig = useCallback(
    (config: DspConfig) => {
      const c = cloneDsp(config)
      spatialParamsRef.current = c.spatial
      bassParamsRef.current = c.bass
      setSpatialParamsState(c.spatial)
      setBassParamsState(c.bass)
      setBassEnabledState(c.bassEnabled)
      getEngine().applyDsp(c)
    },
    [getEngine],
  )

  const applyPreset = useCallback(
    (id: PresetId) => {
      applyDspConfig(presetToDsp(getPreset(id)))
      setPresetSource({ kind: 'preset', id })
    },
    [applyDspConfig],
  )

  const dspConfig = useMemo<DspConfig>(() => ({ spatial: spatialParams, bass: bassParams, bassEnabled }), [spatialParams, bassParams, bassEnabled])

  const applySavedCustom = useCallback(() => {
    if (!saved) return
    applyDspConfig(saved.dsp)
    setPresetSource({ kind: 'saved' })
  }, [applyDspConfig, saved])

  const saveCurrentCustom = useCallback(() => {
    const base = presetSource?.kind === 'preset' ? presetSource.id : presetSource?.kind === 'saved' ? (saved?.base?.id ?? null) : null
    const r = saveCustom(cloneDsp(dspConfig), base)
    if (r.ok) {
      setSaved(r.value)
      setStorageMessage(null)
      setPresetSource({ kind: 'saved' })
    } else setStorageMessage(r.message)
  }, [dspConfig, presetSource, saved])

  const deleteSavedCustom = useCallback(() => {
    const r = deleteCustom()
    if (r.ok) {
      setSaved(null)
      setStorageMessage(null)
      setPresetSource((s) => (s?.kind === 'saved' ? null : s))
    } else setStorageMessage(r.message)
  }, [])

  const presetState = useMemo<PresetState>(() => {
    const activeId = matchPreset(dspConfig)
    const savedActive = !!saved && dspEquals(saved.dsp, dspConfig)
    return { source: presetSource, activeId, custom: presetSource !== null && activeId === null && !savedActive, savedActive, saved, storageMessage }
  }, [dspConfig, presetSource, saved, storageMessage])

  const readMotion = useCallback(() => engineRef.current?.getMotionReport() ?? null, [])
  const readTail = useCallback(() => engineRef.current?.getTailReport() ?? null, [])

  const readScope = useCallback(
    (left: Float32Array<ArrayBuffer>, right: Float32Array<ArrayBuffer>) => engineRef.current?.readScope(left, right) ?? false,
    [],
  )

  const setBypass = useCallback(
    (value: boolean) => {
      setBypassState(value)
      getEngine().setBypass(value)
    },
    [getEngine],
  )

  return {
    audio,
    status,
    position,
    duration: audio?.buffer.duration ?? 0,
    volume,
    loadingName,
    error,
    contextSampleRate: audio?.buffer.sampleRate ?? null,
    loadFile,
    play,
    pause,
    stop,
    cut,
    loop,
    setLoop,
    musicRegion,
    togglePlay,
    seek,
    setVolume,
    clearError,
    bassParams,
    setBassParams,
    bypass,
    setBypass,
    bassEnabled,
    setBassEnabled,
    spatialParams,
    setSpatialParams,
    readScope,
    readMotion,
    readTail,
    dsp,
    meters,
    dspConfig,
    presetState,
    applyPreset,
    applySavedCustom,
    saveCurrentCustom,
    deleteSavedCustom,
  }
}

export type AudioPlayer = ReturnType<typeof useAudioPlayer>
