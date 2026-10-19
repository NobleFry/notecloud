import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // 开发环境把 /api 代理到 Fastify，前端只写相对路径，
    // 这样 cookie（SameSite=Lax）与 CORS 都是同源行为，和生产一致
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
        // WebSocket 也要走代理，否则 /api/v1/ws 连不上
        ws: true,
      },
    },
  },
  build: {
    // 编辑器 chunk（CodeMirror + markdown-it + highlight.js）约 530KB，
    // 但它是按需加载的独立包（打开笔记时才拉），不影响首屏。
    // 默认 500KB 的告警在这里属于噪音，调高到 700KB。
    chunkSizeWarningLimit: 700,
  },
});
