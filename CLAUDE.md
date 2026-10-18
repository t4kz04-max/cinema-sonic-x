# CINEMA SONIC X — 開発ルール

ブラウザ完結型の重低音強化Webアプリ。音源をアップロードし、低音EQ・サブベース処理・倍音生成・ダイナミクス制御で重低音を加工し、加工前後を試聴してWAVを書き出す。

開発計画と各Phaseの完了条件は `docs/PHASES.md` を参照。空間音響プロトタイプ（feature/spatial-audio ブランチ）は `docs/SPATIAL.md` を参照。**指示されたPhaseの範囲を超えて実装を進めないこと。**

## 技術スタック

- Vite + React 19 + TypeScript（`tsc -b && vite build`）
- 音声処理は Web Audio API のみ（`AudioContext` / `OfflineAudioContext` / 標準ノード / 必要なら `AudioWorklet`）
- 不要な大規模ライブラリは追加しない。UIフレームワーク・状態管理ライブラリ・音声処理ライブラリの追加は要相談。
- 対象ブラウザ: PC版 Chrome / Edge を最優先。他ブラウザは「動けばよい」扱い。

## 絶対条件

1. **音源はローカルブラウザ内のみで処理する。** 外部API・サーバー・解析サービスへ音声データ（およびファイル名などのメタデータ）を送信しない。`fetch` / `XMLHttpRequest` / `WebSocket` / `sendBeacon` で音声を扱うコードを書かない。
2. **架空の音響処理やダミーの成功表示を実装しない。** 処理が接続されていないUIには必ず「未実装」「Phase XX で実装予定」と表示する。
3. **単に音量を上げるだけの処理を「重低音強化」と呼ばない。** 低音強化は帯域を限定したEQ、サブベース生成、倍音生成、ダイナミクス制御によって行う。全帯域を持ち上げる補正はしない。出力補正は「中高域を原音レベルに保ち、ピークは低域コンプ→リミッターで処理、全帯域トリムは予算内」が既定（Phase 02 の全帯域ラウドネス一致は中高域を過剰に下げて低音強化を相殺したため、A/B 比較用の選択肢に変更）。
4. **再生音量は控えめな初期設定にする**（現在: 音量スライダー 40% ≒ -15.9 dB）。強いブーストを伴う処理はクリップ防止（リミッター/ヘッドルーム）とセットで実装する。
5. 日本語UIを基本とする（機能名などの英語ラベル併記は可）。

## アーキテクチャ

```
src/
  audio/       Web Audio の処理（React非依存）
    AudioEngine.ts     AudioContext・再生・再生位置・出力補正の計測管理
    processingGraph.ts 処理グラフ（EQ / LR4 クロスオーバー / ワークレット / BYPASS）。再生・計測・書き出しで共通
    worklets/          AudioWorklet（低域コンプ＋トリム＋サンプルピークリミッター）
    bassSpec.ts        モード別の EQ・ダイナミクス・安全予算の定数
    biquadMath.ts      BiquadFilter と同じ式の振幅特性（EQ 合成上限の計算）
    loudness.ts        BS.1770 ラウドネス、ブロックピーク、全帯域トリムの計算（純粋関数）
    spectrum.ts        FFT 平均スペクトル・帯域レベル（純粋関数）
    analysis.ts        解析用抜粋・原音解析・処理計画（トリム／低域コンプしきい値／安全制限の決定）
    eqResponse.ts      UI 表示用の周波数特性
    loadAudioFile.ts   ファイル読み込み→形式判定→デコード、エラー分類
    spatial/           空間音響（spatialSpec: モード定義・説明 / spatialGraph: WIDE・CINEMA・HALL / spatialAnalysis: ラウドネス合わせと測定 / hallImpulse: 残響 IR 合成）
    stereoMetrics.ts   位相相関・ステレオ幅・モノラル和の測定（純粋関数）
  dev/         DSP 自己診断（tests/dsp-selftest.html から実行。本番ビルドに含まれない）
  hooks/       React と audio 層の橋渡し（useAudioPlayer）
  components/  表示とユーザー操作のみ。音声ノードを直接触らない
  utils/       純粋関数（ヘッダー解析・フォーマット・検証）
  types/       共有型
docs/PHASES.md 開発計画
```

