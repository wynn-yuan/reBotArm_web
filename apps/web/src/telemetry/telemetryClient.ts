import { RingBuffer } from './ringBuffer';
import { TELEMETRY_EXPECTED_IDS } from './jointMap';
import type {
  CommStats,
  LiveJoint,
  RobotCapabilities,
  RobotConnectionStatus,
  TelemetryFrame,
  TrendMetric,
  TrendPoint,
  TrendSeries,
  WsTelemetryStatus,
} from '../types';

/**
 * 只读 WebSocket 遥测客户端（/ws/robot/telemetry）。
 *
 * 与 React 完全解耦，便于在 node 环境下用注入的 WebSocket/时钟进行单元测试。
 * 语义约束：
 * - 仅当 shouldOpenTelemetry() 为真（connected + capabilities.telemetry）时才允许 start()；
 * - stop() 之后绝不重连（robot 断开 / 页面卸载 / 连接失效）；
 * - 网络中断采用有上限的指数退避重连；耗尽 maxAttempts 后真正停止重连（fail
 *   closed，进入 error 终态），仅能通过显式 restart() 恢复，绝不无限重连；
 * - 帧经过严格运行时校验（source / channel / units / 7 个唯一 ID / 数值有限性 /
 *   sequence / freshness）；任一不合法的帧整体丢弃，绝不污染已建立的遥测状态；
 * - WebSocket 错误只更新遥测状态，绝不改变 robot connection（要求 17）；
 * - sequence 用于丢帧（跳号）与乱序（回退/重复）检测；
 * - 超过 staleMs 未收到帧 → 数据陈旧：保留最后一帧但标记 stale，消费方不得当作实时状态；
 * - 趋势点写入固定容量环形缓冲，长时间运行内存不增长。
 *
 * 趋势降采样（任务 6）：
 * - 实时监控（frame/joints/comm）仍按全帧率更新；
 * - 趋势缓冲按时间戳降采样：每个「关节:指标」键最多每 trendMinIntervalMs
 *   （默认 100ms，即 ≤10Hz）写入 1 点；
 * - 容量 3600 × 100ms ≈ 6 分钟，50Hz 输入下 2 分钟时间窗（1200 点）完整保留；
 * - 通信频率 / 丢帧率 / 乱序统计仍由全帧率帧计算，不受降采样影响；
 * - trendVersion 只在确实写入趋势点时递增 → 图表重绘 ≤10Hz。
 */

