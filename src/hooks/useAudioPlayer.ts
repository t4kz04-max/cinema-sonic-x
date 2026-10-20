import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AudioEngine } from '../audio/AudioEngine'
import { loadAudioFile } from '../audio/loadAudioFile'
import type { LoopRegion, LoopType } from '../audio/loopRegion'
import { DEFAULT_BASS_PARAMS, type BassParams } from '../audio/bassSpec'
import { DEFAULT_SPATIAL_PARAMS, type SpatialParams } from '../audio/spatial/spatialSpec'
import { cloneDsp, dspEquals, type DspConfig } from '../audio/dspConfig'
import { getPreset, matchPreset, presetToDsp, type PresetId } from '../audio/presets/spatialPresets'
import { deleteCustom, loadCustom, saveCustom, type SavedCustom } from '../utils/customPresetStorage'
import { estimateExportBytes, EXPORT_MAX_SECONDS, exportMemoryBudget, type ExportProgress, type ExportResult } from '../audio/export/exportSpec'
import { ExportCancelledError, ExportTimeoutError, pendingRetainedBytes, retainedReleaseWaitMs, startExport, type ExportJob } from '../audio/export/exportRunner'
import type { WavBitDepth } from '../audio/export/wavEncoder'
import { formatBytes } from '../utils/format'
import type { VideoExportResult, VideoJob, VideoJobProgress } from '../video/videoExport'
import { encodeWav } from '../audio/export/wavEncoder'
import { estimateVideoExportBytes, EXT_OF, VideoCancelledError, VideoTimeoutError, type VideoTailMode } from '../video/videoSpec'
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

export type ExportState =
  | { state: 'idle' }
  | { state: 'running'; progress: ExportProgress }
  | { state: 'complete'; result: ExportResult; url: string; fileName: string; settingsLabel: string }
  | { state: 'cancelled' }
  | { state: 'error'; message: string; detail?: string }

/** ファイル名に使えない文字を除く */
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 80)

/**
 * 直前の書き出しでブラウザがまだ持っているメモリ（exportRunner.pendingRetainedBytes）を足しても上限を超えないか。
 * 超える場合は、戻るまでの目安の時間を示して止める（続けて書き出したときにメモリが積み上がるのを防ぐ）
 */
function checkRetainedMemory(need: number, budget: number): void {
  const retained = pendingRetainedBytes()
  if (need + retained <= budget) return
  const wait = Math.ceil(retainedReleaseWaitMs() / 1000)
  throw new RangeError(
    `直前の書き出しのメモリ（見積もり ${formatBytes(retained)}）がまだブラウザに残っているため、続けて書き出すと上限（${formatBytes(budget)}）を超えます。約 ${wait} 秒待ってから、もう一度書き出してください。`,
  )
}

