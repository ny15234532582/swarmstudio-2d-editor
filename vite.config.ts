import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    host: true,
  },
  // SQLite WASM 通过 new URL('sqlite3.wasm', import.meta.url) 定位 wasm 文件，
  // 交给 Vite 处理资源即可；不能走 esbuild 预打包，否则 URL 会被改写错误。
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  worker: {
    format: 'es',
  },
})
