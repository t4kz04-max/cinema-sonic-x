import { motionPeriodSeconds, type MotionPreset } from '../audio/spatial/motion'
import {
  cinemaSettings,
  hallSettings,
  isMotionActive,
  MODE_DOCS,
  MOTION_CAVEATS,
  MOTION_PARAM_DOCS,
  MOTION_PRESET_DOCS,
  MOTION_PROCESSING,
  motionSupported,
  wideSettings,
  type ActiveSpatialMode,
  type SpatialMode,
  type SpatialParamKey,
  type SpatialParams,
} from '../audio/spatial/spatialSpec'
import { STEREO_BANDS, type StereoMetrics } from '../audio/stereoMetrics'
import type { AudioPlayer } from '../hooks/useAudioPlayer'
import type { SpatialStatus } from '../types/audio'
import { Badge, Panel } from './Panel'
import { RangeControl } from './RangeControl'
import { SpatialVisualizer } from './SpatialVisualizer'
import { Vectorscope } from './Vectorscope'

interface SpatialPanelProps {
  player: AudioPlayer
}

const MODES: { id: SpatialMode; label: string }[] = [
  { id: 'off', label: 'OFF' },
  { id: 'wide', label: 'WIDE' },
  { id: 'cinema', label: 'CINEMA' },
  { id: 'hall', label: 'HALL' },
]

const PARAMS: { key: SpatialParamKey; label: string }[] = [
  { key: 'intensity', label: 'SPATIAL INTENSITY' },
  { key: 'roomSize', label: 'ROOM SIZE' },
  { key: 'depth', label: 'DEPTH' },
  { key: 'wetDry', label: 'WET / DRY' },
]

