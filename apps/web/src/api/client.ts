/**
 * 集中式后端 API client。
 *
 * 地址由 VITE_API_BASE_URL 配置，默认使用同源 `/api`。
 * 连接、人工 enable/disable、持久增益和后端零力矩状态机接口均在此集中管理。
 */
import type { HealthCapabilities, RecordedAction, RobotConnection, ZeroTorqueStatus } from '../types';
import { FAIL_CLOSED_CAPABILITIES } from '../types';

export const DEFAULT_API_BASE = '/api';

/** 从环境变量解析 API 基地址（去尾斜杠）；未配置时回退到同源 /api。 */
export function resolveApiBaseUrl(env: Record<string, string | undefined> = import.meta.env): string {
  const raw = env.VITE_API_BASE_URL;
  if (!raw || !raw.trim()) return DEFAULT_API_BASE;
  return raw.trim().replace(/\/+$/, '');
}

export const API_BASE_URL = resolveApiBaseUrl();

/**
 * 由 API 基地址推导遥测 WebSocket 地址。
 * 后端 WS 挂载在服务器根路径 /ws/robot/telemetry（不在 /api 下）。
 * - 同源 /api → 基于当前 location 的 origin + /ws/robot/telemetry
 * - 绝对地址 http(s)://host[/api] → ws(s)://host/ws/robot/telemetry
 */
export function resolveTelemetryWsUrl(
  apiBase: string = API_BASE_URL,
  locationOrigin: string = typeof window !== 'undefined' ? window.location.origin : '',
): string {
  const base = apiBase.trim().replace(/\/+$/, '');
  if (base.startsWith('http://') || base.startsWith('https://')) {
    const proto = base.startsWith('https') ? 'wss' : 'ws';
    const host = new URL(base).host;
    return `${proto}://${host}/ws/robot/telemetry`;
  }
  // 同源相对基地址（/api）
  const proto = locationOrigin.startsWith('https') ? 'wss' : 'ws';
  const host = locationOrigin.replace(/^https?:\/\//, '');
  return `${proto}://${host}/ws/robot/telemetry`;
}

/**
 * GET /api/health 响应契约（与后端 api.HealthResponse 逐字段对齐）。
 * simulation 模式下 motorbridge_* 为 null（绝不导入 SDK）；
 * capabilities 为后端在启动时确立的能力（fail-closed 兜底见 parseHealthCapabilities）。
 */
export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  adapter: string;
  channel: string;
  /** motorbridge SDK 版本；仅 adapter=motorbridge 时非 null */
  motorbridge_version: string | null;
  /** motorbridge 原生 ABI 版本；仅 adapter=motorbridge 时非 null */
  motorbridge_abi_version: string | null;
  capabilities: HealthCapabilities;
  time: string;
}

/** Fixed-root aging telemetry recording capability. */
export interface AgingLogStatus {
  enabled: boolean;
  root: string | null;
  min_free_bytes: number;
  segment_seconds: number;
  aging_execution_available: boolean;
  aging_recording_available: boolean;
}

export interface AgingRecordingStatus {
  available: boolean;
  status: 'inactive' | 'starting' | 'running' | 'stopping' | 'completed' | 'held' | 'error';
  phase: string;
  action_id: string | null;
  action_name: string | null;
  loop_mode: 'count' | 'duration' | 'infinite' | null;
  round: number;
  completed_rounds: number;
  target_rounds: number | null;
  stop_requested: boolean;
  recording_status: string;
  session_path: string | null;
  started_at: string | null;
  updated_at: string;
  frames_written: number;
  rows_written: number;
  error: string | null;
  root: string | null;
  recording_error: string | null;
  temp_limit_c: number | null;
  temp_protection: { joint: number; temperature_c: number; limit_c: number } | null;
  /** 已老化时间（秒），由后端运行时更新 */
  elapsed_seconds: number | null;
}

export interface AgingStartConfig {
  loop_mode: 'count' | 'duration' | 'infinite';
  loop_count?: number;
  duration_minutes?: number;
  interval_sec: number;
  /** 温度保护：任一关节 MOS 温度达到该值(°C)时自动停止并归位。可选，不传则不保护。 */
  temp_limit_c?: number;
}

export interface AgingLogDirectoriesResponse {
  path: string;
  directories: string[];
  aging_execution_available: false;
}

export interface AgingLogDirectoryCreateResponse {
  path: string;
  created: boolean;
  aging_execution_available: false;
}

/**
 * Validate a root-relative aging-log directory before it reaches the API.
 * The backend repeats this check; the client check keeps unsafe input visible.
 */
export function normalizeAgingLogPath(raw: string): string {
  const normalized = raw.trim().replace(/\\/g, '/');
  if (!normalized) return '';
  if (normalized.includes('\0')) throw new Error('日志目录不能为空或包含无效字符');
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')) {
    throw new Error('日志目录必须是日志根目录下的相对路径');
  }
  const path = normalized.replace(/\/+$/g, '');
  if (!path) return '';
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('日志目录不得包含空路径段、. 或 ..');
  }
  return parts.join('/');
}

