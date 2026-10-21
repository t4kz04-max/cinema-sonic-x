import { memo } from 'react'
import { derivedDspValues, getPreset, presetToDsp, SPATIAL_PRESETS } from '../audio/presets/spatialPresets'
import type { AudioPlayer } from '../hooks/useAudioPlayer'
import type { DspStatus } from '../types/audio'
import { Badge, Panel } from './Panel'

interface PresetPanelProps {
  player: AudioPlayer
}

const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`

/**
 * 解析した抜粋での ORIGINAL → PROCESSED のラウドネス差。空間 ON のときは空間段の解析がチェーン全体
 * （重低音 ON なら重低音段を含む）を測るため、その値を出す。空間 OFF・重低音 ON のときは重低音段の値
 */
function loudnessRow(dsp: DspStatus | null, bassEnabled: boolean, spatialOn: boolean): { label: string; value: string } | null {
  if (!dsp) return null
  const s = dsp.spatial
  if (spatialOn) {
    const v = s.before && s.after ? s.after.loudnessLufs - s.before.loudnessLufs : null
    return { label: bassEnabled ? 'ラウドネス差（重低音 + 空間）' : 'ラウドネス差（空間）', value: v !== null && s.analysis !== 'measuring' ? `${signed(v)} LU` : s.analysis === 'measuring' ? '測定中…' : '—' }
  }
  if (bassEnabled) {
    const v = dsp.analysis === 'ready' ? dsp.loudnessDeltaLu : null
    return { label: 'ラウドネス差（重低音）', value: v !== null ? `${signed(v)} LU` : dsp.analysis === 'measuring' ? '測定中…' : '—' }
  }
  return { label: 'ラウドネス差', value: '処理なし（0 LU）' }
}

export const PresetPanel = memo(function PresetPanel({ player }: PresetPanelProps) {
  const { presetState: ps, bypass, dsp, dspConfig } = player
  const active = ps.activeId ? getPreset(ps.activeId) : null
  const base = ps.source?.kind === 'preset' ? getPreset(ps.source.id) : null
  const shown = active ?? base
  const analysis = dsp?.compare.analysis
  const stateLabel = ps.activeId
    ? `${getPreset(ps.activeId).label} を適用中`
    : ps.savedActive
      ? '保存した CUSTOM を適用中'
      : ps.custom
        ? `CUSTOM（${base ? `${base.label} から変更` : '保存した CUSTOM から変更'}）`
        : '手動設定（プリセット未選択）'

  return (
    <Panel
      index="04"
      id="studio-preset"
      label="PRESET"
      title="空間音響プリセット"
      className="panel--preset"
      aside={
        <>
          {(dsp?.spatial.analysis === 'measuring' || dsp?.analysis === 'measuring') && <Badge tone="pending">ラウドネス測定中…</Badge>}
          <Badge tone={ps.activeId || ps.savedActive ? 'live' : ps.custom ? 'pending' : 'idle'}>{stateLabel}</Badge>
        </>
      }
    >
      <div className="preset-cards" role="radiogroup" aria-label="空間音響プリセット">
        {SPATIAL_PRESETS.map((p) => {
          const selected = ps.activeId === p.id
          const modified = !selected && ps.custom && ps.source?.kind === 'preset' && ps.source.id === p.id
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`preset-card${selected ? ' is-active' : ''}${modified ? ' is-modified' : ''}`}
              onClick={() => player.applyPreset(p.id)}
            >
              <span className="preset-card__head">
                <span className="preset-card__label">{p.label}</span>
                <span className="preset-card__state">{selected ? '選択中' : modified ? 'CUSTOM' : ''}</span>
              </span>
              <span className="preset-card__summary">{p.summary}</span>
              <ul className="preset-card__effects">
                {p.effects.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
              <span className="preset-card__foot">{p.headphones ? 'ヘッドホン専用（HRTF）' : 'スピーカー・ヘッドホン'} · v{p.version}</span>
            </button>
          )
        })}
      </div>

      <div className="preset-detail">
        <div className="preset-detail__main">
          {shown ? (
            <>
              <p className="spatial-doc__title">
                {shown.label}
                {ps.custom && '（元の設定。現在は CUSTOM）'}
              </p>
              <p className="preset-detail__desc">{shown.description}</p>
              <dl className="spec-list spec-list--compact">
                {derivedDspValues(ps.custom ? presetToDsp(shown) : dspConfig).map(([k, v]) => (
                  <div className="spec-list__row" key={k}>
                    <dt>{k}</dt>
                    <dd className="mono">{v}</dd>
                  </div>
                ))}
              </dl>
              <ul className="preset-detail__caveats">
                {shown.caveats.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="spatial-param__desc">カードを選ぶと、空間モード・Motion・Spatial Tail・重低音の設定をまとめて適用します（下の詳細設定で個別に調整できます）。</p>
          )}
        </div>

        <div className="preset-detail__side">
          <p className="spatial-doc__title">ORIGINAL / PROCESSED 比較</p>
          <div className="ab-switch" role="radiogroup" aria-label="試聴する音（B キーで切替）">
            <button type="button" role="radio" aria-checked={bypass} className={`ab-switch__item${bypass ? ' is-active is-original' : ''}`} onClick={() => player.setBypass(true)}>
              ORIGINAL
            </button>
            <button type="button" role="radio" aria-checked={!bypass} className={`ab-switch__item${!bypass ? ' is-active' : ''}`} onClick={() => player.setBypass(false)}>
              PROCESSED
            </button>
          </div>
          <dl className="spec-list spec-list--compact">
            {(() => {
              const r = loudnessRow(dsp, dspConfig.bassEnabled, dspConfig.spatial.mode !== 'off')
              return (
                r && (
                  <div className="spec-list__row">
                    <dt>{r.label}</dt>
                    <dd className="mono">{r.value}</dd>
                  </div>
                )
              )
            })()}
            <div className="spec-list__row">
              <dt>ORIGINAL の時刻合わせ</dt>
              <dd className="mono">{dsp?.compare.alignMs != null ? `${dsp.compare.alignMs.toFixed(1)} ms 遅らせて処理音とそろえる` : '— （AudioWorklet 非対応のため合わせない）'}</dd>
            </div>
          </dl>
          <p className="output-stage__note">
            同じ 1 つの音源を、原音経路と処理経路のクロスフェード（40 ms）で切り替えます（二重再生・再生位置の移動なし）。空間段の最後のトリムで、重低音段を含むチェーン全体を原音のラウドネスにそろえます（持ち上げはリミッターの予算 3 dB 以内。ピークの多い音源ではそろいきらず小さくなる場合があり、その差を上に表示）。値は曲の抜粋で測定。ORIGINAL を聴きながらプリセットを変えた場合、PROCESSED へ戻すときに遅延の差だけ位置がずれます。
          </p>

          <p className="spatial-doc__title preset-custom__title">CUSTOM 設定</p>
          <p className="spatial-param__desc">
            {ps.saved
              ? `保存済み: ${ps.saved.savedAt ? new Date(ps.saved.savedAt).toLocaleString('ja-JP') : '日時不明'}${ps.saved.base ? `（${getPreset(ps.saved.base.id).label} v${ps.saved.base.version} から）` : ''}`
              : '保存した CUSTOM はありません。'}
            {' '}このブラウザ内にだけ保存します（設定値のみ。音声・ファイル名は保存しません）。
          </p>
          <div className="preset-custom__buttons">
            <button type="button" className="btn-chip" onClick={player.saveCurrentCustom}>
              現在の設定を CUSTOM として保存
            </button>
            <button type="button" className={`btn-chip${ps.savedActive ? ' is-active' : ''}`} onClick={player.applySavedCustom} disabled={!ps.saved}>
              保存した CUSTOM を適用
            </button>
            <button type="button" className="btn-chip" onClick={player.deleteSavedCustom} disabled={!ps.saved}>
              削除
            </button>
          </div>
          {ps.storageMessage && <p className="notice">{ps.storageMessage}</p>}
          {analysis && (
            <p className="output-stage__note mono">
              解析レンダリング {analysis.renders} 回（うち AudioWorklet {analysis.workletRenders} 回）・キャッシュから反映 {analysis.cacheHits} 回
            </p>
          )}
        </div>
      </div>
    </Panel>
  )
})
