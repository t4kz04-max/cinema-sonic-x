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
    spatial/motion*.ts Dynamic Spatial Motion Engine（motion: 位置の純粋関数 / motionEnvelope: PULSE 包絡 / motionTypes）
    worklets/motion.worklet.ts  STFT レイヤー分解・距離処理・12 方向パン
    spatial/tail*.ts   Spatial Tail（tailImpulse: 余韻の IR 合成 / tailEngine: 後期残響チェーン / tailTypes）、reverbBus.ts: 畳み込みの切替・残響の消去
    worklets/tail.worklet.ts    Dynamic Tail・残響の蓄積防止
    transportOps.ts    STOP / PAUSE / CUT / ループ境界の操作（再生エンジンとテストで共通）
    presets/spatialPresets.ts  Phase 05 の完成版プリセット（凍結した型付き設定、presetToDsp で DspConfig に写す）
    dspConfig.ts       再生エンジン・書き出しが受け取る DSP 設定一式（重低音 + 空間）、比較・検証・解析キャッシュのキー
    outputChain.ts     重低音グラフ → 空間グラフのチェーン構築（再生・オフラインで共通）
    alignDelay.ts / worklets/align.worklet.ts  ORIGINAL/PROCESSED 比較の時刻合わせ（整数サンプル遅延）
    planCache.ts / analysisStats.ts  処理計画のキャッシュ・解析用文脈の作成回数
    export/            Phase 06 の書き出し（exportSpec: 余韻の長さ・メモリの見積もり・型 / renderExport: createOutputChain でのオフラインレンダリング /
                       wavEncoder: WAV（16-bit TPDF ディザ・24-bit）/ exportRunner + exportFrame: 使い捨て iframe での実行・キャンセル・
                       段階の記録と監視（打ち切り・準備での 1 回の自動やり直し）・書き出しの後に残るメモリの見積もり）
    hrtfKeeper.ts      HRTF のデータの保持（サンプルレートごと。Edge で HRTF の OfflineAudioContext が止まる問題の対策）
    analysisFrame/     Phase 09: 処理計画の解析を使い捨ての iframe（analysis-frame.html）で行う（analysisHost: 親側・3 秒使わないと削除・監視とやり直し / analysisFrame: フレーム側 / analysisProtocol）
    loopRegion.ts      ループ区間（SPATIAL LOOP は音楽が鳴っている区間）
    stereoMetrics.ts   位相相関・ステレオ幅・モノラル和の測定（純粋関数）
  video/       Phase 07 の動画（React 非依存。mediabunny + WebCodecs、動画を読み込んだときだけ遅延読み込み）
    videoSpec.ts       型・上限・出力の音声コーデック・サイズの見積もり
    videoProbe.ts      中身でコンテナ・コーデック・トラックを判定（ファイル全体は読まない）
    videoAudio.ts      音声トラックのデコード（タイムスタンプの位置に並べる）
    videoMux.ts        映像パケットのコピー + 加工済み音声のエンコード（余韻: 映像の長さを保つ / 最後のフレームを延ばす）
    videoExport.ts     Phase 06 の書き出し（WAV を作らず浮動小数点で受け取る）→ videoMux
  dev/         DSP 自己診断（tests/dsp-selftest.html から実行。本番ビルドに含まれない）
  hooks/       React と audio 層の橋渡し（useAudioPlayer）、playbackClock（再生位置・メーターの小さなストア）
  components/  表示とユーザー操作のみ。音声ノードを直接触らない
               SimpleView（SIMPLE MODE）/ StudioView（STUDIO MODE: 既存の各パネル）/ MediaCompare（完成ファイルと元のファイルの比較再生）/
               exportCommon・exportLabels（書き出しの段階の表示・エラーと再試行・設定名）/ PlaybackTimeline・VolumeControl（両モード共通）
  utils/       純粋関数（ヘッダー解析・フォーマット・検証）、customPresetStorage（CUSTOM のブラウザ内保存）、platform（スマートフォン・WebCodecs の有無による制限）
  types/       共有型
