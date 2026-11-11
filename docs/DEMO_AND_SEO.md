# 公式デモ音源（Spatial Showcase）と公開準備（SEO）

## デモ音源

| 項目 | 値 |
| --- | --- |
| ファイル | `public/audio/spatial-showcase.wav`（ビルドで `dist/audio/` にコピー、配信は `/audio/spatial-showcase.wav`） |
| 内容 | CINEMA SONIC X のオリジナル電子音楽・40.0 秒・ステレオ・48 kHz・24-bit PCM・11,520,044 バイト |
| 定義 | `src/demo/demoSpec.ts`（区間・判定の純粋関数）、`src/demo/fetchDemo.ts`（取得） |

- 最初の表示では取得しない。「サンプル音源で試す」を押したときだけ同じサイトから GET で取得する（利用者の音声・ファイル名は送らない）
- 取得した WAV は `File` にして通常の `loadAudioFile` に渡す（同じ DSP・プリセット・比較・書き出しの経路。デモ専用の処理はない）
- デモかどうかは `LoadedAudio.source = { kind: 'demo', demoId }` で判定する（ファイル名では判定しない）
- 区間（Intro 0–4 / Groove 4–12 / Main 12–28 / Space 28–36 / Outro 36–40 秒）は表示とシーク（`player.seek`）だけ。音源は分割しない
- 取得中に別のファイル・デモを読み込み始めたら取得を中止し、古い結果は反映しない（読み込みの番号）
- 失敗（HTTP エラー・WAV でない応答・90 秒の時間切れ・通信の切断・長さが 40 秒でない）では直前の音源を保持し、エラーを表示する。もう一度ボタンを押せる
- 書き出しは通常どおり（余韻で 40 秒より長くなる。例: IMMERSIVE X で 40.87 秒）。元のデモ音源（加工なし）のダウンロードは「公式デモ音源」と明記

### 試験

- `npm run test:demo`: 区間・判定・配置した WAV のヘッダー（ブラウザなし）
- `node scripts/run-ui-test.mjs --session=demo`（項目 20〜30）: 取得しないこと・404 / WAV でない応答・読み込みの競合（CDP の Fetch で応答を止める・差し替える）・読み込み・区間のシーク・再生中の区間・4 プリセット・ORIGINAL / PROCESSED・SIMPLE / STUDIO の状態の保持・書き出しとダウンロード・通常のファイルへの差し替え・スマートフォンの幅
- STUDIO を初めて表示すると EQ のグラフ（`eqResponse.ts`）が 1 フレームの OfflineAudioContext を 1 つ作る（既存の動作）。項目 27 はその後から数える

## SEO・公開準備

追加したもの:

- `index.html`: title・meta description・canonical（`https://cinema-sonic-x.vercel.app/`）・robots・OGP（og:title / description / url / type / site_name / locale）・Twitter card（summary）・構造化データ（WebApplication。評価などは書かない）・noscript
- `public/robots.txt`（すべて許可・sitemap の場所）、`public/sitemap.xml`（トップの 1 URL。`#studio` はハッシュなので同じ URL）
- 画面の下の説明（`AboutSection`。日本語・英語。実際にある機能だけ）

未対応・判断が必要なもの:

- **og:image がない**（共有したときの画像。1200×630 の PNG / JPG を用意して `public/` に置き、`og:image` と `twitter:card=summary_large_image` を追加する）
- `vercel.json` は追加していない: 画面の切替はハッシュ（`#studio`）で、パスは `/` だけのため SPA の書き換えは不要。書き換えを入れると存在しないパスが index.html（200）になり、ソフト 404 になる
- 検索結果への掲載・順位は保証されない

## Google Search Console（外部サービスの操作。手動）

1. https://search.google.com/search-console で「プロパティを追加」→ **URL プレフィックス** に `https://cinema-sonic-x.vercel.app/`（`vercel.app` のサブドメインはドメイン プロパティ（DNS の確認）を使えない）
2. 所有権の確認は **HTML タグ** を選び、表示された `<meta name="google-site-verification" content="…">` を `index.html` の `<head>` に追加 → ビルド・デプロイ → 「確認」（または HTML ファイルを `public/` に置く方法）
3. 「サイトマップ」に `sitemap.xml` を送信
4. 「URL 検査」でトップの URL を調べ、「インデックス登録をリクエスト」
5. 独自ドメインを使うときは canonical・og:url・robots.txt・sitemap.xml の URL を書き換える

## 公開の手順（許可を得てから）

1. コミットに含めるファイルを確認（`docs/PHASES.md`・`docs/DEPLOY.md`・`docs/TECHNICAL_OVERVIEW.md` は今回の作業の外）
2. `npm run build`・`npm run lint`・`npm run test:demo`・`node scripts/run-ui-test.mjs --preview`
3. `feature/demo-showcase` を push → Vercel の Preview で確認（`/audio/spatial-showcase.wav`・`/robots.txt`・`/sitemap.xml` が開けること、デモの読み込み・書き出し、Network に `*.vercel.app` 以外への通信がないこと）
4. `main` に統合して push → Production。問題があれば Instant Rollback