/** 与真实 WebSocket 结构兼容的最小接口（便于测试注入）。 */
export interface WebSocketLike {
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface TelemetryClientOptions {
  /** WebSocket 地址（/ws/robot/telemetry） */
  url: string;
  /** 数据陈旧阈值（ms），默认 1500 */
  staleMs?: number;
  /** 重连指数退避起点（ms），默认 500 */
  baseBackoffMs?: number;
  /** 重连退避上限（ms），默认 10000 */
  maxBackoffMs?: number;
  /** 退避指数增长的最大尝试次数，默认 8 */
  maxAttempts?: number;
  /** 陈旧检查节拍（ms），默认 500 */
  staleCheckMs?: number;
  /** 趋势环形缓冲容量，默认 3600（10Hz 降采样下 ≈ 6 分钟） */
  ringCapacity?: number;
  /** 趋势降采样最小写入间隔（ms），默认 100（每键 ≤10Hz） */
  trendMinIntervalMs?: number;
  /** 注入时钟（测试用），默认 Date.now */
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => number;
  clearTimeoutFn?: (id: number) => void;
  setIntervalFn?: (fn: () => void, ms: number) => number;
  clearIntervalFn?: (id: number) => void;
  /** 注入 WebSocket 构造器（测试用），默认全局 WebSocket */
  webSocketFactory?: WebSocketFactory;
  /** 状态变化回调（React Provider 用于 setState） */
  onChange?: (state: TelemetryClientState) => void;
}

export interface TelemetryClientState {
  frame: TelemetryFrame | null;
  joints: LiveJoint[];
  comm: CommStats;
  stale: boolean;
  status: WsTelemetryStatus;
  /** 趋势版本号：仅在确实写入趋势点时递增（降采样后 ≤10Hz），供图表订阅重渲染 */
  trendVersion: number;
}

function emptyComm(): CommStats {
  return { freq: 0, latencyMs: 0, dropRate: 0, seqErrors: 0, lastSeq: null, lastArrivalMs: null };
}

export function initialTelemetryState(): TelemetryClientState {
  return {
    frame: null,
    joints: [],
    comm: emptyComm(),
    stale: false,
    status: 'idle',
    trendVersion: 0,
  };
}

/**
 * 遥测自动连接门禁：只有「已连接」且「capabilities.telemetry === true」才允许打开 WebSocket。
 * 能力缺失（fail closed）或任何非 connected 状态一律不连接。
 */
export function shouldOpenTelemetry(conn: {
  status: RobotConnectionStatus;
  capabilities: Pick<RobotCapabilities, 'telemetry'>;
}): boolean {
  return conn.status === 'connected' && conn.capabilities.telemetry === true;
}

const NULL_JOINT: LiveJoint = {
  id: 0,
  position: null,
  velocity: null,
  torque: null,
  tempMos: null,
  tempRotor: null,
  statusCode: null,
  freshness: 'none',
};

/**
 * 从一帧遥测构建 ID 1..7 的实时关节值。
 * 缺失关节 / null 字段原样保持 null（绝不伪造或沿用模拟数据）。
 */
export function buildLiveJoints(frame: TelemetryFrame): LiveJoint[] {
  return TELEMETRY_EXPECTED_IDS.map((id) => {
    const j = frame.joints.find((x) => x.id === id);
    if (!j) return { ...NULL_JOINT, id };
    return {
      id,
      position: j.position,
      velocity: j.velocity,
      torque: j.torque,
      tempMos: j.temperature?.mos ?? null,
      tempRotor: j.temperature?.rotor ?? null,
      statusCode: j.status_code,
      freshness: j.freshness,
    };
  });
}

function defaultFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

// ===== 严格帧校验（Phase 7A） =====
// 遥测帧在写入任何状态之前必须通过下列运行时校验；任一不合法 → 整帧丢弃，
// 绝不污染 sequence / 通信统计 / 关节值 / 趋势缓冲（宁可无数据，不要坏数据）。

/** 合法的数据来源（与后端 telemetry.SOURCE_* 一致）。 */
const TELEMETRY_SOURCES: readonly string[] = ['simulation', 'motorbridge'];
/** 帧契约的物理单位（与后端 telemetry.UNITS 一致，禁止单位漂移）。 */
const TELEMETRY_UNITS: Record<string, string> = {
  position: 'rad',
  velocity: 'rad/s',
  torque: 'Nm',
  temperature: 'degC',
};
/** CAN 通道命名（与后端 config.CHANNEL_PATTERN 一致）。 */
const CHANNEL_PATTERN = /^can[0-9]+$/;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 数值字段：允许 null（缺失/未报告），否则必须是有限 number（拒绝 NaN/Inf/字符串）。 */
function isNullOrFiniteNumber(v: unknown): boolean {
  return v === null || isFiniteNumber(v);
}

/**
 * 严格校验一帧遥测。合法返回原帧，否则返回 null。
 * 校验项：顶层形状 / timestamp / sequence / channel / source / units 精确匹配 /
 * joints 恰为 7 个且 ID 唯一且覆盖 1..7 / 各数值有限性 / freshness 合法。
 */
export function validateTelemetryFrame(raw: unknown): TelemetryFrame | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;

  if (typeof f.timestamp !== 'string' || f.timestamp.length === 0) return null;
  if (!Number.isInteger(f.sequence) || (f.sequence as number) < 0) return null;
  if (typeof f.channel !== 'string' || !CHANNEL_PATTERN.test(f.channel)) return null;
  if (typeof f.source !== 'string' || !TELEMETRY_SOURCES.includes(f.source)) return null;

