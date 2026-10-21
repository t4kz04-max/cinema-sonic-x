import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // export-frame.html: 書き出し用の使い捨てフレーム（Phase 06）。本番ビルドにも含める
      input: {
        main: resolve(__dirname, 'index.html'),
        exportFrame: resolve(__dirname, 'export-frame.html'),
        // analysis-frame.html: 解析用のフレーム（Phase 09。しばらく使わないと削除してメモリを返す）
        analysisFrame: resolve(__dirname, 'analysis-frame.html'),
      },
    },
  },
})