const signed = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`
const dbStr = (g: number) => (g > 0 ? `${signed(20 * Math.log10(g))} dB` : '−∞ dB')

/** 各モードでパラメーターが今どんな値になっているか */
function derived(mode: ActiveSpatialMode, p: SpatialParams, s: SpatialStatus): Record<SpatialParamKey, string> {
  const wet = `処理 ${p.wetDry}% / 原音 ${100 - p.wetDry}%`
  if (mode === 'wide') {
    const w = wideSettings(p, s.wideSideCapDb ?? undefined)
    return {
      intensity: `Side ${signed(w.sideHighGainDb)} dB（上限 ${s.wideSideCapDb !== null ? signed(s.wideSideCapDb) : '—'} dB）`,
      roomSize: `${w.ambienceDelaysMs[0].toFixed(0)} / ${w.ambienceDelaysMs[1].toFixed(0)} ms`,
      depth: `アンビエンス ${w.ambienceGain.toFixed(2)}`,
      wetDry: wet,
    }
  }
  if (mode === 'cinema') {
    const c = cinemaSettings(p)
    return {
      intensity: `±${c.speakerAngleDeg.toFixed(0)}°・反射 ${c.reflectionLevel.toFixed(2)}`,
      roomSize: `反射遅延 ×${c.roomScale.toFixed(2)}`,
      depth: `${c.distanceM.toFixed(1)} m（直接音 ${dbStr(c.directGain)}）`,
      wetDry: wet,
    }
  }
  const h = hallSettings(p)
  return {
    intensity: `初期反射 ${h.erGain.toFixed(2)}・残響 ${signed(h.lateGainDb)} dB`,
    roomSize: `RT60 ${h.rt60.toFixed(1)} 秒・プリディレイ ${h.preDelayMs.toFixed(0)} ms`,
    depth: `直接音 ${signed(h.directGainDb)} dB`,
    wetDry: wet,
  }
}

/** SPEED の現在値（基本周期）。PULSE では包絡の追従速度 */
function motionPeriodLabel(p: SpatialParams): string {
  return p.motionPreset === 'pulse' ? `追従 リリース ${(0.8 * Math.pow(0.15 / 0.8, p.motionSpeed / 100)).toFixed(2)} 秒` : `周期 ${motionPeriodSeconds(p.motionSpeed / 100).toFixed(1)} 秒`
}

const PRESETS: MotionPreset[] = ['cinematic', 'orbit', 'sweep', 'pulse']

const MOTION_SLIDERS: { key: 'motionSpeed' | 'motionDepth' | 'centerLock'; label: string }[] = [
  { key: 'motionSpeed', label: 'MOTION SPEED' },
  { key: 'motionDepth', label: 'MOTION DEPTH' },
  { key: 'centerLock', label: 'CENTER LOCK' },
]

function MotionBlock({ player }: SpatialPanelProps) {
  const { spatialParams: p, dsp, status } = player
  const supported = motionSupported(p.mode)
  const available = dsp?.spatial.motionAvailable ?? true
  const active = isMotionActive(p)
  const usable = supported && available
  return (
    <div className={`motion-block${active ? ' is-active' : ''}`}>
      <div className="motion-block__head">
        <div>
          <p className="motion-block__title">DYNAMIC SPATIAL MOTION</p>
          <p className="motion-block__sub">
            {!available
              ? 'このブラウザ環境では AudioWorklet が使えないため利用できません（https または localhost で開いてください）'
              : supported
                ? '中央を前方に保ち、左右・空間成分を独立して動かす（ヘッドホン推奨）'
                : 'Motion は CINEMA / HALL で使用できます'}
          </p>
        </div>
        <button
          type="button"
          className={`bypass-btn engine-btn${p.motionEnabled ? ' is-enabled' : ''}`}
          aria-pressed={p.motionEnabled}
          disabled={!usable}
          onClick={() => player.setSpatialParams({ motionEnabled: !p.motionEnabled })}
        >
          <span className="bypass-btn__led" aria-hidden="true" />
          <span className="bypass-btn__label">MOTION</span>
          <span className="bypass-btn__state">{p.motionEnabled ? 'ON' : 'OFF（既存の空間処理）'}</span>
        </button>
      </div>

      <div className="motion-presets" role="radiogroup" aria-label="MOTION PRESET">
        {PRESETS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={p.motionPreset === id}
            disabled={!usable}
            className={`spatial-mode motion-preset${p.motionPreset === id ? ' is-active' : ''}`}
            onClick={() => player.setSpatialParams({ motionPreset: id })}
          >
            <span className="spatial-mode__label">{MOTION_PRESET_DOCS[id].label}</span>
            <small>{MOTION_PRESET_DOCS[id].summary}</small>
          </button>
        ))}
      </div>

      <div className="motion-grid">
        <div className="motion-controls">
          {MOTION_SLIDERS.map(({ key, label }) => (
            <div className={`spatial-param${!usable || !p.motionEnabled ? ' is-disabled' : ''}`} key={key}>
              <div className="spatial-param__head">
                <label htmlFor={`mo-${key}`}>{label}</label>
                <span className="mono">{p[key]}%</span>
              </div>
              <RangeControl
                id={`mo-${key}`}
                min={0}
                max={100}
                step={1}
                value={p[key]}
                disabled={!usable}
                ariaLabel={label}
                onChange={(v) => player.setSpatialParams({ [key]: v } as Partial<SpatialParams>)}
              />
              <p className="spatial-param__desc">
                {MOTION_PARAM_DOCS[key]}
                {key === 'motionSpeed' && <span className="mono"> → {motionPeriodLabel(p)}</span>}
              </p>
            </div>
          ))}
          <p className="spatial-param__desc motion-preset-detail">
            <strong>{MOTION_PRESET_DOCS[p.motionPreset].label}:</strong> {MOTION_PRESET_DOCS[p.motionPreset].detail}
          </p>
        </div>
        <SpatialVisualizer params={p} readMotion={player.readMotion} playing={status === 'playing'} />
      </div>

      <div className="spatial-doc">
        <div>
          <p className="spatial-doc__title">Motion の処理内容</p>
          <ol>
            {MOTION_PROCESSING.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ol>
        </div>
        <div>
          <p className="spatial-doc__title">Motion の既知の制限</p>
          <ul>
            {MOTION_CAVEATS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

function MetricsTable({ before, after, status }: { before: StereoMetrics | null; after: StereoMetrics | null; status: SpatialStatus }) {
  const v = (m: StereoMetrics | null, f: (m: StereoMetrics) => number, d = 2, unit = '') =>
    m && Number.isFinite(f(m)) ? `${f(m).toFixed(d)}${unit}` : '—'
  const rows: [string, string, string, string?][] = [
    ['位相相関（全体）', v(before, (m) => m.correlation), v(after, (m) => m.correlation), '+1 同相 / 0 無相関 / −1 逆相'],
    ...STEREO_BANDS.map(
      (b) => [`位相相関 ${b.label}`, v(before, (m) => m.bandCorrelation[b.id]), v(after, (m) => m.bandCorrelation[b.id])] as [string, string, string],
    ),
    ...STEREO_BANDS.map(
      (b) =>
        [`ステレオ幅 S/M ${b.label}`, v(before, (m) => m.bandWidthDb[b.id], 1, ' dB'), v(after, (m) => m.bandWidthDb[b.id], 1, ' dB')] as [string, string, string],
    ),
    ['ラウドネス', v(before, (m) => m.loudnessLufs, 1, ' LUFS'), v(after, (m) => m.loudnessLufs, 1, ' LUFS'), '原音にそろえて比較'],
    ['モノラル和のラウドネス', v(before, (m) => m.monoLoudnessLufs, 1, ' LUFS'), v(after, (m) => m.monoLoudnessLufs, 1, ' LUFS'), 'モノラル互換性'],
    ['出力ピーク', v(before, (m) => m.peakDb, 2, ' dBFS'), v(after, (m) => m.peakDb, 2, ' dBFS')],
  ]
  return (
    <div className="metrics">
      <table className="metrics__table">
        <thead>
          <tr>
            <th />
            <th>ORIGINAL</th>
            <th>PROCESSED</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, b, a, note]) => (
            <tr key={label}>
              <th title={note}>{label}</th>
              <td className="mono">{b}</td>
              <td className="mono">{a}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="spec-list spec-list--compact">
        <div className="spec-list__row">
          <dt>音色の変化（両耳 / モノラル和）</dt>
          <dd className="mono">
            {status.stereoColorationDb !== null ? `${status.stereoColorationDb.toFixed(1)} / ${status.monoColorationDb?.toFixed(1)} dB` : '—'}
          </dd>
        </div>
        <div className="spec-list__row">
          <dt>ラウドネス合わせトリム</dt>
          <dd className="mono">{signed(status.trimDb)} dB</dd>
        </div>
      </dl>
      <p className="output-stage__note">
        曲の抜粋（最大 15 秒）を実際の空間処理グラフでオフライン処理して測定。音色の変化 = 125 Hz〜8 kHz の 1/3 オクターブで、全体の音量差を除いた最大のずれ。
      </p>
    </div>
  )
}

export function SpatialPanel({ player }: SpatialPanelProps) {
  const { spatialParams: p, dsp, bypass, status: playStatus } = player
  const s = dsp?.spatial ?? null
  const mode = p.mode
  const doc = mode === 'off' ? null : MODE_DOCS[mode]
  const values = mode !== 'off' && s ? derived(mode, p, s) : null
  const analysisLabel =
    s?.analysis === 'measuring' ? '測定中…' : s?.analysis === 'error' ? '測定失敗' : s?.analysis === 'silent' ? '無音' : null

  return (
    <Panel
      index="04"
      label="SPATIAL"
      title="空間音響プロトタイプ"
      className="panel--spatial"
      aside={
        <>
          {analysisLabel && <Badge tone="pending">{analysisLabel}</Badge>}
          {mode === 'off' ? <Badge tone="idle">OFF</Badge> : <Badge tone={bypass ? 'idle' : 'live'}>{bypass ? 'ORIGINAL 試聴中' : `${MODE_DOCS[mode].label} 処理中`}</Badge>}
        </>
      }
    >
      <div className="spatial-modes" role="radiogroup" aria-label="空間モード">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            className={`spatial-mode${mode === m.id ? ' is-active' : ''}`}
            onClick={() => player.setSpatialParams({ mode: m.id })}
          >
            <span className="spatial-mode__label">{m.label}</span>
            <small>{m.id === 'off' ? '空間処理なし' : MODE_DOCS[m.id].summary}</small>
          </button>
        ))}
      </div>

      {mode === 'cinema' && (
        <p className="notice">
          CINEMA はヘッドホン専用です。HRTF（頭部伝達関数）はブラウザ内蔵の汎用データのため、前方に定位するかどうかは人によって異なり、頭の中や後方に聞こえる場合があります。
        </p>
      )}

      <div className="spatial-grid">
        <div className="spatial-controls">
          {PARAMS.map(({ key, label }) => (
            <div className={`spatial-param${mode === 'off' ? ' is-disabled' : ''}`} key={key}>
              <div className="spatial-param__head">
                <label htmlFor={`sp-${key}`}>{label}</label>
                <span className="mono">{p[key]}%</span>
              </div>
              <RangeControl
                id={`sp-${key}`}
                min={0}
                max={100}
                step={1}
                value={p[key]}
                disabled={mode === 'off'}
                ariaLabel={label}
                ariaValueText={`${p[key]}%${values ? `（${values[key]}）` : ''}`}
                onChange={(v) => player.setSpatialParams({ [key]: v } as Partial<SpatialParams>)}
              />
              <p className="spatial-param__desc">
                {doc ? doc.params[key] : 'モードを選ぶと有効になります'}
                {values && <span className="mono"> → {values[key]}</span>}
              </p>
            </div>
          ))}
        </div>
        <div className="spatial-side">
          <Vectorscope read={player.readScope} active={playStatus === 'playing'} />
        </div>
      </div>

      <MotionBlock player={player} />

      {doc && (
        <div className="spatial-doc">
          <div>
            <p className="spatial-doc__title">処理内容（{doc.label}）</p>
            <ol>
              {doc.processing.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ol>
          </div>
          <div>
            <p className="spatial-doc__title">既知の制限</p>
            <ul>
              {doc.caveats.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {s && (mode !== 'off' || s.before) && <MetricsTable before={s.before} after={mode === 'off' ? null : s.after} status={s} />}
    </Panel>
  )
}