  // units 必须与契约精确一致（防止把角度当弧度等单位漂移风险）：
  // 4 个键的值逐一对齐，且不允许携带多余键（与后端 telemetry.UNITS 完全一致）。
  const units = f.units;
  if (typeof units !== 'object' || units === null || Array.isArray(units)) return null;
  const u = units as Record<string, unknown>;
  for (const key of Object.keys(TELEMETRY_UNITS)) {
    if (u[key] !== TELEMETRY_UNITS[key]) return null;
  }
  if (Object.keys(u).length !== Object.keys(TELEMETRY_UNITS).length) return null;

  // joints 必须是恰好 7 个、ID 唯一且完整覆盖期望 ID 1..7 的数组。
  if (!Array.isArray(f.joints)) return null;
  if (f.joints.length !== TELEMETRY_EXPECTED_IDS.length) return null;
  const seen = new Set<number>();
  for (const entry of f.joints) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const j = entry as Record<string, unknown>;
    if (!Number.isInteger(j.id)) return null;
    const id = j.id as number;
    if (!TELEMETRY_EXPECTED_IDS.includes(id)) return null;
    if (seen.has(id)) return null; // 重复 ID
    seen.add(id);

    if (!isNullOrFiniteNumber(j.position)) return null;
    if (!isNullOrFiniteNumber(j.velocity)) return null;
    if (!isNullOrFiniteNumber(j.torque)) return null;

    // temperature 恒为对象 {mos, rotor}（与后端契约一致），各分量 null 或有限数值。
    const temp = j.temperature;
    if (typeof temp !== 'object' || temp === null || Array.isArray(temp)) return null;
    const t = temp as Record<string, unknown>;
    if (!isNullOrFiniteNumber(t.mos)) return null;
    if (!isNullOrFiniteNumber(t.rotor)) return null;

    if (!isNullOrFiniteNumber(j.status_code)) return null;
    if (j.freshness !== 'fresh' && j.freshness !== 'none') return null;
  }
  // 覆盖校验：7 个唯一且都在期望集内 ⇒ 恰好覆盖 1..7。
  if (seen.size !== TELEMETRY_EXPECTED_IDS.length) return null;

  return raw as TelemetryFrame;
}

export class TelemetryClient {
  private readonly url: string;
  private readonly staleMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;
  private readonly staleCheckMs: number;
  private readonly ringCapacity: number;
  private readonly trendMinIntervalMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => number;
  private readonly clearTimeoutFn: (id: number) => void;
  private readonly setIntervalFn: (fn: () => void, ms: number) => number;
  private readonly clearIntervalFn: (id: number) => void;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly onChange: ((state: TelemetryClientState) => void) | null;

  private state: TelemetryClientState = initialTelemetryState();
  private ws: WebSocketLike | null = null;
  private reconnectTimer: number | null = null;
  private staleTimer: number | null = null;
  private attempt = 0;
  private running = false;

  private trends = new Map<string, RingBuffer<TrendPoint>>();
  /** 每个「关节:指标」键最近一次趋势写入时间（降采样用） */
  private lastTrendWrite = new Map<string, number>();
  private lastSeq: number | null = null;
  private dropped = 0;
  private received = 0;
  private lastArrival: number | null = null;
  private lastGapAt: number | null = null;
  private seqErrors = 0;
  /** 重连耗尽 maxAttempts 后进入 fail-closed 终态：绝不自动重连，仅 restart() 可恢复。 */
  private gaveUp = false;

  constructor(options: TelemetryClientOptions) {
    this.url = options.url;
    this.staleMs = options.staleMs ?? 1500;
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 10000;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.staleCheckMs = options.staleCheckMs ?? 500;
    this.ringCapacity = options.ringCapacity ?? 3600;
    this.trendMinIntervalMs = options.trendMinIntervalMs ?? 100;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => window.setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((id) => window.clearTimeout(id));
    this.setIntervalFn = options.setIntervalFn ?? ((fn, ms) => window.setInterval(fn, ms));
    this.clearIntervalFn = options.clearIntervalFn ?? ((id) => window.clearInterval(id));
    this.webSocketFactory = options.webSocketFactory ?? defaultFactory;
    this.onChange = options.onChange ?? null;
  }

  get snapshot(): TelemetryClientState {
    return this.state;
  }