docs/PHASES.md 開発計画
```

- 再生グラフ: `AudioBufferSourceNode → ProcessingGraph → GainNode(モニター音量) → destination`
- ProcessingGraph は `input ─┬─ dry ─┬─ output` / `└─ HPF → EQ → LR4 150Hz ─(低域)→ ワークレット[低域コンプ → 合成 → トリム → リミッター] → wet ┘`。BYPASS 時の dry 経路はゲイン 1 のみで原音とビット一致させる（この性質を壊さない）。
- AudioWorklet が使えない環境（非セキュアコンテキスト）は DynamicsCompressor の簡易経路にフォールバックし、UI に明示する。
- リミッターは先読み付きのサンプルピークリミッター。True Peak とは表記しない。
- Phase 03 の倍音生成は EQ の後・クロスオーバーの前に挿入し、処理計画（analysis.ts の planProcessing）の計測にも含める。
- 音量Gainは常に最終段（モニター音量）であり、書き出し音声には影響させない。
- 書き出しは再生と同じ createOutputChain・同じ処理計画（AudioEngine.exportSnapshot）で行い、書き出し専用の DSP を作らない。Motion は時刻 0 から再生する transport で描画する（シーク・プレビューの履歴に依存させない）。
- 書き出しは使い捨ての iframe（export-frame.html）で行い、終わったら（キャンセルも）iframe ごと削除する（Chrome が AudioWorklet を読み込んだ OfflineAudioContext を解放しないため）。ページ内で書き出し用の OfflineAudioContext を作らない。
- 書き出しは exportRunner の監視（段階の記録が届かない: 準備 30 秒 / 進捗が届かない: レンダリング 60 秒 / エンコード 60 秒 + 音声 1 秒あたり 0.2 秒 / 動画の書き込み 60 秒）を通す。自動のやり直しは準備の段階・音源を送る前だけ 1 回まで（無限に繰り返さない）。フレームへの要求は prepare（音源なし）→ render（音源を転送）の 2 段階を保つ（やり直しで音源のコピーを持たないため）。レンダリングの進捗は音声 5 秒ごと以下で届ける（長い音源で監視が誤って止めないため）。段階の記録・ログに音声のサンプル値・ファイル名を入れない。
- HRTF の PannerNode を使う OfflineAudioContext をレンダリングする前に、そのサンプルレートの HRTF のデータを保持する（hrtfKeeper.keepHrtfLoaded。measureHrtfLatency・startExport は内部で呼ぶ）。Edge で保持しないとレンダリングが止まることがある（原因は未確定。docs/SPATIAL.md）。
- 処理計画の解析（analyzeSource / planProcessing / analyzeSpatialSource / planSpatial）は、AudioEngine から AnalysisHost を通して解析用フレームで行う。ページで AudioWorklet を読み込んだ OfflineAudioContext を作らない（Chrome が解放せず、解析のたびにメモリが残る。書き出しの後に出力 1 本分が残る条件でもあった。Phase 09 で解消: 3 分の素材でプリセット 20 回の後 −172〜−229 MB）。ページに残してよい文脈は hrtfKeeper・measureHrtfLatency（ワークレットなし）だけ。新しい書き出しのメモリの判定には pendingRetainedBytes を足す（安全側の見積もりとして残している）。
- 長く残るリスナー（AbortSignal など）は、大きな配列を捕まえる関数の中で作らない（同じ関数のクロージャーは捕まえた変数を共有し、リスナーが残る間その配列が解放されない。Phase 07 で 約 84 MB 残った）。小さな関数で作り、終わったら外す。
- 書き出しの前に再生側の AudioContext を止める（AudioEngine.suspendForExport）。Chrome では別の AudioContext が HRTF を処理していると、OfflineAudioContext の HRTF の結果が回ごとに変わる。書き出し以外で AudioContext を止めない（止めている間はブラウザが切り離したノードを解放せず、設定の変更のたびに畳み込みのメモリが積み上がる）。
- 書き出しの余韻の長さは設定の IR の長さ・プリディレイから決め（exportSpec.reverbTailSeconds）、固定値にしない。先頭は処理の遅延を切り捨て、末尾は −100 dBFS を下回ってから 150 ms 後で切って 20 ms フェード。
- 書き出しの完了表示は WAV の Blob ができてから。キャンセル・失敗時は結果（Object URL）を作らない。Object URL は次の書き出し・音源の読み込み・アンマウントで解放する。
- 空間グラフは重低音グラフの後に直列（outputChain.ts）。ORIGINAL/PROCESSED は両段を同時に BYPASS し、直列でも原音とビット一致させる（再生エンジンでは時刻合わせの整数サンプル遅延だけ遅れた原音とビット一致）。
- 空間処理は原音とラウドネスをそろえて A/B 比較させる。HRTF の前方定位は個人差があるため、成立を前提にした表示・説明をしない。単純な左右パン・回転を「空間化」と呼ばない。
- Motion の位置は必ず「メディア時刻とパラメーターの純粋関数」にする（乱数・壁時計を使わない）。シーク・オフライン書き出しで同じ動きを再現するため。HRTF の PannerNode は固定方向で使い、位置の自動化をしない。
- 使っていないチェーンは入力を切り離し、休止できるワークレットは休止させる（CPU 負荷対策）。
- 既存 HALL の余韻は変えない。Spatial Tail OFF・NATURAL 50/50 がベースライン（src/dev/hallBaseline.json）と一致することを test:tail で確認する。
- AudioParam のランプは nodeUtils の linearRampAt / fadeGate / rampLinear を使う（linearRampToValueAtTime を直接使うと、前のイベントが過去にあるときランプが過去から始まり値が飛ぶ）。
- ワークレットの port.onmessage は通知を使うとき（reportIntervalMs > 0）だけ設定する（設定すると OfflineAudioContext ごと解放されない）。
- ConvolverNode を作り直さない（ループ境界などで繰り返し作るとカーネルのメモリが積み上がる）。残響の消去は ReverbBus.reset で組を使い回す。
- STOP は余韻を残し、PAUSE / CUT は余韻ごと止める。停止系の操作は transportOps.ts の関数を使い、テストも同じ関数で検証する。
- プリセットの元データ（SPATIAL_PRESETS）は凍結してあり書き換えない。適用は presetToDsp のコピーを AudioEngine.applyDsp に渡す。詳細設定を変えた状態は CUSTOM（UI の状態。DSP 設定とは分けて持つ）。プリセットの設定値を変えたら version を上げる。
- プリセットに HALL + Motion を使わない（ピーク対ラウドネス比が約 4 dB 上がり、リミッター予算内で原音のラウドネスにそろわない。Phase 05 で測定）。新しいプリセットは test:preset のラウドネス（全チェーン ±1 LU）・ピークを満たすこと。
- 空間の処理計画（ラウドネス合わせ）は、重低音 ON のとき重低音段を通した音で測り、チェーン全体を原音にそろえる。計画は設定のキー（dspConfig の spatialPlanKey / bassPlanKey）でキャッシュし、同じ設定では解析し直さない。
- ORIGINAL 経路は時刻合わせ（alignBypass）で処理経路と同じ遅延にする。遅延の変更は ORIGINAL 経路が無音のときだけ行う（整数サンプルのワークレットなので遅延した原音とビット一致）。
- 1 つの入力に 3 つ以上の出力を足し込まない（ブラウザが足す順序が毎回変わり、同じ設定でも出力がわずかに変わる）。多数の和は spatialGraph の sumTree（2 入力ずつの木）を使う。
- HRTF の方向を変えるときは PannerNode の位置を自動化せず、固定方向の 2 つを crossfade する（spatialGraph の createHrtfVoice）。
- Mid/Side 処理で Side に足す成分はモノラル和で消える形にする（モノラル互換性）。Side ゲインは原音の幅に応じて上限を設け、逆相が支配的にならないようにする。
- DynamicsCompressorNode（フォールバック）は自動メイクアップゲインを持つため、必ず実測値で打ち消す。基本コンプを「リミッター」「True Peak Limiter」と表記しない。
- AudioParam の変更は平滑化（setTargetAtTime / linearRamp）し、クリックノイズを出さない。BiquadFilter の lowpass/highpass の Q は dB 指定である点に注意。
- リアルタイム再生とWAV書き出し（OfflineAudioContext）で同じ処理チェーン構築関数を共有し、試聴音と書き出し音が一致するようにする。
- 動画は mediabunny（バージョン固定・改変しない）で扱い、映像は再エンコードしない（符号化済みのパケットとタイムスタンプをそのままコピー）。音声は元の音声トラックの開始時刻から並べる。動画の音声の抽出に decodeAudioData を使わない（音声の開始時刻を失う）。
- 動画のモジュール（src/video、mediabunny）は動的 import で読み込み、メインのバンドルに入れない。
- Matroska（WebM / MKV）の出力は SimpleBlock に長さがないため、入力が固定フレームレートのときだけ frameRate を渡す（渡さないと最後のフレームの長さが 0 になる）。最後のフレームの延長は Matroska ではファイル全体の長さでしか表せない。
- 動画の書き出しも Phase 06 の書き出し（使い捨ての iframe・suspendForExport）を使い、動画専用の DSP を作らない。映像の長さは利用者が選んだときだけ変える（既定は映像の長さを保つ）。
- 画面は SIMPLE MODE（既定）と STUDIO MODE（URL のハッシュ `#studio`）。両方で同じ `useAudioPlayer`（同じ AudioEngine・DSP 設定・読み込んだファイル・書き出しの結果）を使い、モードの切替は表示だけを変える。切替で再解析・再レンダリング・AudioContext の作成を起こさない（test:ui で確認）。モードをまたいで残す UI の状態（書き出しの設定など）は各パネルの useState ではなく `useAudioPlayer`（`exportOptions`）に持つ。
- 再生位置・メーターのように毎フレーム変わる値は React の状態にしない（`playbackClock` を必要な部品だけが購読する）。`useAudioPlayer` の返す値はメモ化し、パネルは `React.memo` にする。パネルに毎回作り直すインライン関数・オブジェクトを渡さない（メモ化が効かなくなり、再生中に全パネルが再描画される。Phase 07 までの画面は再生中のメインスレッドのスクリプト時間が約 56 %、Phase 08 で SIMPLE 約 13 % / STUDIO 約 20 %）。
- SIMPLE には詳細な DSP のパラメーターを出さない。プリセットの説明文は SIMPLE 用の UI の文言（SimpleView の SIMPLE_COPY）で、凍結したプリセットのデータは変えない。SIMPLE ではプリセット（または CUSTOM）を選ぶまで書き出させない。
- スマートフォン・タブレット・WebCodecs のないブラウザでは動画の書き出しを無効にして理由を表示する（`utils/platform.ts`）。無理にすべての端末で動画の処理をさせない。
- 書き出しの段階の表示は実際の段階だけ（推定のアニメーションを使わない）。書き出し用の iframe は親と同じスレッドなので、親に表示させたい段階の通知の直後に長い同期処理を始めない（renderExport は ENCODING の通知の後に 50 ms 譲る。譲らないと ENCODING が一度も描画されない）。
- `decodeAudioData` は AudioContext のサンプルレートへリサンプルする。元ファイルの値はヘッダー解析結果として別に扱い、UIでは区別して表示する。

