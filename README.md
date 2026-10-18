# CINEMA SONIC X

ブラウザ完結型の重低音強化Webアプリ（開発中: Phase 01）。音源はブラウザ内でのみ処理され、外部へ送信されません。

```bash
npm install
npm run dev     # 開発サーバー
npm run build   # 型チェック + ビルド
npm run lint    # oxlint
npm run test:dsp      # 重低音エンジンの DSP 自己診断（ヘッドレス Chrome/Edge）
npm run test:spatial  # 空間音響プロトタイプの自己診断
```

- 開発ルール: [CLAUDE.md](CLAUDE.md)
- 開発計画: [docs/PHASES.md](docs/PHASES.md)
- 空間音響プロトタイプ: [docs/SPATIAL.md](docs/SPATIAL.md)