  /** 打开遥测连接（调用方必须先通过 shouldOpenTelemetry 门禁）。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.gaveUp = false;
    this.open();
  }

  /** 关闭并复位：robot 断开 / 页面卸载 / 连接失效时调用；之后绝不重连。 */
  stop(): void {
    this.running = false;
    this.gaveUp = false;
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopStaleTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.resetData();
    this.patch({ ...initialTelemetryState() });
  }

  /**
   * 显式恢复（Phase 7A）：重连耗尽 maxAttempts 进入 fail-closed 终态后，自动
   * 重连已真正停止；仅本方法可恢复。重置退避计数并立即重连（幂等：连接存活时
   * 不重复打开）。仅在 start() 之后、stop() 之前有效。
   */
  restart(): void {
    if (!this.running) return;
    this.attempt = 0;
    this.gaveUp = false;
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws === null) {
      this.open();
    }
  }

  /** 读取趋势（按时间窗过滤后的环形缓冲快照，最旧→最新）。 */
  getTrends(windowMs: number, at?: number): TrendSeries[] {
    const end = at ?? this.now();
    const out: TrendSeries[] = [];
    this.trends.forEach((buf, key) => {
      const sep = key.indexOf(':');
      const motorId = Number(key.slice(0, sep));
      const metric = key.slice(sep + 1) as TrendMetric;
      out.push({ motorId, metric, data: buf.toArray().filter((p) => end - p.t <= windowMs) });
    });
    return out;
  }

  clearTrends(): void {
    this.trends = new Map();
    this.lastTrendWrite = new Map();
  }

  // ---- 内部 ----

  private patch(next: Partial<TelemetryClientState>): void {
    this.state = { ...this.state, ...next };
    this.onChange?.(this.state);
  }

  private resetData(): void {
    this.trends = new Map();
    this.lastTrendWrite = new Map();
    this.lastSeq = null;
    this.dropped = 0;
    this.received = 0;
    this.lastArrival = null;
    this.lastGapAt = null;
    this.seqErrors = 0;
  }

  private open(): void {
    if (!this.running) return;
    this.patch({ status: 'connecting' });
    const ws = this.webSocketFactory(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.lastGapAt = null;
      // A socket opening is not a fresh telemetry frame. Keep the initial
      // connection in connecting, and keep reconnects stale until ingest()
      // receives a new valid frame. The last frame/joints stay untouched.
      this.patch({
        status: 'connecting',
        stale: this.state.frame !== null || this.state.stale,
      });
      if (this.staleTimer === null) {
        this.staleTimer = this.setIntervalFn(() => this.checkStale(), this.staleCheckMs);
      }
    };

    ws.onmessage = (ev) => this.ingest(String(ev.data));

    // WebSocket 错误只影响遥测状态，绝不改变 robot connection（要求 17）
    ws.onerror = () => {
      // onclose owns bounded retry/fail-closed; an onerror is transient.
      this.patch({
        status: 'connecting',
        stale: this.state.frame !== null || this.state.stale,
      });
    };

    ws.onclose = () => {
      this.stopStaleTimer();
      if (this.ws === ws) this.ws = null;
      if (!this.running) {
        this.patch({ status: 'idle', frame: null, joints: [] });
        return;
      }
      if (this.gaveUp) return; // 已进入 fail-closed 终态：绝不自动重连
      // 重连次数耗尽 maxAttempts：真正停止重连（fail closed）。此后状态停在
      // error，仅显式 restart() 可恢复 —— 避免后端长期不可用时无限重连。
      if (this.attempt >= this.maxAttempts) {
        this.gaveUp = true;
        this.patch({
          status: 'error',
          stale: this.state.frame !== null || this.state.stale,
        });
        return;
      }
      // 网络中断：有上限的指数退避重连
      const delay = Math.min(this.baseBackoffMs * Math.pow(2, this.attempt), this.maxBackoffMs);
      this.attempt += 1;
      this.patch({
        status: 'connecting',
        stale: this.state.frame !== null || this.state.stale,
      });
      this.reconnectTimer = this.setTimeoutFn(() => {
        this.reconnectTimer = null;
        this.open();
      }, delay);
    };
  }

  private stopStaleTimer(): void {
    if (this.staleTimer !== null) {
      this.clearIntervalFn(this.staleTimer);
      this.staleTimer = null;
    }
  }

  /** 陈旧检测：超过 staleMs 未收到帧 → 通信异常（保留最后一帧但标记 stale）。 */
  private checkStale(): void {
    const last = this.lastArrival;
    if (last !== null && this.now() - last > this.staleMs && !this.state.stale) {
      this.patch({
        stale: true,
        status: this.state.status === 'connected' ? 'stale' : this.state.status,
      });
    }
  }

  /**
   * 处理一帧遥测（公开以便测试）：
   * 严格校验（source/channel/units/7 唯一 ID/数值有限性）通过后，再做
   * sequence 检测（跳号=丢帧、回退/重复=乱序）+ 通信统计 + 趋势环形缓冲。
   * 非法 JSON 或未通过校验的帧整体丢弃，绝不污染已建立的状态。
   */
  ingest(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // 非法 JSON：丢弃，不改变任何状态
    }
    const f = validateTelemetryFrame(parsed);
    if (f === null) return; // 校验失败：整帧丢弃，不污染状态
    const now = this.now();

    const prevSeq = this.lastSeq;
    if (prevSeq !== null) {
      if (f.sequence <= prevSeq) {
        this.seqErrors += 1; // 乱序 / 重复
      } else if (f.sequence > prevSeq + 1) {
        this.dropped += f.sequence - prevSeq - 1; // 丢帧（跳号）
      }
    }
    // 只向前推进：乱序帧不得把基准拉回，否则后续正常帧会被误判为跳号丢帧
    this.lastSeq = prevSeq === null ? f.sequence : Math.max(prevSeq, f.sequence);
    this.received += 1;
    this.lastArrival = now;

    const total = this.received + this.dropped;
    const dropRate = total > 0 ? this.dropped / total : 0;

    let freq = 0;
    let gap = 0;
    if (this.lastGapAt !== null) {
      gap = now - this.lastGapAt;
      if (gap > 0) freq = 1000 / gap;
    }
    this.lastGapAt = now;

    const joints = buildLiveJoints(f);
    const wroteTrend = this.appendTrends(joints, now);

    this.patch({
      frame: f,
      joints,
      stale: false,
      status: 'connected',
      // 只有实际写入趋势点才递增 → 图表重绘被降采样限制在 ≤10Hz
      trendVersion: wroteTrend ? this.state.trendVersion + 1 : this.state.trendVersion,
      comm: {
        freq,
        latencyMs: Math.round(gap),
        dropRate,
        seqErrors: this.seqErrors,
        lastSeq: this.lastSeq,
        lastArrivalMs: now,
      },
    });
  }

  /**
   * 趋势降采样写入：每个「关节:指标」键最多每 trendMinIntervalMs 写 1 点。
   * 50Hz 输入下图表缓冲按 ≤10Hz 记录，3600 容量 ≈ 6 分钟；
   * 实时监控（frame/joints/comm）不受影响，仍按全帧率更新。
   * @returns 本帧是否写入了至少一个趋势点
   */
  private appendTrends(joints: LiveJoint[], t: number): boolean {
    let wrote = false;
    for (const m of joints) {
      const entries: Array<[TrendMetric, number | null]> = [
        ['position', m.position],
        ['velocity', m.velocity],
        ['torque', m.torque],
        ['temperature', m.tempMos],
        ['status', m.statusCode],
      ];
      for (const [metric, v] of entries) {
        if (v === null) continue; // null 不落趋势，绝不伪造数值
        const key = `${m.id}:${metric}`;
        const last = this.lastTrendWrite.get(key);
        if (last !== undefined && t - last < this.trendMinIntervalMs) continue; // 降采样
        let buf = this.trends.get(key);
        if (!buf) {
          buf = new RingBuffer<TrendPoint>(this.ringCapacity);
          this.trends.set(key, buf);
        }
        buf.push({ t, v });
        this.lastTrendWrite.set(key, t);
        wrote = true;
      }
    }
    return wrote;
  }
}