## エラー処理

- 想定するエラー: 非対応形式（拡張子・中身）、空ファイル、サイズ超過、読み込み失敗、デコード失敗、メモリ不足（`RangeError` 等）、AudioContext生成失敗。
- エラーはユーザーが次に何をすればよいか分かる日本語メッセージで表示する。握りつぶさない。
- 読み込み失敗時は直前に読み込み済みの音源を保持する。

## コーディング規約

- TypeScript: `any` を使わない。`erasableSyntaxOnly` のため `enum`・パラメータプロパティは使わない（union型を使う）。
- コメントは日本語可。「なぜそうしたか」を書く。
- CSSはプレーンCSS（`src/index.css` のトークン + `src/App.css`）。色は `:root` のCSS変数を使う。
- テーマ: 黒・ダークグレー基調（Phase 08 で無彩色寄りに変更）、アクセントはバイオレット。PC横幅を活かしたレイアウト。スマートフォン幅（〜600px）まで横にはみ出さない。過剰なアニメーション・`background-attachment: fixed` など描画の負荷を増やすものは使わない。

## 作業の完了確認

- 変更後は必ず `npm run build`（型チェック + ビルド）を実行し、エラーがないことを確認する。
- `npm run lint`（oxlint）で警告を確認する。
- 空間処理を変更したら `npm run test:spatial`（空間音響＋Motion）と `npm run test:tail`（Phase 04）を実行する。各スイートは別々のヘッドレスブラウザで順に実行される（Chrome が解析用の OfflineAudioContext を解放しないため）。空きメモリが 400 MB 未満になると中断する（`CSX_MIN_FREE_MB` で変更）。メモリに余裕があるときに 1 つずつ実行する。個別実行: `node scripts/run-dsp-selftest.mjs --suite=<motion|tail|cpu|tailcpu|baseline|preset|presetcpu|export|video> [--query=groups=26-32] [--log]`。
- 書き出しを変更したら `npm run test:export`（Phase 06。WAV・余韻・Motion の再現・リアルタイムとの一致・メモリ・キャンセル・監視と打ち切り（グループ 72）。9 セッション）を実行する。
- 動画の処理を変更したら `npm run test:video`（Phase 07。読み込み・抽出・WAV・ストリームコピー・同期・余韻・キャンセル・メモリ・プレビュー・監視と打ち切り（グループ 90）・サンプルレート / フレームレート / 解像度の違い（グループ 91）。7 セッション）を実行する。試験の動画は WebCodecs で生成する（src/dev/videoFixtures.ts）。グループ 88 のメモリは Phase 09 で PASS になった（解析を解析用フレームへ移した。docs/SPATIAL.md）。メモリの内訳の診断（グループ 98、合否なし）は通常の test:video に含めず `npm run test:video:diagnostic` で実行する。試験用のページの調査用の指定: `nohrtfkeeper=1`（HRTF の保持なしで比較）・`traceaudio=1`（ページ内のレンダリングの開始・完了を出す）。
- 書き出しの監視で打ち切ったときは、ランナーが `WARN` 行を表示する（グループ 72・90 は意図して止める試験なので WARN が出る）。`--log` で書き出しの段階の記録（`TRACE` 行）も表示する。スイートが TIMEOUT になったときは結果なしとして扱い、PASS と数えない。止まったブラウザの終了は試験用のプロファイル（`csx-selftest-`）のプロセスだけにする。
- UI を変更したら `npm run test:ui`（Phase 08。`scripts/run-ui-test.mjs`: 実際のアプリをヘッドレスの Chrome / Edge で開いて操作する。音声 / 動画の 2 セッション。表示・モードの切替と状態の保持・アップロード・プリセット・CUSTOM・再生・書き出し・プレビュー・ダウンロード・キャンセル・エラー・画面サイズ）を実行する。`--session=audio|video` で一部だけ、`--screens=<フォルダー>` で確認用の画面写真を保存。CPU・切替の時間・メモリは INFO（合否なし）。
- Phase 09 の試験・測定: `npm run test:quality`（4 プリセットの音響品質。ピーク・ラウドネス・相関は判定、True Peak・周波数特性・幅・中央・動き・余韻は INFO）、`npm run test:hrtf`（44.1 ↔ 48 kHz・キャンセルと再実行・文脈の作成と破棄を繰り返し、HRTF の停止を数える）、`npm run measure:memory`（本番ビルドで通常利用のメモリ・CPU を段階ごとに測る。先に `npm run build`。`--endurance` で耐久試験（30 分の再生ほか、約 50 分）、`--quick` は確認用）。合否のない測定は値を記録し、基準を後から結果に合わせない。
- Motion のワークレットは、停止 → 再生の開始で入力が無音なら STFT の区切りをメディアのサンプル位置にそろえ直す（書き出しと同じ状態から始める）。再生開始の通知（MessagePort）が音より先に届いたときだけ効く。再生の開始を遅らせて通知を先に届ける方法は、曲の終わりの再生と書き出しの差が悪化したため使っていない（docs/SPATIAL.md の Phase 09）。
- メモリを測る試験は、他のアプリで空きメモリが少ないと中断（ABORTED）する。実行前に空きメモリを確認する（test:video はブラウザ全体で最大 約 1.4 GB 使う。Phase 07 の測定で Chrome 1341 MB / Edge 1363 MB）。空きメモリが 5 GB 未満のときは重い試験を始めない（Phase 08・09 で、他のアプリの使用で空きが 3 GB 台に下がり、Claude Code が試験を止めた・試験が中断した）。試験の実行スクリプトは `CSX_MIN_FREE_MB=3500` で自分で中断させる（空きが 5.2 GB 程度だと、Edge の test:preset の 3 番目のセッション（グループ 43）がこれを下回って中断することがある。そのときは残りのセッションを `--suite=preset&groups=…` で 1 つずつ実行する）。
- Edge の test:export グループ 68（書き出し 3 回のメモリ）は、Edge 自身の補助プロセス `utility:edge`（約 33 MB）が 1 回目の測定のときだけ止まっていることがあり、その分で基準 30 MB を超えて FAIL することがある（Phase 08 のコードでも再現。アプリのレンダラーは +1〜4 MB。docs/PHASES.md の Phase 09）。結果の行の「調査: 各回の状態」でプロセスごとの内訳を確かめる。基準は変えていない。
- プリセット・A/B 比較・CUSTOM・解析の最適化を変更したら `npm run test:preset`（Phase 05、13 のブラウザセッションに分けて順に実行）を実行する。INFO 行は合否を判定しない測定値（原因調査など）。
- 音声処理を変更したら `npm run test:dsp`（ヘッドレス Chrome/Edge で DSP 自己診断）を実行する。既知の FAIL（EDM相当の低域絶対値、docs/PHASES.md 参照）以外が出ないことを確認する。検証項目は `src/dev/dspSelfTest.ts` に追加し、純音だけでなく楽曲相当信号（`src/dev/testSignals.ts`）でも確認する。合格基準を結果に合わせて緩めない。
- 実装できていない機能は報告で「未実装」と明示する。動作確認していないことを「動作する」と書かない。