- 再生グラフ: `AudioBufferSourceNode → ProcessingGraph → GainNode(モニター音量) → destination`
- ProcessingGraph は `input ─┬─ dry ─┬─ output` / `└─ HPF → EQ → LR4 150Hz ─(低域)→ ワークレット[低域コンプ → 合成 → トリム → リミッター] → wet ┘`。BYPASS 時の dry 経路はゲイン 1 のみで原音とビット一致させる（この性質を壊さない）。
- AudioWorklet が使えない環境（非セキュアコンテキスト）は DynamicsCompressor の簡易経路にフォールバックし、UI に明示する。
- リミッターは先読み付きのサンプルピークリミッター。True Peak とは表記しない。
- Phase 03 の倍音生成は EQ の後・クロスオーバーの前に挿入し、処理計画（analysis.ts の planProcessing）の計測にも含める。
- 音量Gainは常に最終段（モニター音量）であり、書き出し音声には影響させない。
- 空間グラフは重低音グラフの後に直列。ORIGINAL/PROCESSED は両段を同時に BYPASS し、直列でも原音とビット一致させる。
- 空間処理は原音とラウドネスをそろえて A/B 比較させる。HRTF の前方定位は個人差があるため、成立を前提にした表示・説明をしない。単純な左右パン・回転を「空間化」と呼ばない。
- Mid/Side 処理で Side に足す成分はモノラル和で消える形にする（モノラル互換性）。Side ゲインは原音の幅に応じて上限を設け、逆相が支配的にならないようにする。
- DynamicsCompressorNode（フォールバック）は自動メイクアップゲインを持つため、必ず実測値で打ち消す。基本コンプを「リミッター」「True Peak Limiter」と表記しない。
- AudioParam の変更は平滑化（setTargetAtTime / linearRamp）し、クリックノイズを出さない。BiquadFilter の lowpass/highpass の Q は dB 指定である点に注意。
- リアルタイム再生とWAV書き出し（OfflineAudioContext）で同じ処理チェーン構築関数を共有し、試聴音と書き出し音が一致するようにする。
- `decodeAudioData` は AudioContext のサンプルレートへリサンプルする。元ファイルの値はヘッダー解析結果として別に扱い、UIでは区別して表示する。

## エラー処理

- 想定するエラー: 非対応形式（拡張子・中身）、空ファイル、サイズ超過、読み込み失敗、デコード失敗、メモリ不足（`RangeError` 等）、AudioContext生成失敗。
- エラーはユーザーが次に何をすればよいか分かる日本語メッセージで表示する。握りつぶさない。
- 読み込み失敗時は直前に読み込み済みの音源を保持する。

## コーディング規約

- TypeScript: `any` を使わない。`erasableSyntaxOnly` のため `enum`・パラメータプロパティは使わない（union型を使う）。
- コメントは日本語可。「なぜそうしたか」を書く。
- CSSはプレーンCSS（`src/index.css` のトークン + `src/App.css`）。色は `:root` のCSS変数を使う。
- テーマ: 黒・ダークネイビー基調、アクセントはバイオレット。PC横幅を活かしたレイアウト。

## 作業の完了確認

- 変更後は必ず `npm run build`（型チェック + ビルド）を実行し、エラーがないことを確認する。
- `npm run lint`（oxlint）で警告を確認する。
- 空間処理を変更したら `npm run test:spatial` を実行し、全 PASS を確認する。
- 音声処理を変更したら `npm run test:dsp`（ヘッドレス Chrome/Edge で DSP 自己診断）を実行する。既知の FAIL（EDM相当の低域絶対値、docs/PHASES.md 参照）以外が出ないことを確認する。検証項目は `src/dev/dspSelfTest.ts` に追加し、純音だけでなく楽曲相当信号（`src/dev/testSignals.ts`）でも確認する。合格基準を結果に合わせて緩めない。
- 実装できていない機能は報告で「未実装」と明示する。動作確認していないことを「動作する」と書かない。