/**
 * fail closed 解析后端 capabilities：仅当字段显式为布尔 true 才视为具备该能力；
 * 缺失 / 类型错误 / 非对象一律按无能力处理。scan 的兜底与前端
 * FAIL_CLOSED_CAPABILITIES 保持一致（只读扫描始终允许），其余能力默认 false。
 */
export function parseHealthCapabilities(raw: unknown): HealthCapabilities {
  const base: HealthCapabilities = { ...FAIL_CLOSED_CAPABILITIES, active_report_write: false };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;
  const pick = (key: keyof HealthCapabilities, fallback: boolean): boolean =>
    typeof r[key] === 'boolean' ? (r[key] as boolean) : fallback;
  return {
    scan: pick('scan', base.scan),
    telemetry: pick('telemetry', false),
    enable: pick('enable', false),
    control: pick('control', false),
    homing: pick('homing', false),
    disable: pick('disable', false),
    parameter_write: pick('parameter_write', false),
    persistent_gain_write: pick('persistent_gain_write', false),
    mit_gain_write: pick('mit_gain_write', false),
    set_zero: pick('set_zero', false),
    zero_torque: pick('zero_torque', false),
    active_report_write: pick('active_report_write', false),
  };
}

/**
 * 连接响应（connection / scan / disconnect）附带的 capabilities 严格解析：
 * 仅当字段为非数组对象时按 parseHealthCapabilities 同语义解析（只有显式布尔
 * true 才视为具备能力）；缺失 / null / 类型错误一律返回 undefined —— 由
 * connectionReducer 按 source fail-closed 派生，绝不因解析失败而获得能力。
 */
export function parseConnectionCapabilities(raw: unknown): HealthCapabilities | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  return parseHealthCapabilities(raw);
}

/**
 * 归一化后端连接快照：附带 capabilities 时严格解析后采用；
 * 未附带（或非法）时移除该字段，交由 connectionReducer 按 source 派生。
 */
export function normalizeConnection(
  raw: RobotConnection & { capabilities?: unknown },
): RobotConnection {
  const { capabilities, ...rest } = raw;
  const parsed = parseConnectionCapabilities(capabilities);
  return parsed ? { ...rest, capabilities: parsed } : rest;
}

/** 非 2xx 响应（含 409 与网络错误归一化后的对象）。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** POST /api/robot/scan 返回 409（扫描已在后端进行中）。 */
export class ScanInProgressError extends ApiError {
  constructor(message: string, code?: string) {
    super(message, 409, code);
    this.name = 'ScanInProgressError';
  }
}

/** 把任意异常归一化为可显示的中文错误消息。 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return `网络错误：${err.message}`;
  return '网络错误：无法连接后端';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: init?.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch (err) {
    // fetch 网络层异常（连接被拒 / 超时 / 后端未启动）
    throw new ApiError(
      err instanceof Error ? `网络错误：${err.message}` : '网络错误：无法连接后端',
      0,
    );
  }

  if (!res.ok) {
    let message = `请求失败（HTTP ${res.status}）`;
    let code: string | undefined;
    try {
      const body: unknown = await res.json();
      const errBody = (body as { error?: { code?: string; message?: string } })?.error;
      if (errBody?.message) message = errBody.message;
      if (errBody?.code) code = errBody.code;
    } catch {
      // 非 JSON 响应体，保留默认消息
    }
    if (res.status === 409) throw new ScanInProgressError(message, code);
    throw new ApiError(message, res.status, code);
  }
  return res.json() as Promise<T>;
}

export async function getHealth(): Promise<HealthResponse> {
  const raw = await request<HealthResponse>('/health');
  // fail closed：不信任后端字段类型，capabilities 一律经严格解析归一化
  return { ...raw, capabilities: parseHealthCapabilities(raw.capabilities) };
}

/** GET /api/robot/connection —— 恢复后端连接状态（capabilities 严格解析）。 */
export async function getConnection(): Promise<RobotConnection> {
  const raw = await request<RobotConnection & { capabilities?: unknown }>('/robot/connection');
  return normalizeConnection(raw);
}

/** POST /api/robot/scan —— 运行一次只读扫描（阻塞至完成；409 若已在扫描）。 */
export async function postScan(): Promise<RobotConnection> {
  const raw = await request<RobotConnection & { capabilities?: unknown }>('/robot/scan', {
    method: 'POST',
  });
  return normalizeConnection(raw);
}

/** POST /api/robot/disconnect —— 清除服务端连接状态（不下发任何电机指令）。 */
export async function postDisconnect(): Promise<RobotConnection> {
  const raw = await request<RobotConnection & { capabilities?: unknown }>('/robot/disconnect', {
    method: 'POST',
  });
  return normalizeConnection(raw);
}

export interface ManualActionResult {
  ok: boolean;
  operation: 'enable_all' | 'disable_all';
  channel: string;
  motor_ids: number[];
  completed_at: string;
}

/** User-confirmed manual writes; backend rejects confirm !== true. */
export async function postEnable(): Promise<ManualActionResult> {
  return request<ManualActionResult>('/robot/enable', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  });
}

