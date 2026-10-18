import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioEngine } from '../audio/AudioEngine'
import { loadAudioFile } from '../audio/loadAudioFile'
import { DEFAULT_BASS_PARAMS, type BassParams } from '../audio/bassSpec'
import type { DspMeters, DspStatus, LoadError, LoadedAudio, PlaybackStatus } from '../types/audio'

/** 初期音量（%）。gain = (40/100)^2 = 0.16 ≒ -15.9 dB と控えめにする */
export const DEFAULT_VOLUME_PERCENT = 40

/** スライダー位置を聴感に近い二乗カーブで linear gain に変換する */
export function volumePercentToGain(percent: number): number {
  const v = Math.min(Math.max(percent, 0), 100) / 100
  return v * v
}

const NO_METERS: DspMeters = { bassGrDb: 0, limiterGrDb: 0 }

export function useAudioPlayer() {
  const engineRef = useRef<AudioEngine | null>(null)
  const volumeRef = useRef(DEFAULT_VOLUME_PERCENT)
  const loadTokenRef = useRef(0)
  const bassParamsRef = useRef<BassParams>(DEFAULT_BASS_PARAMS)

  const [audio, setAudio] = useState<LoadedAudio | null>(null)
  const [status, setStatus] = useState<PlaybackStatus>('stopped')
  const [position, setPosition] = useState(0)
  const [volume, setVolumeState] = useState(DEFAULT_VOLUME_PERCENT)
  const [loadingName, setLoadingName] = useState<string | null>(null)
  const [error, setError] = useState<LoadError | null>(null)
  const [bassParams, setBassParamsState] = useState<BassParams>(DEFAULT_BASS_PARAMS)
  const [bypass, setBypassState] = useState(false)
  const [dsp, setDsp] = useState<DspStatus | null>(null)
  const [meters, setMeters] = useState<DspMeters>(NO_METERS)

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
    togglePlay,
    seek,
    setVolume,
    clearError,
    bassParams,
    setBassParams,
    bypass,
    setBypass,
    dsp,
    meters,
  }
}

export type AudioPlayer = ReturnType<typeof useAudioPlayer>
