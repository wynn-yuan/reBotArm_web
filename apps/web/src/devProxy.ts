/**
 * Vite 开发服务器后端代理目标解析（纯逻辑，node 环境可单测）。
 *
 * 契约（Phase 7A）：
 * - 默认后端 `http://127.0.0.1:8000`（与 server 的 REBOT_HOST/REBOT_PORT 默认一致）；
 * - `/api` HTTP 与 `/ws` WebSocket 一律代理到后端；
 * - 仅接受明确的 VITE_* 覆盖：
 *   - `VITE_API_PROXY_TARGET` → `/api` 的 HTTP 代理目标（http/https）；
 *   - `VITE_WS_PROXY_TARGET`  → `/ws` 的 WebSocket 代理目标（http/https/ws/wss）；
 *     未设置时由 API 目标推导（http→ws / https→wss）。
 * - 显式覆盖非法时抛错（fail closed）：宁可拒绝启动开发服务器，
 *   也绝不把请求静默代理到错误后端。
 *
 * 前端代码保持同源相对路径（API_BASE_URL='/api'，WS 走页面 origin 的 /ws），
 * 开发环境由本代理转发；生产环境由部署侧反代。
 */

/** 默认后端地址（server 默认 127.0.0.1:8000）。 */
export const DEFAULT_BACKEND_TARGET = 'http://127.0.0.1:8000';

export interface DevProxyTargets {
  /** /api HTTP 代理目标（http/https，含端口，不含尾斜杠） */
  api: string;
  /** /ws WebSocket 代理目标（http/https/ws/wss，含端口，不含尾斜杠） */
  ws: string;
}

/**
 * 解析并严格校验代理目标。
 * @param env 形如 `loadEnv(mode, root, 'VITE_')` 的环境变量映射
 * @throws Error 当显式覆盖值不是「协议+host」形式的绝对 URL，或携带路径（代理目标不允许路径）
 */
export function resolveDevProxyTargets(
  env: Record<string, string | undefined> = {},
): DevProxyTargets {
  const apiRaw = (env.VITE_API_PROXY_TARGET ?? '').trim();
  const wsRaw = (env.VITE_WS_PROXY_TARGET ?? '').trim();

  const api = apiRaw
    ? parseTarget(apiRaw, 'VITE_API_PROXY_TARGET', ['http:', 'https:'])
    : DEFAULT_BACKEND_TARGET;

  const ws = wsRaw
    ? parseTarget(wsRaw, 'VITE_WS_PROXY_TARGET', ['http:', 'https:', 'ws:', 'wss:'])
    : // 由 HTTP 目标推导 WebSocket 目标（同 host 同端口）
      api.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');

  return { api, ws };
}

function parseTarget(raw: string, name: string, allowedProtocols: string[]): string {
  const value = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} 配置无效：${raw}（应为带 host 的绝对 URL，如 http://127.0.0.1:8000）`);
  }
  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error(
      `${name} 配置无效：${raw}（协议必须是 ${allowedProtocols
        .map((p) => p.replace(':', ''))
        .join(' / ')} 之一）`,
    );
  }
  if (!url.host) {
    throw new Error(`${name} 配置无效：${raw}（缺少 host）`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`${name} 配置无效：${raw}（代理目标不允许携带路径）`);
  }
  return `${url.protocol}//${url.host}`;
}
