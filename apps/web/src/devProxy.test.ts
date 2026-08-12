import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKEND_TARGET, resolveDevProxyTargets } from './devProxy';

describe('resolveDevProxyTargets —— 默认后端与 VITE_* 覆盖（Phase 7A）', () => {
  it('未配置任何变量 → 默认后端 http://127.0.0.1:8000，WS 目标自动推导为 ws://', () => {
    const t = resolveDevProxyTargets({});
    expect(t.api).toBe('http://127.0.0.1:8000');
    expect(t.ws).toBe('ws://127.0.0.1:8000');
    expect(DEFAULT_BACKEND_TARGET).toBe('http://127.0.0.1:8000');
  });

  it('空字符串视为未配置（仍用默认后端）', () => {
    const t = resolveDevProxyTargets({ VITE_API_PROXY_TARGET: '   ', VITE_WS_PROXY_TARGET: '' });
    expect(t.api).toBe('http://127.0.0.1:8000');
    expect(t.ws).toBe('ws://127.0.0.1:8000');
  });

  it('VITE_API_PROXY_TARGET 覆盖 HTTP 目标，WS 目标随之推导（http→ws）', () => {
    const t = resolveDevProxyTargets({ VITE_API_PROXY_TARGET: 'http://192.168.1.50:9000' });
    expect(t.api).toBe('http://192.168.1.50:9000');
    expect(t.ws).toBe('ws://192.168.1.50:9000');
  });

  it('https API 目标推导出 wss WS 目标', () => {
    const t = resolveDevProxyTargets({ VITE_API_PROXY_TARGET: 'https://robot.example.com' });
    expect(t.api).toBe('https://robot.example.com');
    expect(t.ws).toBe('wss://robot.example.com');
  });

  it('VITE_WS_PROXY_TARGET 显式覆盖 WS 目标（不影响 HTTP 目标）', () => {
    const t = resolveDevProxyTargets({
      VITE_API_PROXY_TARGET: 'http://127.0.0.1:8000',
      VITE_WS_PROXY_TARGET: 'ws://10.0.0.7:8001',
    });
    expect(t.api).toBe('http://127.0.0.1:8000');
    expect(t.ws).toBe('ws://10.0.0.7:8001');
  });

  it('WS 目标接受 http/https（由代理层完成 upgrade）', () => {
    expect(
      resolveDevProxyTargets({ VITE_WS_PROXY_TARGET: 'http://127.0.0.1:8000' }).ws,
    ).toBe('http://127.0.0.1:8000');
    expect(
      resolveDevProxyTargets({ VITE_WS_PROXY_TARGET: 'wss://robot.example.com' }).ws,
    ).toBe('wss://robot.example.com');
  });

  it('去除尾斜杠', () => {
    const t = resolveDevProxyTargets({ VITE_API_PROXY_TARGET: 'http://127.0.0.1:8000///' });
    expect(t.api).toBe('http://127.0.0.1:8000');
    expect(t.ws).toBe('ws://127.0.0.1:8000');
  });

  // ---- fail closed：显式覆盖非法时拒绝启动（抛错），绝不静默代理到错误目标 ----

  it('缺少协议 → 抛错', () => {
    expect(() => resolveDevProxyTargets({ VITE_API_PROXY_TARGET: '127.0.0.1:8000' })).toThrow(
      /VITE_API_PROXY_TARGET/,
    );
    expect(() => resolveDevProxyTargets({ VITE_WS_PROXY_TARGET: 'localhost:8000' })).toThrow(
      /VITE_WS_PROXY_TARGET/,
    );
  });

  it('ftp/file 等不允许的协议 → 抛错', () => {
    expect(() =>
      resolveDevProxyTargets({ VITE_API_PROXY_TARGET: 'ftp://127.0.0.1:8000' }),
    ).toThrow(/协议/);
    expect(() =>
      resolveDevProxyTargets({ VITE_WS_PROXY_TARGET: 'file:///tmp/x' }),
    ).toThrow(/协议/);
  });

  it('携带路径 → 抛错（代理目标不允许路径）', () => {
    expect(() =>
      resolveDevProxyTargets({ VITE_API_PROXY_TARGET: 'http://127.0.0.1:8000/api' }),
    ).toThrow(/路径/);
  });

  it('完全无法解析的 URL → 抛错', () => {
    expect(() => resolveDevProxyTargets({ VITE_API_PROXY_TARGET: '::not a url::' })).toThrow(
      /VITE_API_PROXY_TARGET/,
    );
  });
});
