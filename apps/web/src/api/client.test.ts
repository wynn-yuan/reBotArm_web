import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  API_BASE_URL,
  ScanInProgressError,
  getConnection,
  getAgingLogDirectories,
  getAgingLogStatus,
  getAgingActions,
  saveAgingAction,
  deleteAgingAction,
  startAgingRecording,
  createAgingLogDirectory,
  getHealth,
  postScan,
  postDisconnect,
  normalizeConnection,
  parseConnectionCapabilities,
  parseHealthCapabilities,
  resolveApiBaseUrl,
  resolveTelemetryWsUrl,
  normalizeAgingLogPath,
  toErrorMessage,
  type HealthResponse,
} from './client';
import type { HealthCapabilities } from '../types';
import type { RobotConnection } from '../types';

// 清空 fetch stub，避免测试间串扰
afterEach(() => {
  vi.unstubAllGlobals();
});

const OK_CONNECTION: RobotConnection = {
  status: 'connected',
  channel: 'can0',
  expected_ids: [1, 2, 3, 4, 5, 6, 7],
  found_ids: [1, 2, 3, 4, 5, 6, 7],
  missing_ids: [],
  started_at: '2026-08-08T00:00:00+00:00',
  completed_at: '2026-08-08T00:00:01+00:00',
  source: 'simulation',
  message: 'All 7 expected motors responded on can0',
};

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('resolveApiBaseUrl', () => {
  it('默认回退到同源 /api', () => {
    expect(resolveApiBaseUrl({})).toBe('/api');
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: '' })).toBe('/api');
  });

  it('使用 VITE_API_BASE_URL 并去除尾斜杠', () => {
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: 'http://127.0.0.1:8000/' })).toBe('http://127.0.0.1:8000');
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: 'http://x:8000/api///' })).toBe('http://x:8000/api');
  });
});

describe('resolveTelemetryWsUrl', () => {
  it('http API 基址映射为 ws://…/ws/robot/telemetry', () => {
    expect(resolveTelemetryWsUrl('http://127.0.0.1:8000')).toBe('ws://127.0.0.1:8000/ws/robot/telemetry');
    expect(resolveTelemetryWsUrl('http://127.0.0.1:8000/')).toBe('ws://127.0.0.1:8000/ws/robot/telemetry');
  });

  it('https API 基址映射为 wss://', () => {
    expect(resolveTelemetryWsUrl('https://robot.example.com')).toBe('wss://robot.example.com/ws/robot/telemetry');
  });

  it('相对基址（同源 /api）回退到页面 origin', () => {
    expect(resolveTelemetryWsUrl('/api', 'http://localhost:5173')).toBe('ws://localhost:5173/ws/robot/telemetry');
    expect(resolveTelemetryWsUrl('/api', 'https://localhost:5173')).toBe('wss://localhost:5173/ws/robot/telemetry');
  });
});

describe('API client 请求', () => {
  it('getConnection 发起 GET /robot/connection', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(OK_CONNECTION));
    stubFetch(fetchFn);
    const conn = await getConnection();
    expect(conn).toEqual(OK_CONNECTION);
    expect(fetchFn).toHaveBeenCalledWith(
      `${API_BASE_URL}/robot/connection`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('postScan 发起 POST /robot/scan', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(OK_CONNECTION));
    stubFetch(fetchFn);
    const conn = await postScan();
    expect(conn.status).toBe('connected');
    expect(fetchFn).toHaveBeenCalledWith(
      `${API_BASE_URL}/robot/scan`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('postDisconnect 发起 POST /robot/disconnect', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ...OK_CONNECTION, status: 'disconnected', found_ids: [], missing_ids: [1, 2, 3, 4, 5, 6, 7] }));
    stubFetch(fetchFn);
    const conn = await postDisconnect();
    expect(conn.status).toBe('disconnected');
    expect(fetchFn).toHaveBeenCalledWith(
      `${API_BASE_URL}/robot/disconnect`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('409 扫描进行中 → 抛 ScanInProgressError', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse(
          { error: { code: 'scan_in_progress', message: 'A CAN scan is already in progress' } },
          409,
        ),
      ),
    );
    await expect(postScan()).rejects.toBeInstanceOf(ScanInProgressError);
    await expect(postScan()).rejects.toMatchObject({ status: 409, code: 'scan_in_progress' });
  });

  it('网络错误 → 抛 ApiError(status 0) 且不伪装成已连接', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(getConnection()).rejects.toBeInstanceOf(ApiError);
    await expect(getConnection()).rejects.toMatchObject({ status: 0 });
  });

  it('非 2xx（如 500）→ 抛 ApiError 并保留状态码', async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ detail: 'boom' }, 500)));
    await expect(postScan()).rejects.toBeInstanceOf(ApiError);
    await expect(postScan()).rejects.toMatchObject({ status: 500 });
  });
});