export async function postDisable(): Promise<ManualActionResult> {
  return request<ManualActionResult>('/robot/disable', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  });
}

export interface PersistentGainWriteChange {
  motor_id: number;
  kp: number;
  kd: number;
}

export interface PersistentGainWriteResult {
  ok: boolean;
  operation: 'persistent_gain_write';
  channel: string;
  motor_ids: number[];
  parameter_ids: Record<string, number>;
  completed_at: string;
}

export async function postPersistentGains(
  changes: PersistentGainWriteChange[],
): Promise<PersistentGainWriteResult> {
  return request<PersistentGainWriteResult>('/robot/parameters/gains', {
    method: 'POST',
    body: JSON.stringify({ confirm: true, changes }),
  });
}

export interface MechanicalZeroResult {
  ok: boolean;
  operation: 'set_mechanical_zero';
  channel: string;
  motor_ids: number[];
  parameter_id: number;
  previous_positions: Record<string, number | null>;
  completed_at: string;
}

export async function postMechanicalZero(): Promise<MechanicalZeroResult> {
  return request<MechanicalZeroResult>('/robot/parameters/zero', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  });
}

export async function getZeroTorqueStatus(): Promise<ZeroTorqueStatus> {
  return request<ZeroTorqueStatus>('/robot/zero-torque/status');
}

export async function postZeroTorqueStart(): Promise<ZeroTorqueStatus> {
  return request<ZeroTorqueStatus>('/robot/zero-torque/start', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  });
}

export async function postZeroTorqueStop(): Promise<ZeroTorqueStatus> {
  return request<ZeroTorqueStatus>('/robot/zero-torque/stop', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  });
}

/** GET /api/aging/logs — fixed persistence root. */
export async function getAgingLogStatus(): Promise<AgingLogStatus> {
  return request<AgingLogStatus>('/aging/logs');
}

export async function getAgingRecordingStatus(): Promise<AgingRecordingStatus> {
  return request<AgingRecordingStatus>('/aging/status');
}

export async function startAgingRecording(
  actionId: string,
  config: AgingStartConfig,
): Promise<AgingRecordingStatus> {
  // The action is referenced by id; the backend loads it from the Trajectory
  // directory (single source of truth) and executes it.
  return request<AgingRecordingStatus>('/aging/start', {
    method: 'POST',
    body: JSON.stringify({ confirm: true, action_id: actionId, config }),
  });
}

export async function stopAgingRecording(): Promise<AgingRecordingStatus> {
  return request<AgingRecordingStatus>('/aging/stop', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  });
}

/** Runtime guard for a recorded action returned by the backend action library. */
function isProcessedAction(raw: unknown): raw is RecordedAction {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as RecordedAction;
  return typeof r.id === 'string'
    && typeof r.name === 'string'
    && Array.isArray(r.trails)
    && r.trails.length === 7
    && r.trails.every(
      (trail) => Array.isArray(trail) && trail.every((value) => typeof value === 'number' && Number.isFinite(value)),
    );
}

/** GET /api/aging/actions — 后端动作库全部动作（含完整轨迹，供老化调用）。 */
export async function getAgingActions(): Promise<RecordedAction[]> {
  const raw = await request<{ actions: unknown[] }>('/aging/actions');
  return Array.isArray(raw.actions) ? raw.actions.filter(isProcessedAction) : [];
}

/** POST /api/aging/actions — 把 processed 动作持久化到后端动作库。 */
export async function saveAgingAction(action: RecordedAction): Promise<RecordedAction> {
  const raw = await request<{ action: unknown }>('/aging/actions', {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
  return isProcessedAction(raw.action) ? raw.action : action;
}

/** DELETE /api/aging/actions/{id} — 从后端动作库删除动作。 */
export async function deleteAgingAction(id: string): Promise<void> {
  await request(`/aging/actions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** GET /api/aging/logs/directories — list immediate children under a safe relative path. */
export async function getAgingLogDirectories(path = ''): Promise<AgingLogDirectoriesResponse> {
  const safePath = normalizeAgingLogPath(path);
  const query = new URLSearchParams();
  query.set('path', safePath);
  const response = await request<AgingLogDirectoriesResponse>(`/aging/logs/directories?${query.toString()}`);
  if (response.aging_execution_available !== false) {
    throw new ApiError('后端日志目录接口未通过执行能力安全校验', 502, 'aging_execution_not_closed');
  }
  return response;
}

/** POST /api/aging/logs/directories — create a root-relative directory only. */
export async function createAgingLogDirectory(path: string): Promise<AgingLogDirectoryCreateResponse> {
  const safePath = normalizeAgingLogPath(path);
  if (!safePath) throw new Error('请输入要创建的相对目录');
  const response = await request<AgingLogDirectoryCreateResponse>('/aging/logs/directories', {
    method: 'POST',
    body: JSON.stringify({ path: safePath }),
  });
  if (response.aging_execution_available !== false) {
    throw new ApiError('后端目录创建接口未通过执行能力安全校验', 502, 'aging_execution_not_closed');
  }
  return response;
}
