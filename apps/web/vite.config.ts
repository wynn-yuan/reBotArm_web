import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveDevProxyTargets } from './src/devProxy';

export default defineConfig(({ mode }) => {
  // 后端代理目标（Phase 7A）：默认 http://127.0.0.1:8000；
  // 明确的 VITE_* 覆盖：VITE_API_PROXY_TARGET（/api HTTP）、VITE_WS_PROXY_TARGET（/ws WebSocket）。
  // 非法的显式配置会在 resolveDevProxyTargets 中抛错（fail closed）。
  const proxy = resolveDevProxyTargets(loadEnv(mode, __dirname, 'VITE_'));

  return {
    publicDir: resolve(__dirname, '../../packages/robot-description/public'),
    plugins: [react()],
    server: {
      port: 5173,
      host: '0.0.0.0',
      proxy: {
        // HTTP API：同源 /api → 后端（前端默认 API_BASE_URL='/api'）
        '/api': { target: proxy.api, changeOrigin: true },
        // WebSocket 遥测：同源 /ws → 后端（必须启用 ws，否则 upgrade 不被转发）
        '/ws': { target: proxy.ws, ws: true, changeOrigin: true },
      },
    },
    preview: {
      port: 5173,
    },
  };
});