describe('aging log API', () => {
  it('严格规范化日志根目录下的相对路径', () => {
    expect(normalizeAgingLogPath('  bench\\nightly/  ')).toBe('bench/nightly');
    expect(normalizeAgingLogPath('')).toBe('');
    expect(() => normalizeAgingLogPath('../escape')).toThrow();
    expect(() => normalizeAgingLogPath('/outside')).toThrow();
    expect(() => normalizeAgingLogPath('C:/outside')).toThrow();
    expect(() => normalizeAgingLogPath('bench/../escape')).toThrow();
  });

  it('status 返回后端实际执行能力', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        enabled: false,
        root: null,
        min_free_bytes: 100,
        segment_seconds: 300,
        aging_execution_available: false,
        message: 'aging execution is not exposed',
      }),
    );
    stubFetch(fetchFn);
    await expect(getAgingLogStatus()).resolves.toMatchObject({
      enabled: false,
      aging_execution_available: false,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      `${API_BASE_URL}/aging/logs`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('接受后端明确开放 aging execution', async () => {
    stubFetch(() => Promise.resolve(jsonResponse({
      enabled: true,
      root: '/safe/logs',
      min_free_bytes: 100,
      segment_seconds: 300,
      aging_execution_available: true,
      message: 'unexpected',
    })));
    await expect(getAgingLogStatus()).resolves.toMatchObject({ aging_execution_available: true });
  });

  it('启动时按 action_id 引用 Trajectory 动作与循环配置', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: 'running' }));
    stubFetch(fetchFn);
    await startAgingRecording('processed-1', { loop_mode: 'count', loop_count: 3, interval_sec: 2 });
    expect(fetchFn).toHaveBeenCalledWith(
      `${API_BASE_URL}/aging/start`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ confirm: true, action_id: 'processed-1', config: { loop_mode: 'count', loop_count: 3, interval_sec: 2 } }),
      }),
    );
  });

  it('directories 使用 URLSearchParams 编码相对路径', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ path: 'bench/night 1', directories: ['run-a'], aging_execution_available: false }),
    );
    stubFetch(fetchFn);
    await getAgingLogDirectories('bench/night 1');
    expect(fetchFn).toHaveBeenCalledWith(
      `${API_BASE_URL}/aging/logs/directories?path=bench%2Fnight+1`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getAgingActions 拉取后端动作库并过滤非法项', async () => {
    const valid = {
      id: 'processed-1', name: '动作', createdAt: 1, durationMs: 40,
      sampleCount: 2, samplingHz: 50, jointCount: 7,
      trails: Array.from({ length: 7 }, () => [0, 0.01]),
      version: 'processed' as const,
      rawActionId: 'raw-1',
    };
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ actions: [valid, { id: 'bad', trails: 'nope' }, null] }),
    );
    stubFetch(fetchFn);
    const actions = await getAgingActions();
    expect(fetchFn).toHaveBeenCalledWith(
      `${API_BASE_URL}/aging/actions`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(actions).toEqual([valid]);
  });

  it('saveAgingAction POST 动作到后端动作库', async () => {
    const action = {
      id: 'processed-9', name: '抓取', createdAt: 1, durationMs: 40,
      sampleCount: 2, samplingHz: 50, jointCount: 7,
      trails: Array.from({ length: 7 }, () => [0, 0.01]),
      version: 'processed' as const,
      rawActionId: 'raw-9',
    };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ action }));
    stubFetch(fetchFn);
    const saved = await saveAgingAction(action);
    expect(fetchFn).toHaveBeenCalledWith(
      `${API_BASE_URL}/aging/actions`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action }),
      }),
    );
    expect(saved.id).toBe('processed-9');
  });

  it('deleteAgingAction DELETE 并编码动作 id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ deleted: true }));
    stubFetch(fetchFn);
    await deleteAgingAction('processed-1/x');
    expect(fetchFn).toHaveBeenCalledWith(
      `${API_BASE_URL}/aging/actions/processed-1%2Fx`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('create directory 只发送规范化的根相对路径', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ path: 'bench/nightly', created: true, aging_execution_available: false }),
    );
    stubFetch(fetchFn);
    await createAgingLogDirectory('bench\\nightly');
    expect(fetchFn).toHaveBeenCalledWith(
      `${API_BASE_URL}/aging/logs/directories`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: 'bench/nightly' }),
      }),
    );
    await expect(createAgingLogDirectory('../escape')).rejects.toThrow();
  });
});