/** 動画の処理（Phase 07）の状態 */
export type VideoExportState =
  | { state: 'idle' }
  | { state: 'running'; kind: 'original-wav' | 'video'; progress: VideoJobProgress }
  | { state: 'complete'; kind: 'original-wav'; url: string; fileName: string; bytes: number; seconds: number }
  | { state: 'complete'; kind: 'video'; url: string; fileName: string; result: VideoExportResult; settingsLabel: string }
  | { state: 'cancelled' }
  | { state: 'error'; message: string; detail?: string }

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
  const [exportState, setExportState] = useState<ExportState>({ state: 'idle' })
  const exportJobRef = useRef<ExportJob | null>(null)
  const exportUrlRef = useRef<string | null>(null)
  /** 元のファイルのプレビュー用 Object URL（音源を読み込むたびに作り直し、前のものは解放する） */
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const originalUrlRef = useRef<string | null>(null)
  const exportRunningRef = useRef(false)
  /** 準備中（フレームを作る前）のキャンセル要求 */
  const exportCancelRef = useRef(false)
  const [videoState, setVideoState] = useState<VideoExportState>({ state: 'idle' })
  const videoJobRef = useRef<VideoJob<VideoExportResult> | null>(null)
  const videoUrlRef = useRef<string | null>(null)
  const videoCancelRef = useRef(false)

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

  /** 書き出し結果を破棄する（Object URL を解放し、実行中ならキャンセル） */
  const resetExport = useCallback(() => {
    exportJobRef.current?.cancel()
    exportJobRef.current = null
    if (exportUrlRef.current) URL.revokeObjectURL(exportUrlRef.current)
    exportUrlRef.current = null
    setExportState({ state: 'idle' })
    videoCancelRef.current = true
    videoJobRef.current?.cancel()
    videoJobRef.current = null
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current)
    videoUrlRef.current = null
    setVideoState({ state: 'idle' })
  }, [])

  useEffect(
    () => () => {
      exportJobRef.current?.cancel()
      if (exportUrlRef.current) URL.revokeObjectURL(exportUrlRef.current)
      if (originalUrlRef.current) URL.revokeObjectURL(originalUrlRef.current)
      videoJobRef.current?.cancel()
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current)
      exportUrlRef.current = null
      originalUrlRef.current = null
      videoUrlRef.current = null
    },
    [],
  )

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
        resetExport()
        if (originalUrlRef.current) URL.revokeObjectURL(originalUrlRef.current)
        originalUrlRef.current = URL.createObjectURL(result.audio.file)
        setOriginalUrl(originalUrlRef.current)
        engine.setBuffer(result.audio.buffer)
        setMusicRegion(engine.getMusicRegion())
        setAudio(result.audio)
        setPosition(0)
      } finally {
        if (token === loadTokenRef.current) setLoadingName(null)
      }
    },
    [getEngine, resetExport],
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

  /**
   * 書き出し: 再生と同じ設定・処理計画で、音源全体 + 余韻をオフラインレンダリングして WAV にする。
   * 実行中は二重に実行しない。完了したときだけ結果（Object URL）を作る
   */
  const exportWav = useCallback(
    async (bitDepth: WavBitDepth, settingsLabel: string) => {
      const engine = engineRef.current
      if (!engine || !audio || exportRunningRef.current) return
      exportRunningRef.current = true
      exportCancelRef.current = false
      const checkCancel = () => {
        if (exportCancelRef.current) throw new ExportCancelledError()
      }
      if (exportUrlRef.current) URL.revokeObjectURL(exportUrlRef.current)
      exportUrlRef.current = null
      setExportState({ state: 'running', progress: { stage: 'preparing' } })
      try {
        const snap = await engine.exportSnapshot()
        checkCancel()
        // 元のサンプルレートで書き出す（AudioContext のレートと違う場合は、元のファイルをそのレートでデコードし直す）
        let source = audio.buffer
        const native = audio.header.sampleRate
        if (native && native !== source.sampleRate && native >= 8000 && native <= 384000) {
          const ctx = new OfflineAudioContext(1, 1, native)
          source = await ctx.decodeAudioData(await audio.file.arrayBuffer())
        }
        if (source.duration > EXPORT_MAX_SECONDS) throw new RangeError(`書き出せる長さは ${EXPORT_MAX_SECONDS / 60} 分までです（音源 ${(source.duration / 60).toFixed(1)} 分）。`)
        const need = estimateExportBytes(source.length, source.numberOfChannels, source.sampleRate, snap.dsp.spatial, bitDepth)
        const budget = exportMemoryBudget((navigator as Navigator & { deviceMemory?: number }).deviceMemory)
        if (need > budget) throw new RangeError(`書き出しに必要なメモリの見積もり（${formatBytes(need)}）が上限（${formatBytes(budget)}）を超えます。短い音源で書き出してください。`)
        checkRetainedMemory(need, budget)
        checkCancel()
        const channels = Array.from({ length: source.numberOfChannels }, (_, c) => source.getChannelData(c).slice())
        engine.holdAnalysis(true)
        await engine.suspendForExport()
        checkCancel()
        const job = startExport(
          { channels, sampleRate: source.sampleRate, ...snap, bitDepth, ditherSeed: 1 },
          (progress) => setExportState({ state: 'running', progress }),
        )
        exportJobRef.current = job
        const result = await job.promise
        const url = URL.createObjectURL(result.blob)
        exportUrlRef.current = url
        const base = audio.fileName.replace(/\.[^.]+$/, '')
        setExportState({ state: 'complete', result, url, fileName: `${safeName(base)}_${safeName(settingsLabel)}_${result.bitDepth}bit.wav`, settingsLabel })
      } catch (e) {
        if (e instanceof ExportCancelledError) setExportState({ state: 'cancelled' })
        else {
          const memory = e instanceof RangeError || /memory|allocation/i.test(String(e))
          setExportState({
            state: 'error',
            message: e instanceof ExportTimeoutError ? '書き出しが途中で止まったため中止しました。もう一度書き出してください。' : memory ? 'メモリが足りないため書き出せませんでした。' : '書き出しに失敗しました。',
            detail: e instanceof Error ? e.message : String(e),
          })
        }
      } finally {
        exportJobRef.current = null
        exportRunningRef.current = false
        engineRef.current?.holdAnalysis(false)
        void engineRef.current?.resumeAfterExport()
      }
    },
    [audio],
  )

  /** 動画: 元の音声（処理なし）を WAV に */
  const exportOriginalVideoAudio = useCallback(
    async (bitDepth: WavBitDepth) => {
      if (!audio?.video || exportRunningRef.current) return
      exportRunningRef.current = true
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current)
      videoUrlRef.current = null
      setVideoState({ state: 'running', kind: 'original-wav', progress: { stage: 'encoding' } })
      try {
        // 表示を更新させてから変換する
        await new Promise((r) => setTimeout(r, 0))
        const channels = Array.from({ length: audio.buffer.numberOfChannels }, (_, c) => audio.buffer.getChannelData(c))
        // 元の音声（処理なし）。モノラルはステレオにする（書き出しはすべてステレオ）
        const blob = encodeWav(channels.length === 1 ? [channels[0], channels[0]] : channels.slice(0, 2), { sampleRate: audio.buffer.sampleRate, bitDepth, seed: 1 }).blob
        const url = URL.createObjectURL(blob)
        videoUrlRef.current = url
        const base = audio.fileName.replace(/\.[^.]+$/, '')
        setVideoState({ state: 'complete', kind: 'original-wav', url, fileName: `${safeName(base)}_ORIGINAL_AUDIO_${bitDepth}bit.wav`, bytes: blob.size, seconds: audio.buffer.duration })
      } catch (e) {
        setVideoState({ state: 'error', message: '音声の書き出しに失敗しました。', detail: e instanceof Error ? e.message : String(e) })
      } finally {
        exportRunningRef.current = false
      }
    },
    [audio],
  )

  /** 動画: 立体音響化した音声に差し替えた動画を作る（映像はコピー） */
  const exportSpatialVideo = useCallback(
    async (tailMode: VideoTailMode, settingsLabel: string) => {
      const engine = engineRef.current
      if (!engine || !audio?.video || exportRunningRef.current) return
      exportRunningRef.current = true
      videoCancelRef.current = false
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current)
      videoUrlRef.current = null
      setVideoState({ state: 'running', kind: 'video', progress: { stage: 'preparing' } })
      try {
        const snap = await engine.exportSnapshot()
        if (videoCancelRef.current) throw new VideoCancelledError()
        const info = audio.video.info
        const need = estimateVideoExportBytes(info, { frames: audio.buffer.length, channels: audio.buffer.numberOfChannels, sampleRate: audio.buffer.sampleRate }, snap.dsp.spatial)
        const budget = exportMemoryBudget((navigator as Navigator & { deviceMemory?: number }).deviceMemory)
        if (need > budget) throw new RangeError(`動画の書き出しに必要なメモリの見積もり（${formatBytes(need)}）が上限（${formatBytes(budget)}）を超えます。短い・小さい動画で書き出してください。`)
        checkRetainedMemory(need, budget)
        const { canEncodeAudio, startVideoExport } = await import('../video/videoExport')
        const aacAvailable = await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: audio.buffer.sampleRate })
        engine.holdAnalysis(true)
        await engine.suspendForExport()
        if (videoCancelRef.current) throw new VideoCancelledError()
        const channels = Array.from({ length: audio.buffer.numberOfChannels }, (_, c) => audio.buffer.getChannelData(c))
        const job = startVideoExport(audio.file, info, { channels, sampleRate: audio.buffer.sampleRate, startTime: audio.video.audioStart }, snap, {
          tailMode,
          aacAvailable,
          onProgress: (progress) => setVideoState({ state: 'running', kind: 'video', progress }),
        })
        videoJobRef.current = job
        const result = await job.promise
        const url = URL.createObjectURL(result.blob)
        videoUrlRef.current = url
        const base = audio.fileName.replace(/\.[^.]+$/, '')
        setVideoState({ state: 'complete', kind: 'video', url, fileName: `${safeName(base)}_${safeName(settingsLabel)}.${EXT_OF[info.container]}`, result, settingsLabel })
      } catch (e) {
        if (e instanceof VideoCancelledError || e instanceof ExportCancelledError) setVideoState({ state: 'cancelled' })
        else {
          const memory = e instanceof RangeError || /memory|allocation/i.test(String(e))
          const stalled = e instanceof ExportTimeoutError || e instanceof VideoTimeoutError
          setVideoState({
            state: 'error',
            message: stalled ? '動画の書き出しが途中で止まったため中止しました。もう一度書き出してください。' : memory ? 'メモリが足りないため動画を書き出せませんでした。' : '動画の書き出しに失敗しました。',
            detail: e instanceof Error ? e.message : String(e),
          })
        }
      } finally {
        videoJobRef.current = null
        exportRunningRef.current = false
        engineRef.current?.holdAnalysis(false)
        void engineRef.current?.resumeAfterExport()
      }
    },
    [audio],
  )

  const cancelVideo = useCallback(() => {
    videoCancelRef.current = true
    videoJobRef.current?.cancel()
  }, [])

  const cancelExport = useCallback(() => {
    exportCancelRef.current = true
    exportJobRef.current?.cancel()
  }, [])

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
    exportState,
    videoState,
    exportOriginalVideoAudio,
    exportSpatialVideo,
    cancelVideo,
    originalUrl,
    exportWav,
    cancelExport,
    resetExport,
  }
}

export type AudioPlayer = ReturnType<typeof useAudioPlayer>
