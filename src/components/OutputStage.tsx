import { MODE_SPECS, type BassMode } from '../audio/bassSpec'
import type { DspMeters, DspStatus } from '../types/audio'
import { formatDb } from '../utils/format'

interface OutputStageProps {
  dsp: DspStatus | null
  meters: DspMeters
  mode: BassMode
  bypass: boolean
}

const GR_METER_RANGE_DB = 12

const ANALYSIS_LABEL: Record<DspStatus['analysis'], string> = {
  idle: '音源未読み込み',
  measuring: '計測中…',
  ready: '適用中',
  silent: '無音のため補正なし',
  error: '計測失敗（直前の値を維持）',
  standby: '重低音 OFF（ON にすると計測）',
}

const TRIM_REASON: Record<DspStatus['trimReason'], string> = {
  none: '不要',
  peak: 'ピーク予算のため',
  loudness: 'ラウドネス上限のため',
}

const fmt = (v: number | null, unit: string, digits = 1) =>
  v === null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)} ${unit}`

function GrMeter({ label, valueDb, budgetDb }: { label: string; valueDb: number; budgetDb?: number }) {
  const ratio = Math.min(valueDb / GR_METER_RANGE_DB, 1)
  return (
    <div className="gr-row">
      <span className="gr-row__label">{label}</span>
      <div className="gr-meter" role="meter" aria-label={`${label} ゲインリダクション`} aria-valuemin={0} aria-valuemax={GR_METER_RANGE_DB} aria-valuenow={Number(valueDb.toFixed(1))}>
        <span style={{ width: `${ratio * 100}%` }} />
        {budgetDb !== undefined && <i style={{ left: `${(budgetDb / GR_METER_RANGE_DB) * 100}%` }} title={`予算 ${budgetDb} dB`} />}
      </div>
      <span className="gr-row__value mono">{valueDb > 0.05 ? `-${valueDb.toFixed(1)}` : '0.0'} dB</span>
    </div>
  )
}

export function OutputStage({ dsp, meters, mode, bypass }: OutputStageProps) {
  const spec = MODE_SPECS[mode]
  const status = dsp?.analysis ?? 'idle'
  const scale = (dsp?.capScale ?? 1) * (dsp?.safetyScale ?? 1)
  const safetyLimited = (dsp?.safetyScale ?? 1) < 0.995
  const fallback = dsp?.dynamicsEngine === 'fallback'

  return (
    <div className={`output-stage${bypass ? ' is-bypassed' : ''}`}>
      <div className="output-stage__block">
        <div className="output-stage__head">
          <span className="output-stage__title">ゲイン構造</span>
          <span className={`output-stage__status is-${status}`}>{ANALYSIS_LABEL[status]}</span>
        </div>
        <dl className="spec-list spec-list--compact">
          <div className="spec-list__row">
            <dt>全帯域トリム</dt>
            <dd>
              <span className="mono">{formatDb(dsp?.trimDb ?? 0)}</span>
              <span className="spec-list__note">{TRIM_REASON[dsp?.trimReason ?? 'none']}</span>
            </dd>
          </div>
          <div className="spec-list__row">
            <dt>ラウドネス変化（処理後）</dt>
            <dd className="mono">{fmt(dsp?.loudnessDeltaLu ?? null, 'LU')}</dd>
          </div>
          <div className="spec-list__row">
            <dt>出力ピーク（解析）</dt>
            <dd className="mono">{fmt(dsp?.outputPeakDb ?? null, 'dBFS', 2)}</dd>
          </div>
          <div className="spec-list__row">
            <dt>EQ 実効倍率</dt>
            <dd>
              <span className={`mono${safetyLimited ? ' is-warn' : ''}`}>{Math.round(scale * 100)}%</span>
              <span className="spec-list__note">
                {safetyLimited ? '安全予算を超えるため自動で制限中' : (dsp?.capScale ?? 1) < 0.995 ? `EQ 合成上限 +${spec.eqCapDb} dB による制限` : '制限なし'}
              </span>
            </dd>
          </div>
        </dl>
        <p className="output-stage__note">
          中高域は原音レベルを基準に保ち、ピークは低域コンプとリミッターで処理します。全帯域トリムは予算（目標 {spec.budget.trimTargetDb} dB・下限 {spec.budget.trimFloorDb} dB）内に限り、音量を上げる方向には補正しません。
        </p>
      </div>

      <div className="output-stage__block">
        <div className="output-stage__head">
          <span className="output-stage__title">ダイナミクス</span>
          <span className="output-stage__status">{fallback ? '簡易モード' : 'AudioWorklet'}</span>
        </div>
        {fallback ? (
          <p className="output-stage__note is-warn">
            このブラウザ環境では AudioWorklet が使えないため、低域コンプ・リミッターの代わりに簡易コンプレッサーで処理しています（https または localhost で開くと有効になります）。
          </p>
        ) : (
          <>
            <GrMeter label="低域コンプ" valueDb={bypass ? 0 : meters.bassGrDb} />
            <GrMeter label="リミッター" valueDb={bypass ? 0 : meters.limiterGrDb} budgetDb={spec.budget.maxLimiterGrDb} />
            <p className="output-stage__spec mono">
              低域コンプ: {spec.bassComp.ratio}:1 · しきい値 {dsp?.bassThresholdDb != null ? `${dsp.bassThresholdDb.toFixed(1)} dBFS` : '—'} · 150 Hz 以下のみ
            </p>
            <p className="output-stage__spec mono">
              リミッター: 天井 {spec.limiter.ceilingDb} dBFS（サンプルピーク）· 先読み {spec.limiter.lookaheadMs} ms · 予算 {spec.budget.maxLimiterGrDb} dB
              {dsp?.predictedLimiterGrDb != null && ` · 解析上の最大 ${dsp.predictedLimiterGrDb.toFixed(1)} dB`}
            </p>
          </>
        )}
        <p className="output-stage__note">
          {fallback
            ? 'リミッターではないため、急峻なピークが 0 dBFS を超える可能性があります。'
            : 'サンプルピークリミッターです（True Peak ではありません）。サンプル間ピークはわずかに天井を超える場合があります。'}
          {mode === 'extreme' && !fallback && ' EXTREME ではリミッターが強く働くため、キックに合わせて音量が揺れる（ポンピング）場合があります。'}
        </p>
      </div>
    </div>
  )
}