describe('toErrorMessage', () => {
  it('归一化 ApiError / 网络错误', () => {
    expect(toErrorMessage(new ScanInProgressError('busy'))).toBe('busy');
    expect(toErrorMessage(new Error('conn refused'))).toContain('网络错误');
    expect(toErrorMessage('x')).toContain('网络错误');
  });
});

describe('health / capabilities 前后端契约（Phase 7A）', () => {
  const SIM_CAPS: HealthCapabilities = {
    scan: true,
    telemetry: true,
    enable: false,
    control: false,
    homing: false,
    disable: false,
    parameter_write: false,
    persistent_gain_write: false,
    mit_gain_write: false,
    set_zero: false,
    zero_torque: false,
    active_report_write: false,
  };

  it('getHealth 解析完整契约（含 capabilities 与 motorbridge 版本字段）', async () => {
    const health: HealthResponse = {
      status: 'ok',
      service: 'rebot-server',
      version: '0.1.0',
      adapter: 'simulation',
      channel: 'can0',
      motorbridge_version: null,
      motorbridge_abi_version: null,
      capabilities: SIM_CAPS,
      time: '2026-08-08T00:00:00+00:00',
    };
    stubFetch(() => Promise.resolve(jsonResponse(health)));
    await expect(getHealth()).resolves.toEqual(health);
  });

  it('getHealth 对后端 capabilities 做 fail-closed 归一化（不信任字段类型）', async () => {
    // 后端把 control 发成了字符串 "true"、telemetry 发成了 1 —— 都不是布尔 true
    const body = {
      status: 'ok',
      service: 'rebot-server',
      version: '0.1.0',
      adapter: 'motorbridge',
      channel: 'can0',
      motorbridge_version: '0.5.1',
      motorbridge_abi_version: 'fake-abi-0.5.1',
      capabilities: { scan: true, control: 'true', telemetry: 1, active_report_write: 'yes' },
      time: '2026-08-08T00:00:00+00:00',
    };
    stubFetch(() => Promise.resolve(jsonResponse(body)));
    const health = await getHealth();
    expect(health.capabilities.control).toBe(false); // "true" ≠ true
    expect(health.capabilities.telemetry).toBe(false); // 1 ≠ true
    expect(health.capabilities.active_report_write).toBe(false); // "yes" ≠ true
    expect(health.capabilities.scan).toBe(true);
  });

  it('parseHealthCapabilities：缺失 / null / 非对象 → fail closed（scan 兜底 true，其余 false）', () => {
    for (const raw of [undefined, null, 'x', 42, [], {}]) {
      const caps = parseHealthCapabilities(raw);
      expect(caps.scan).toBe(true); // 与 FAIL_CLOSED_CAPABILITIES 一致：只读扫描允许
      expect(caps.telemetry).toBe(false);
      expect(caps.control).toBe(false);
      expect(caps.homing).toBe(false);
      expect(caps.disable).toBe(false);
      expect(caps.parameter_write).toBe(false);
      expect(caps.active_report_write).toBe(false);
    }
  });

  it('parseHealthCapabilities：仅显式布尔 true 才开启能力', () => {
    const caps = parseHealthCapabilities({
      scan: true,
      telemetry: true,
      control: false,
      active_report_write: true,
    });
    expect(caps.telemetry).toBe(true);
    expect(caps.active_report_write).toBe(true);
    expect(caps.control).toBe(false);
    expect(caps.homing).toBe(false);
  });
});

