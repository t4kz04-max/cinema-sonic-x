import { MODE_SPECS, paramsToGains, type BassMode, type CompensationMode } from '../audio/bassSpec'
import type { AudioPlayer } from '../hooks/useAudioPlayer'
import { formatDb } from '../utils/format'
import { EqCurve } from './EqCurve'
import { OutputStage } from './OutputStage'
import { Badge, Panel } from './Panel'
import { RangeControl } from './RangeControl'

interface EnhancementPanelProps {
  player: AudioPlayer
}

interface ModuleProps {
  id: string
  name: string
  subtitle: string
  tone: 'bass' | 'sub'
  value: number
  details: string[]
  description: string
  onChange: (value: number) => void
}

function ActiveModule({ id, name, subtitle, tone, value, details, description, onChange }: ModuleProps) {
  return (
    <div className={`module module--${tone}`}>
      <div className="module__head">
        <div>
          <label className="module__name" htmlFor={id}>
            {name}
          </label>
          <p className="module__subtitle">{subtitle}</p>
        </div>
        <span className="module__readout mono">{value}%</span>
      </div>
      <div className="module__control">
        <RangeControl
          id={id}
          className={`range--${tone}`}
          min={0}
          max={100}
          step={1}
          value={value}
          ariaLabel={name}
          ariaValueText={`${value}%（${details.join('、')}）`}
          onChange={onChange}
        />
      </div>
      <ul className="module__details mono">
        {details.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
      <p className="module__desc">{description}</p>
    </div>
  )
}

const MODES: { id: BassMode; label: string; note: string }[] = [
  { id: 'normal', label: 'NORMAL', note: '自然な低音強化' },
  { id: 'extreme', label: 'EXTREME', note: '低域EQ 最大 +24 dB 程度' },
]

const COMPENSATIONS: { id: CompensationMode; label: string }[] = [
  { id: 'mid-anchor', label: '中高域を維持（推奨）' },
  { id: 'loudness-match', label: 'ラウドネス一致（A/B比較用）' },
]

export function EnhancementPanel({ player }: EnhancementPanelProps) {
  const { bassParams, dsp, meters, bassEnabled } = player
  // 重低音エンジンが OFF、または全体が ORIGINAL のときは処理されない
  const bypass = player.bypass || !bassEnabled
  const spec = MODE_SPECS[bassParams.mode]
  const scale = (dsp?.capScale ?? 1) * (dsp?.safetyScale ?? 1)
  const gains = paramsToGains(bassParams, scale)
  const extreme = bassParams.mode === 'extreme'

  return (
    <Panel
      index="06"
      label="ENHANCE"
      title="重低音エンジン"
      className={`panel--enhance${extreme ? ' is-extreme' : ''}`}
      aside={!bassEnabled ? <Badge tone="idle">ENGINE OFF</Badge> : bypass ? <Badge tone="idle">ORIGINAL 試聴中</Badge> : <Badge tone="live">処理ON・{spec.label}</Badge>}
    >
      <div className="enhance-top">
        <button
          type="button"
          className={`bypass-btn engine-btn${bassEnabled ? ' is-enabled' : ''}`}
          aria-pressed={bassEnabled}
          onClick={() => player.setBassEnabled(!bassEnabled)}
          title="重低音エンジンの ON/OFF（空間音響とは独立）"
        >
          <span className="bypass-btn__led" aria-hidden="true" />
          <span className="bypass-btn__label">ENGINE</span>
          <span className="bypass-btn__state">{bassEnabled ? 'ON（処理に含める）' : 'OFF（通過のみ）'}</span>
        </button>

        <div className="mode-switch" role="radiogroup" aria-label="処理モード">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={bassParams.mode === m.id}
              className={`mode-switch__item mode-switch__item--${m.id}${bassParams.mode === m.id ? ' is-active' : ''}`}
              onClick={() => player.setBassParams({ mode: m.id })}
            >
              <span>{m.label}</span>
              <small>{m.note}</small>
            </button>
          ))}
        </div>

        <label className="comp-select">
          <span>出力補正</span>
          <select
            value={bassParams.compensation}
            onChange={(e) => player.setBassParams({ compensation: e.target.value as CompensationMode })}
          >
            {COMPENSATIONS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {extreme && (
        <p className="notice notice--extreme">
          EXTREME: 低域EQを最大 +{spec.eqCapDb} dB 程度まで使います（出力音量が +{spec.eqCapDb} dB 上がるわけではありません）。
          ピークは低域コンプとリミッターで -1 dBFS 以下に抑えますが、低音の量が大きく変わるため、モニター音量を控えめにしてから試聴してください。
        </p>
      )}

      <div className="modules">
        <ActiveModule
          id="bass-boost"
          name="BASS BOOST"
          subtitle="低音EQ — 量感・パンチ"
          tone="bass"
          value={bassParams.bass}
          details={[
            `LOW SHELF ${spec.shelf.frequency} Hz ${formatDb(gains.shelfDb)}`,
            `PEAK ${spec.punch.frequency} Hz ${formatDb(gains.punchDb)}`,
          ]}
          description={`${spec.shelf.frequency} Hz 以下を広く持ち上げ、${spec.punch.frequency} Hz 付近のキックやベースの芯を強調します。ヘッドホンや小型スピーカーでも聞こえやすい帯域です。`}
          onChange={(v) => player.setBassParams({ bass: v })}
        />
        <ActiveModule
          id="sub-bass"
          name="SUB BASS"
          subtitle="超低域EQ — 沈み込み"
          tone="sub"
          value={bassParams.sub}
          details={[`PEAK ${spec.sub.frequency} Hz ${formatDb(gains.subDb)}`, `HPF ${spec.subsonicHz} Hz 4次（常時）`]}
          description={`${spec.sub.frequency} Hz 付近の狭い帯域を持ち上げ、体で感じる超低域を足します。小型スピーカーでは再生できない場合があります。`}
          onChange={(v) => player.setBassParams({ sub: v })}
        />
        <div className="module is-locked">
          <div className="module__head">
            <div>
              <p className="module__name">HARMONICS</p>
              <p className="module__subtitle">倍音生成</p>
            </div>
            <Badge tone="locked">未実装 · Phase 03</Badge>
          </div>
          <div className="module__control">
            <RangeControl id="harmonics" min={0} max={100} step={1} value={0} disabled ariaLabel="HARMONICS（未実装）" ariaValueText="未実装" />
          </div>
          <p className="module__desc">
            低域から2次・3次倍音を生成し、小型スピーカーでも低音の存在感を出す予定です。現在は音声処理に接続されていません。
          </p>
        </div>
      </div>

      <div className="enhance-bottom">
        <EqCurve params={bassParams} scale={scale} trimDb={dsp?.trimDb ?? 0} bypass={bypass} />
        <OutputStage dsp={dsp} meters={meters} mode={bassParams.mode} bypass={bypass} />
      </div>
    </Panel>
  )
}
