// HRTF のデータの保持（Phase 07 の安定化）。
// Edge で、HRTF の PannerNode を使う OfflineAudioContext のレンダリングがまれに終わらないことがあった（OfflineAudioContext が running のまま、
// CPU は使われない。書き出し用フレームの HRTF の遅延の測定、ページ内の測定で確認）。書き出し用フレームでは、親ウィンドウで
// そのサンプルレートの HRTF のデータを持ち続けると止まらなくなった（Edge の test:export 60〜62: 保持あり 6/6 完了、なし 1/6 完了）。
// HRTF のデータはサンプルレートごとに作られ、使う文脈がなくなると破棄されるため、その作成・破棄の重なりが関係すると考えて
// 破棄させないようにする。ブラウザ内部の原因は確定していない（docs/SPATIAL.md）
//
// サンプルレートごとに、小さな OfflineAudioContext（128 フレーム・レンダリングしない・ワークレットなし）と HRTF の PannerNode を 1 つ持つ

const keepers = new Map<number, OfflineAudioContext>()

/** 試験・比較用: window.__csxNoHrtfKeeper が true のときは保持しない */
const disabled = () => !!(globalThis as { __csxNoHrtfKeeper?: boolean }).__csxNoHrtfKeeper

export function keepHrtfLoaded(sampleRate: number): void {
  if (disabled() || keepers.has(sampleRate) || typeof OfflineAudioContext === 'undefined') return
  console.debug('[CINEMA SONIC X] export-trace', JSON.stringify({ side: 'page', stage: 'hrtf-keep', phase: 'start', sampleRate }))
  try {
    const ctx = new OfflineAudioContext(1, 128, sampleRate)
    new PannerNode(ctx, { panningModel: 'HRTF' })
    keepers.set(sampleRate, ctx)
    console.debug('[CINEMA SONIC X] export-trace', JSON.stringify({ side: 'page', stage: 'hrtf-keep', phase: 'end', sampleRate }))
  } catch {
    // 作れない環境（HRTF なし）では何もしない（処理はそのまま行う）
  }
}

/** 試験用: 保持している HRTF のサンプルレート */
export const keptHrtfRates = () => [...keepers.keys()]