describe('连接响应携带 capabilities（Phase 7H：HDMI 页面遥测门禁修复）', () => {
  const MOTORBRIDGE_CAPS: HealthCapabilities = {
    scan: true,
    telemetry: true,
    enable: true,
    control: false,
    homing: false,
    disable: false,
    parameter_write: false,
    persistent_gain_write: false,
    mit_gain_write: false,
    set_zero: false,
    zero_torque: false,
    active_report_write: true,
  };

  it('getConnection 采用后端返回的 capabilities（motorbridge 遥测门开启）', async () => {
    stubFetch(() =>
      Promise.resolve(jsonResponse({ ...OK_CONNECTION, source: 'motorbridge', capabilities: MOTORBRIDGE_CAPS })),
    );
    const conn = await getConnection();
    expect(conn.source).toBe('motorbridge');
    expect(conn.capabilities).toEqual(MOTORBRIDGE_CAPS);
    expect(conn.capabilities?.telemetry).toBe(true);
    expect(conn.capabilities?.control).toBe(false);
  });

  it('postScan / postDisconnect 同样归一化 capabilities', async () => {
    stubFetch(() =>
      Promise.resolve(jsonResponse({ ...OK_CONNECTION, source: 'motorbridge', capabilities: MOTORBRIDGE_CAPS })),
    );
    expect((await postScan()).capabilities).toEqual(MOTORBRIDGE_CAPS);
    expect((await postDisconnect()).capabilities).toEqual(MOTORBRIDGE_CAPS);
  });

  it('后端未返回 capabilities → 字段缺失（交由 reducer 按 source fail-closed 派生）', async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ ...OK_CONNECTION, source: 'motorbridge' })));
    const conn = await getConnection();
    expect(conn.capabilities).toBeUndefined();
  });

  it('capabilities 类型错误（非对象）→ 丢弃且 fail closed，绝不因解析失败获得能力', async () => {
    for (const bad of [null, 'all', 42, [], true]) {
      stubFetch(() =>
        Promise.resolve(jsonResponse({ ...OK_CONNECTION, source: 'motorbridge', capabilities: bad })),
      );
      const conn = await getConnection();
      expect(conn.capabilities).toBeUndefined();
    }
  });

  it('capabilities 字段值非布尔 → 严格解析（只有显式 true 才算能力）', async () => {
    stubFetch(() =>
      Promise.resolve(
        jsonResponse({
          ...OK_CONNECTION,
          source: 'motorbridge',
          capabilities: { telemetry: 'true', control: 1, scan: true },
        }),
      ),
    );
    const conn = await getConnection();
    expect(conn.capabilities?.telemetry).toBe(false); // "true" ≠ true
    expect(conn.capabilities?.control).toBe(false); // 1 ≠ true
    expect(conn.capabilities?.scan).toBe(true);
  });

  it('parseConnectionCapabilities：对象 → 严格解析；其余 → undefined', () => {
    expect(parseConnectionCapabilities(MOTORBRIDGE_CAPS)).toEqual(MOTORBRIDGE_CAPS);
    for (const bad of [undefined, null, 'x', 42, [], true]) {
      expect(parseConnectionCapabilities(bad)).toBeUndefined();
    }
  });

  it('normalizeConnection 不移除后端其余字段', () => {
    const conn = normalizeConnection({ ...OK_CONNECTION, capabilities: MOTORBRIDGE_CAPS });
    expect(conn.status).toBe(OK_CONNECTION.status);
    expect(conn.found_ids).toEqual(OK_CONNECTION.found_ids);
    expect(conn.capabilities).toEqual(MOTORBRIDGE_CAPS);
  });
});
