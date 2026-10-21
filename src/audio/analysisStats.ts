// 解析用 OfflineAudioContext の作成回数（メモリ対策の確認用）。
// Chrome は AudioWorklet を読み込んだ OfflineAudioContext を解放しないため、workletRenders が
// 長時間使用時のメモリ増加の目安になる（1 回あたり数 MB）。

export const analysisStats = {
  /** 解析で作った OfflineAudioContext の総数 */
  renders: 0,
  /** そのうち AudioWorklet を読み込んだもの（ブラウザが解放しない） */
  workletRenders: 0,
}

export function countAnalysisRender(worklet: boolean): void {
  analysisStats.renders++
  if (worklet) analysisStats.workletRenders++
}

/** 解析用フレーム（Phase 09）で作った文脈の数を足す（フレームから結果と一緒に届く） */
export function addAnalysisRenders(renders: number, workletRenders: number): void {
  analysisStats.renders += renders
  analysisStats.workletRenders += workletRenders
}
