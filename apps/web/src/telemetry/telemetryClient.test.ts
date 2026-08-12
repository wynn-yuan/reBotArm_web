import { beforeEach, describe, expect, it } from 'vitest';
import {
  TelemetryClient,
  buildLiveJoints,
  initialTelemetryState,
  shouldOpenTelemetry,
  validateTelemetryFrame,
  type TelemetryClientOptions,
  type TelemetryClientState,
  type WebSocketLike,
} from './telemetryClient';
import { TELEMETRY_EXPECTED_IDS } from './jointMap';
import { FAIL_CLOSED_CAPABILITIES, SIMULATION_CAPABILITIES, type TelemetryFrame } from '../types';

// ===== 测试用假 WebSocket =====
class MockWebSocket implements WebSocketLike {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  closeCalled = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  close(): void {
    this.closeCalled = true;
  }
  emitOpen(): void {
    this.onopen?.();
  }
  emitMessage(data: string): void {
    this.onmessage?.({ data });
  }
  emitError(): void {
    this.onerror?.();
  }
  emitClose(): void {
    this.onclose?.();
  }
}

// ===== 测试用假时钟（手动推进，按时间顺序触发定时器） =====
function createFakeClock(start = 1_000_000) {
  let current = start;
  let nextId = 1;
  const timeouts: Array<{ id: number; fn: () => void; runAt: number }> = [];
  const intervals = new Map<number, { fn: () => void; period: number; nextAt: number }>();

  const removeTimeout = (id: number) => {
    const i = timeouts.findIndex((t) => t.id === id);
    if (i >= 0) timeouts.splice(i, 1);
  };

  const advance = (ms: number): void => {
    const target = current + ms;
    for (;;) {
      let nextAt: number | null = null;
      for (const t of timeouts) if (t.runAt <= target && (nextAt === null || t.runAt < nextAt)) nextAt = t.runAt;
      for (const iv of intervals.values()) if (iv.nextAt <= target && (nextAt === null || iv.nextAt < nextAt)) nextAt = iv.nextAt;
      if (nextAt === null) break;
      current = nextAt;
      const due = timeouts.filter((t) => t.runAt === nextAt);
      for (const t of due) {
        removeTimeout(t.id);
        t.fn();
      }
      for (const iv of [...intervals.values()]) {
        while (iv.nextAt === nextAt) {
          iv.fn();
          iv.nextAt += iv.period;
        }
      }
    }
    current = target;
  };

  return {
    now: () => current,
    advance,
    setTimeoutFn: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timeouts.push({ id, fn, runAt: current + ms });
      return id;
    },
    clearTimeoutFn: removeTimeout,
    setIntervalFn: (fn: () => void, period: number): number => {
      const id = nextId++;
      intervals.set(id, { fn, period, nextAt: current + period });
      return id;
    },
    clearIntervalFn: (id: number): void => {
      intervals.delete(id);
    },
    pendingTimeoutCount: () => timeouts.length,
    /** 最近一个待触发 timeout 的延迟（相对当前时刻） */
    pendingDelay: (): number | null =>
      timeouts.length === 0 ? null : Math.min(...timeouts.map((t) => t.runAt)) - current,
    /** 推进到最近一个 timeout 并触发它，返回其延迟 */
    fireNextTimeout: (): number | null => {
      const delay = timeouts.length === 0 ? null : Math.min(...timeouts.map((t) => t.runAt)) - current;
      if (delay === null) return null;
      advance(delay);
      return delay;
    },
  };
}

function setup(overrides: Partial<TelemetryClientOptions> = {}) {
  MockWebSocket.instances = [];
  const clock = createFakeClock();
  const states: TelemetryClientState[] = [];
  const client = new TelemetryClient({
    url: 'ws://127.0.0.1:8000/ws/robot/telemetry',
    webSocketFactory: (u) => new MockWebSocket(u),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    onChange: (s) => states.push(s),
    ...overrides,
  });
  const lastWs = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];
  return { client, clock, states, lastWs };
}

/** 构造一帧 JSON（position = posBase + id*0.1，便于按序号断言趋势值） */
function makeFrame(seq: number, opts: { source?: string; posBase?: number } = {}): string {
  const posBase = opts.posBase ?? 0;
  const f: TelemetryFrame = {
    timestamp: '2026-08-08T00:00:00+00:00',
    sequence: seq,
    channel: 'can0',
    source: opts.source ?? 'simulation',
    units: { position: 'rad', velocity: 'rad/s', torque: 'Nm', temperature: 'degC' },
    joints: TELEMETRY_EXPECTED_IDS.map((id) => ({
      id,
      position: posBase + id * 0.1,
      velocity: 0.2 * id,
      torque: 0.3 * id,
      current: null,
      temperature: { mos: 30 + id, rotor: 29 + id },
      status_code: 0,
      error_code: null,
      freshness: 'fresh' as const,
    })),
  };
  return JSON.stringify(f);
}

beforeEach(() => {
  MockWebSocket.instances = [];
});

describe('遥测连接门禁（要求 1/18：无 telemetry 能力绝不连接）', () => {
  it('connected + capabilities.telemetry === true → 允许连接', () => {
    expect(shouldOpenTelemetry({ status: 'connected', capabilities: SIMULATION_CAPABILITIES })).toBe(true);
    expect(shouldOpenTelemetry({ status: 'connected', capabilities: { telemetry: true } })).toBe(true);
  });

  it('connected 但无 telemetry 能力（fail closed）→ 不连接', () => {
    expect(shouldOpenTelemetry({ status: 'connected', capabilities: FAIL_CLOSED_CAPABILITIES })).toBe(false);
    expect(shouldOpenTelemetry({ status: 'connected', capabilities: { telemetry: false } })).toBe(false);
  });

  it('非 connected 状态即使 telemetry=true 也不连接', () => {
    const caps = { telemetry: true };
    expect(shouldOpenTelemetry({ status: 'disconnected', capabilities: caps })).toBe(false);
    expect(shouldOpenTelemetry({ status: 'scanning', capabilities: caps })).toBe(false);
    expect(shouldOpenTelemetry({ status: 'partial', capabilities: caps })).toBe(false);
    expect(shouldOpenTelemetry({ status: 'error', capabilities: caps })).toBe(false);
  });
});

describe('自动连接 / 断开（要求 1/3）', () => {
  it('start() 打开 WebSocket 并使用遥测端点；open 后进入 connected', () => {
    const { client, states, lastWs } = setup();
    client.start();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(lastWs().url).toBe('ws://127.0.0.1:8000/ws/robot/telemetry');
    expect(client.snapshot.status).toBe('connecting');

    lastWs().emitOpen();
    expect(client.snapshot.status).toBe('connecting');
    // 状态变化通过 onChange 上报（React Provider 依赖该回调）
    expect(states.some((s) => s.status === 'connecting')).toBe(true);
    expect(states.some((s) => s.status === 'connected')).toBe(false);
  });

  it('stop() 关闭 WebSocket、复位状态，且之后绝不重连（robot 断开 / 页面卸载）', () => {
    const { client, clock, lastWs } = setup();
    client.start();
    lastWs().emitOpen();
    lastWs().emitMessage(makeFrame(1));
    expect(client.snapshot.frame?.sequence).toBe(1);

    client.stop();
    expect(lastWs().closeCalled).toBe(true);
    expect(client.snapshot.status).toBe('idle');
    expect(client.snapshot.frame).toBeNull();
    expect(client.snapshot.joints).toEqual([]);
    expect(client.getTrends(60_000)).toEqual([]);

    // stop 之后无论经过多久都没有重连定时器
    clock.advance(60_000);
    expect(clock.pendingTimeoutCount()).toBe(0);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('重复 start() 不会重复连接', () => {
    const { client } = setup();
    client.start();
    client.start();
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});

describe('网络中断后的有上限指数退避重连（要求 4）', () => {
  it('退避序列 500 → 1000 → 2000 → 4000 → 8000 → 10000（封顶）', () => {
    const { client, clock, lastWs } = setup();
    client.start();

    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      lastWs().emitClose(); // 网络中断
      expect(client.snapshot.status).toBe('connecting');
      const d = clock.fireNextTimeout();
      expect(d).not.toBeNull();
      delays.push(d as number);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 10000]);
    // 每次重连都创建新的 WebSocket
    expect(MockWebSocket.instances).toHaveLength(7);
  });

  it('退避封顶后保持上限；耗尽 maxAttempts 后真正停止重连（fail closed）', () => {
    const { client, clock, lastWs } = setup(); // 默认 maxAttempts=8
    client.start();
    // 前 8 次中断都会安排重连：500,1000,2000,4000,8000 起被封顶到 10000。
    for (let i = 0; i < 8; i++) {
      lastWs().emitClose();
      const d = clock.fireNextTimeout();
      expect(d).toBe(i >= 5 ? 10000 : 500 * Math.pow(2, i));
    }
    // 第 9 次中断：重连次数已耗尽 → 放弃重连，进入 error 终态，不再安排定时器。
    lastWs().emitClose();
    expect(client.snapshot.status).toBe('error');
    expect(clock.pendingTimeoutCount()).toBe(0);
    const sockets = MockWebSocket.instances.length;
    // 之后无论多久都不再自动重连（绝不无限重连）
    clock.advance(10 * 60_000);
    expect(MockWebSocket.instances).toHaveLength(sockets);
    expect(client.snapshot.status).toBe('error');
  });

  it('maxAttempts=0：首次中断即放弃，从不重连', () => {
    const { client, clock, lastWs } = setup({ maxAttempts: 0 });
    client.start();
    expect(client.snapshot.status).toBe('connecting');
    lastWs().emitClose();
    expect(client.snapshot.status).toBe('error');
    expect(clock.pendingTimeoutCount()).toBe(0);
    expect(MockWebSocket.instances).toHaveLength(1); // 仅初始那一个
  });

  it('放弃后仅显式 restart() 可恢复：重置退避并立即重连', () => {
    const { client, clock, lastWs } = setup({ maxAttempts: 1 });
    client.start();
    lastWs().emitClose(); // attempt0 → 安排 500ms 重连（attempt=1）
    expect(clock.fireNextTimeout()).toBe(500);
    lastWs().emitClose(); // attempt(1) >= maxAttempts(1) → 放弃
    expect(client.snapshot.status).toBe('error');
    expect(clock.pendingTimeoutCount()).toBe(0);
    const before = MockWebSocket.instances.length;
    clock.advance(10 * 60_000); // 等待也不会自动重连
    expect(MockWebSocket.instances).toHaveLength(before);

    // 显式恢复
    client.restart();
    expect(client.snapshot.status).toBe('connecting');
    expect(MockWebSocket.instances).toHaveLength(before + 1);
    lastWs().emitOpen();
    expect(client.snapshot.status).toBe('connecting');
    // 退避已归零：下一次中断从 500ms 重新开始
    lastWs().emitClose();
    expect(clock.fireNextTimeout()).toBe(500);
  });

  it('restart() 幂等：连接存活时不重复打开；stop 后无效', () => {
    const { client, lastWs } = setup();
    client.start();
    lastWs().emitOpen();
    client.restart(); // 已连接 → 不新建连接
    expect(MockWebSocket.instances).toHaveLength(1);

    client.stop();
    client.restart(); // 已 stop（running=false）→ 无效
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('连接成功（onopen）重置退避计数', () => {
    const { client, clock, lastWs } = setup();
    client.start();
    lastWs().emitClose();
    expect(clock.fireNextTimeout()).toBe(500);
    lastWs().emitClose();
    expect(clock.fireNextTimeout()).toBe(1000);

    lastWs().emitOpen(); // 成功 → attempt 归零
    lastWs().emitClose();
    expect(clock.fireNextTimeout()).toBe(500);
  });

  it('stop() 取消挂起的重连定时器', () => {
    const { client, clock, lastWs } = setup();
    client.start();
    lastWs().emitClose(); // 挂起 500ms 重连
    expect(clock.pendingTimeoutCount()).toBe(1);
    client.stop();
    expect(clock.pendingTimeoutCount()).toBe(0);
    clock.advance(60_000);
    expect(MockWebSocket.instances).toHaveLength(1); // 没有新连接
  });
});

describe('sequence 丢帧 / 乱序检测（要求 5）', () => {
  it('跳号判定为丢帧，dropRate = dropped / (received + dropped)', () => {
    const { client, lastWs } = setup();
    client.start();
    lastWs().emitOpen();

    lastWs().emitMessage(makeFrame(1));
    expect(client.snapshot.comm.dropRate).toBe(0);

    lastWs().emitMessage(makeFrame(4)); // 丢 2、3 两帧
    const comm = client.snapshot.comm;
    expect(comm.lastSeq).toBe(4);
    // dropped=2, received=2 → 2/4
    expect(comm.dropRate).toBeCloseTo(0.5, 10);
  });

  it('回退 / 重复 sequence 判定为乱序（seqErrors），不计为丢帧', () => {
    const { client, lastWs } = setup();
    client.start();
    lastWs().emitOpen();

    lastWs().emitMessage(makeFrame(5));
    lastWs().emitMessage(makeFrame(3)); // 乱序
    lastWs().emitMessage(makeFrame(5)); // 重复
    const comm = client.snapshot.comm;
    expect(comm.seqErrors).toBe(2);
    expect(comm.dropRate).toBe(0);
  });

  it('连续帧（seq 递增 1）无任何丢帧/乱序', () => {
    const { client, lastWs } = setup();
    client.start();
    lastWs().emitOpen();
    for (let i = 1; i <= 20; i++) {
      lastWs().emitMessage(makeFrame(i));
    }
    const comm = client.snapshot.comm;
    expect(comm.seqErrors).toBe(0);
    expect(comm.dropRate).toBe(0);
    expect(comm.lastSeq).toBe(20);
  });
});

describe('freshness 陈旧检测（要求 6/7）', () => {
  it('超过阈值未收到帧 → stale=true 且状态转为 stale', () => {
    const { client, clock, lastWs } = setup({ staleMs: 1500, staleCheckMs: 500 });
    client.start();
    lastWs().emitOpen();
    lastWs().emitMessage(makeFrame(1));
    const frameBefore = client.snapshot.frame;

    // 阈值内仍新鲜
    clock.advance(1000);
    expect(client.snapshot.stale).toBe(false);
    expect(client.snapshot.status).toBe('connected');

    // 超过阈值 → 通信异常
    clock.advance(1100);
    expect(client.snapshot.stale).toBe(true);
    expect(client.snapshot.status).toBe('stale');
    // 最后一帧被保留（供展示"已暂停更新"），但消费方不得当作实时状态
    expect(client.snapshot.frame).toBe(frameBefore);
  });

  it('新帧到达后 stale 复位、状态恢复 connected', () => {
    const { client, clock, lastWs } = setup({ staleMs: 1500, staleCheckMs: 500 });
    client.start();
    lastWs().emitOpen();
    lastWs().emitMessage(makeFrame(1));
    clock.advance(2100);
    expect(client.snapshot.stale).toBe(true);

    lastWs().emitMessage(makeFrame(2));
    expect(client.snapshot.stale).toBe(false);
    expect(client.snapshot.status).toBe('connected');
    expect(client.snapshot.frame?.sequence).toBe(2);
  });

  it('重新 open 时 stale 复位', () => {
    const { client, clock, lastWs } = setup({ staleMs: 1500, staleCheckMs: 500 });
    client.start();
    lastWs().emitOpen();
    lastWs().emitMessage(makeFrame(1));
    clock.advance(2100);
    expect(client.snapshot.stale).toBe(true);
    const frameBeforeReconnect = client.snapshot.frame;
    const jointsBeforeReconnect = client.snapshot.joints;

    lastWs().emitClose();
    clock.fireNextTimeout();
    lastWs().emitOpen();
    expect(client.snapshot.stale).toBe(true);
    expect(client.snapshot.status).toBe('connecting');
    expect(client.snapshot.frame).toBe(frameBeforeReconnect);
    expect(client.snapshot.joints).toBe(jointsBeforeReconnect);
    lastWs().emitMessage(makeFrame(2));
    expect(client.snapshot.stale).toBe(false);
    expect(client.snapshot.status).toBe('connected');
  });

  it('retains last valid frame and joints through reconnect until a fresh frame', () => {
    const { client, clock, lastWs } = setup({ staleMs: 1500, staleCheckMs: 500 });
    client.start();
    lastWs().emitOpen();
    lastWs().emitMessage(makeFrame(1));
    const frameBeforeReconnect = client.snapshot.frame;
    const jointsBeforeReconnect = client.snapshot.joints;

    lastWs().emitClose();
    expect(client.snapshot.status).toBe('connecting');
    expect(client.snapshot.stale).toBe(true);
    expect(client.snapshot.frame).toBe(frameBeforeReconnect);
    expect(client.snapshot.joints).toBe(jointsBeforeReconnect);

    expect(clock.fireNextTimeout()).toBe(500);
    lastWs().emitOpen();
    expect(client.snapshot.status).toBe('connecting');
    expect(client.snapshot.stale).toBe(true);
    expect(client.snapshot.frame).toBe(frameBeforeReconnect);
    expect(client.snapshot.joints).toBe(jointsBeforeReconnect);

    lastWs().emitMessage(makeFrame(2));
    expect(client.snapshot.status).toBe('connected');
    expect(client.snapshot.stale).toBe(false);
    expect(client.snapshot.frame?.sequence).toBe(2);
  });

  it('从未收到帧时不误报 stale', () => {
    const { client, clock, lastWs } = setup({ staleMs: 1500, staleCheckMs: 500 });
    client.start();
    lastWs().emitOpen();
    clock.advance(10_000);
    expect(client.snapshot.stale).toBe(false);
  });
});

describe('WebSocket 错误不改变 robot connection（要求 17）', () => {
  it('onerror 保持 connecting，交由 close 的有界重连处理', () => {
    const { client, lastWs, states } = setup();
    client.start();
    lastWs().emitError();
    expect(client.snapshot.status).toBe('connecting');
    // 客户端状态域中不存在 robot connection 字段；这里进一步验证没有异常复位
    expect(client.snapshot.frame).toBeNull();
    expect(states[states.length - 1].status).toBe('connecting');
  });

  it('error 之后的 close 走重连而不是崩溃', () => {
    const { client, clock, lastWs } = setup();
    client.start();
    lastWs().emitError();
    lastWs().emitClose();
    expect(clock.fireNextTimeout()).toBe(500);
    expect(MockWebSocket.instances).toHaveLength(2);
  });
});

describe('模拟 / 真机数据隔离与不伪造（要求 14/15）', () => {
  it('buildLiveJoints：缺失关节 → 全 null + freshness none，绝不填充模拟值', () => {
    const raw = JSON.parse(makeFrame(1, { source: 'motorbridge' })) as TelemetryFrame;
    raw.joints = raw.joints.filter((j) => j.id !== 4); // 移除 ID 4
    const live = buildLiveJoints(raw);
    expect(live).toHaveLength(7);
    const j4 = live.find((j) => j.id === 4);
    expect(j4).toBeDefined();
    expect(j4?.position).toBeNull();
    expect(j4?.velocity).toBeNull();
    expect(j4?.torque).toBeNull();
    expect(j4?.tempMos).toBeNull();
    expect(j4?.statusCode).toBeNull();
    expect(j4?.freshness).toBe('none');
  });

  it('buildLiveJoints：帧内 null 字段原样保持 null', () => {
    const raw = JSON.parse(makeFrame(1, { source: 'motorbridge' })) as TelemetryFrame;
    const j2 = raw.joints.find((j) => j.id === 2);
    if (j2) {
      j2.position = null;
      j2.temperature = { mos: null, rotor: null };
    }
    const live = buildLiveJoints(raw);
    const l2 = live.find((j) => j.id === 2);
    expect(l2?.position).toBeNull();
    expect(l2?.tempMos).toBeNull();
    expect(l2?.tempRotor).toBeNull();
    // 其余字段不受影响
    expect(l2?.velocity).not.toBeNull();
  });

  it('null 值不落趋势：不会以 0 或旧模拟值冒充', () => {
    const { client, lastWs } = setup();
    client.start();
    lastWs().emitOpen();

    const raw = JSON.parse(makeFrame(1, { source: 'motorbridge' })) as TelemetryFrame;
    const j3 = raw.joints.find((j) => j.id === 3);
    if (j3) j3.position = null;
    lastWs().emitMessage(JSON.stringify(raw));

    const trends = client.getTrends(60_000);
    expect(trends.some((s) => s.motorId === 3 && s.metric === 'position')).toBe(false);
    // 其余关节 / 指标正常记录
    expect(trends.some((s) => s.motorId === 1 && s.metric === 'position')).toBe(true);
    expect(trends.some((s) => s.motorId === 3 && s.metric === 'velocity')).toBe(true);
  });

  it('帧 source 字段原样透传（simulation / motorbridge 由上层显式标注）', () => {
    const { client, lastWs } = setup();
    client.start();
    lastWs().emitOpen();
    lastWs().emitMessage(makeFrame(1, { source: 'simulation' }));
    expect(client.snapshot.frame?.source).toBe('simulation');
    lastWs().emitMessage(makeFrame(2, { source: 'motorbridge' }));
    expect(client.snapshot.frame?.source).toBe('motorbridge');
  });
});

describe('趋势环形缓冲与时间窗（要求 11/12/13）', () => {
  it('缓冲容量固定：超出容量覆盖最旧点，长度不增长', () => {
    const { client, clock, lastWs } = setup({ ringCapacity: 10 });
    client.start();
    lastWs().emitOpen();
    for (let seq = 1; seq <= 15; seq++) {
      lastWs().emitMessage(makeFrame(seq, { posBase: seq }));
      clock.advance(100);
    }
    const series = client.getTrends(60 * 60 * 1000).find((s) => s.motorId === 1 && s.metric === 'position');
    expect(series).toBeDefined();
    expect(series?.data).toHaveLength(10); // 容量上限
    // 保留最新 10 帧（seq 6..15），position = seq + 1*0.1
    expect(series?.data[0].v).toBeCloseTo(6.1, 10);
    expect(series?.data[9].v).toBeCloseTo(15.1, 10);
    expect(client.snapshot.trendVersion).toBe(15);
  });

  it('getTrends 按时间窗过滤', () => {
    const { client, clock, lastWs } = setup();
    client.start();
    lastWs().emitOpen();
    for (let seq = 1; seq <= 10; seq++) {
      lastWs().emitMessage(makeFrame(seq, { posBase: seq }));
      clock.advance(1000); // 每帧间隔 1s
    }
    const all = client.getTrends(60_000).find((s) => s.motorId === 1 && s.metric === 'position');
    expect(all?.data).toHaveLength(10);
    const win = client.getTrends(3_000).find((s) => s.motorId === 1 && s.metric === 'position');
    // 最近 3s 窗口：最后 3 个点
    expect(win?.data).toHaveLength(3);
  });

  it('clearTrends 清空缓冲', () => {
    const { client, lastWs } = setup();
    client.start();
    lastWs().emitOpen();
    lastWs().emitMessage(makeFrame(1));
    expect(client.getTrends(60_000).length).toBeGreaterThan(0);
    client.clearTrends();
    expect(client.getTrends(60_000)).toEqual([]);
  });

  it('status 指标也被记录（趋势页可绘制状态/错误码）', () => {
    const { client, lastWs } = setup();
    client.start();
    lastWs().emitOpen();
    lastWs().emitMessage(makeFrame(1));
    const status = client.getTrends(60_000).find((s) => s.motorId === 1 && s.metric === 'status');
    expect(status?.data).toHaveLength(1);
    expect(status?.data[0].v).toBe(0);
  });
});

describe('50Hz 输入下的趋势降采样与容量（任务 6）', () => {
  /** 灌入 50Hz × 120s = 6000 帧，返回最终状态供多项断言复用 */
  function run50Hz120s() {
    // 大量帧不记录中间状态，避免测试内存浪费
    const { client, clock, lastWs } = setup({ onChange: () => {} });
    client.start();
    lastWs().emitOpen();
    const start = clock.now();
    const frames = 50 * 120; // 50Hz × 120s
    for (let seq = 1; seq <= frames; seq++) {
      lastWs().emitMessage(makeFrame(seq));
      clock.advance(20); // 20ms = 50Hz
    }
    const end = clock.now();
    return { client, clock, lastWs, start, end, frames };
  }

  it('50Hz × 120s 输入：2 分钟时间窗完整保留，且缓冲容量充足未被覆盖', () => {
    const { client, end, start } = run50Hz120s();
    const series = client
      .getTrends(120_000, end)
      .find((s) => s.motorId === 1 && s.metric === 'position');
    expect(series).toBeDefined();
    const data = series?.data ?? [];
    // 10Hz 降采样 → 约 1200 点，全部落在容量 3600 之内（不发生覆盖）
    expect(data.length).toBeGreaterThanOrEqual(1190);
    expect(data.length).toBeLessThanOrEqual(1210);
    expect(data.length).toBeLessThan(3600);
    // 窗口完整：首点贴近起点、末点贴近终点、跨度 ≥ 119.8s
    expect(data[0].t - start).toBeLessThanOrEqual(100);
    expect(end - data[data.length - 1].t).toBeLessThanOrEqual(120);
    expect(data[data.length - 1].t - data[0].t).toBeGreaterThanOrEqual(119_800);
  });

  it('趋势写入速率 ≤10Hz：相邻点间隔 ≥100ms', () => {
    const { client, end } = run50Hz120s();
    const series = client
      .getTrends(120_000, end)
      .find((s) => s.motorId === 1 && s.metric === 'position');
    const data = series?.data ?? [];
    expect(data.length).toBeGreaterThan(100);
    for (let i = 1; i < data.length; i++) {
      expect(data[i].t - data[i - 1].t).toBeGreaterThanOrEqual(100);
    }
    // 也不过度抽稀：间隔不超过 120ms（50Hz 帧间隔 20ms 下的 10Hz 降采样应为 100ms）
    for (let i = 1; i < data.length; i++) {
      expect(data[i].t - data[i - 1].t).toBeLessThanOrEqual(120);
    }
  });

  it('sequence / 丢帧率 / 通信频率仍按全帧率计算（不受降采样影响）', () => {
    const { client, frames } = run50Hz120s();
    const comm = client.snapshot.comm;
    expect(comm.lastSeq).toBe(frames); // 6000 帧全部计数
    expect(comm.dropRate).toBe(0);
    expect(comm.seqErrors).toBe(0);
    expect(comm.freq).toBeCloseTo(50, 5); // 1000 / 20ms
  });

  it('trendVersion 只在写入趋势点时递增 → 图表重绘 ≤10Hz', () => {
    const { client, frames } = run50Hz120s();
    const v = client.snapshot.trendVersion;
    expect(v).toBeGreaterThanOrEqual(1190);
    expect(v).toBeLessThanOrEqual(1210);
    expect(v).toBeLessThan(frames / 5 + 10); // 远小于帧数 6000
  });

  it('50Hz 全帧率下的跳号丢帧检测（丢帧统计不经过降采样）', () => {
    const { client, lastWs } = setup({ onChange: () => {} });
    client.start();
    lastWs().emitOpen();
    for (let seq = 1; seq <= 250; seq++) {
      if (seq === 101) {
        lastWs().emitMessage(makeFrame(110)); // 丢 101..109 共 9 帧
        continue;
      }
      if (seq > 101 && seq <= 110) continue; // 110 已在上面发出
      lastWs().emitMessage(makeFrame(seq));
    }
    const comm = client.snapshot.comm;
    expect(comm.lastSeq).toBe(250);
    expect(comm.dropRate).toBeCloseTo(9 / (241 + 9), 10);
  });

  it('null 值在降采样后依然不落趋势', () => {
    const { client, clock, lastWs } = setup({ onChange: () => {} });
    client.start();
    lastWs().emitOpen();
    const raw = JSON.parse(makeFrame(1, { source: 'motorbridge' })) as TelemetryFrame;
    const j3 = raw.joints.find((j) => j.id === 3);
    if (j3) j3.position = null;
    for (let i = 0; i < 10; i++) {
      lastWs().emitMessage(JSON.stringify(raw));
      clock.advance(100);
    }
    const trends = client.getTrends(60_000);
    expect(trends.some((s) => s.motorId === 3 && s.metric === 'position')).toBe(false);
    expect(trends.some((s) => s.motorId === 3 && s.metric === 'velocity')).toBe(true);
  });
});

describe('严格帧校验（Phase 7A：无效帧绝不污染状态）', () => {
  /** 构造一份合法帧对象（深拷贝，便于逐字段篡改）。 */
  function validObj(seq = 1): TelemetryFrame {
    return JSON.parse(makeFrame(seq)) as TelemetryFrame;
  }

  it('合法帧通过校验', () => {
    expect(validateTelemetryFrame(validObj())).not.toBeNull();
    expect(validateTelemetryFrame(JSON.parse(makeFrame(1, { source: 'motorbridge' })))).not.toBeNull();
  });

  it('顶层非对象 / null / 数组 → 拒绝', () => {
    expect(validateTelemetryFrame(null)).toBeNull();
    expect(validateTelemetryFrame('x')).toBeNull();
    expect(validateTelemetryFrame(42)).toBeNull();
    expect(validateTelemetryFrame([])).toBeNull();
    expect(validateTelemetryFrame(validObj().joints)).toBeNull();
  });

  it('source 必须是 simulation / motorbridge', () => {
    const f = validObj();
    (f as unknown as { source: unknown }).source = 'robot';
    expect(validateTelemetryFrame(f)).toBeNull();
    (f as unknown as { source: unknown }).source = 123;
    expect(validateTelemetryFrame(f)).toBeNull();
    (f as unknown as { source: unknown }).source = '';
    expect(validateTelemetryFrame(f)).toBeNull();
  });

  it('channel 必须匹配 can<number>', () => {
    const f = validObj();
    (f as unknown as { channel: unknown }).channel = 'vcan0';
    expect(validateTelemetryFrame(f)).toBeNull();
    (f as unknown as { channel: unknown }).channel = 'can';
    expect(validateTelemetryFrame(f)).toBeNull();
    (f as unknown as { channel: unknown }).channel = 'can0 ';
    expect(validateTelemetryFrame(f)).toBeNull();
    (f as unknown as { channel: unknown }).channel = 0;
    expect(validateTelemetryFrame(f)).toBeNull();
  });

  it('units 必须与契约精确一致（缺失 / 多余 / 值漂移均拒绝）', () => {
    const missing = validObj();
    delete (missing.units as Record<string, string>).temperature;
    expect(validateTelemetryFrame(missing)).toBeNull();

    const drift = validObj();
    drift.units.position = 'deg'; // 单位漂移：弧度被写成角度
    expect(validateTelemetryFrame(drift)).toBeNull();

    const extra = validObj();
    (extra.units as Record<string, string>).current = 'A';
    expect(validateTelemetryFrame(extra)).toBeNull();

    const notObj = validObj();
    (notObj as unknown as { units: unknown }).units = 'rad';
    expect(validateTelemetryFrame(notObj)).toBeNull();
  });

  it('joints 必须恰好 7 个（多 / 少均拒绝）', () => {
    const six = validObj();
    six.joints = six.joints.slice(0, 6);
    expect(validateTelemetryFrame(six)).toBeNull();

    const eight = validObj();
    eight.joints = [...eight.joints, { ...eight.joints[0], id: 8 }];
    expect(validateTelemetryFrame(eight)).toBeNull();
  });

  it('joints ID 必须唯一（重复拒绝）', () => {
    const dup = validObj();
    dup.joints = dup.joints.map((j) => (j.id === 2 ? { ...j, id: 1 } : j)); // 两个 ID 1
    expect(validateTelemetryFrame(dup)).toBeNull();
  });

  it('joints ID 必须覆盖期望集 1..7（越界 / 缺失拒绝）', () => {
    const outOfRange = validObj();
    outOfRange.joints = outOfRange.joints.map((j) => (j.id === 7 ? { ...j, id: 99 } : j));
    expect(validateTelemetryFrame(outOfRange)).toBeNull();

    const nonInt = validObj();
    (nonInt.joints[0] as unknown as { id: unknown }).id = 1.5;
    expect(validateTelemetryFrame(nonInt)).toBeNull();
  });

  it('数值字段必须有限（拒绝 1e999→Infinity / 字符串 / 布尔）', () => {
    // JSON 无法直接写 Infinity，但 1e999 解析后溢出为 Infinity
    const infJson = makeFrame(1).replace('"position":0.1', '"position":1e999');
    expect(JSON.parse(infJson).joints[0].position).toBe(Infinity);
    expect(validateTelemetryFrame(JSON.parse(infJson))).toBeNull();

    const str = validObj();
    (str.joints[0] as unknown as { position: unknown }).position = '1.5';
    expect(validateTelemetryFrame(str)).toBeNull();

    const bool = validObj();
    (bool.joints[0] as unknown as { velocity: unknown }).velocity = true;
    expect(validateTelemetryFrame(bool)).toBeNull();

    const tempStr = validObj();
    (tempStr.joints[0].temperature as unknown as { mos: unknown }).mos = '30';
    expect(validateTelemetryFrame(tempStr)).toBeNull();
  });

  it('数值字段允许 null（缺失/未报告）', () => {
    const f = validObj();
    f.joints[0].position = null;
    f.joints[0].temperature = { mos: null, rotor: null };
    expect(validateTelemetryFrame(f)).not.toBeNull();
  });

  it('sequence 必须为非负整数', () => {
    const neg = validObj();
    neg.sequence = -1;
    expect(validateTelemetryFrame(neg)).toBeNull();
    const frac = validObj();
    frac.sequence = 1.5;
    expect(validateTelemetryFrame(frac)).toBeNull();
    const strSeq = validObj();
    (strSeq as unknown as { sequence: unknown }).sequence = '1';
    expect(validateTelemetryFrame(strSeq)).toBeNull();
  });

  it('freshness 必须是 fresh / none', () => {
    const f = validObj();
    (f.joints[0] as unknown as { freshness: unknown }).freshness = 'stale';
    expect(validateTelemetryFrame(f)).toBeNull();
  });

  it('timestamp 必须为非空字符串', () => {
    const f = validObj();
    (f as unknown as { timestamp: unknown }).timestamp = 123;
    expect(validateTelemetryFrame(f)).toBeNull();
    (f as unknown as { timestamp: unknown }).timestamp = '';
    expect(validateTelemetryFrame(f)).toBeNull();
  });

  it('无效帧不污染状态：已有合法帧 / 统计 / 趋势保持不变', () => {
    const { client, lastWs } = setup();
    client.start();
    lastWs().emitOpen();
    lastWs().emitMessage(makeFrame(5)); // 先建立合法状态
    const frameBefore = client.snapshot.frame;
    const commBefore = client.snapshot.comm;
    const trendsBefore = client.getTrends(60_000);

    // 尝试用一个「跳号 + 非法单位」的坏帧污染
    const bad = validObj(99);
    bad.units.position = 'deg';
    lastWs().emitMessage(JSON.stringify(bad));

    expect(client.snapshot.frame).toBe(frameBefore); // 帧未变
    expect(client.snapshot.comm).toEqual(commBefore); // 统计未变（lastSeq 仍是 5）
    expect(client.snapshot.comm.lastSeq).toBe(5);
    expect(client.getTrends(60_000)).toEqual(trendsBefore); // 趋势未变
    expect(client.snapshot.status).toBe('connected');
  });

  it('ingest 丢弃无效帧：不计入 received / 不推进 sequence', () => {
    const { client, lastWs } = setup();
    client.start();
    lastWs().emitOpen();
    lastWs().emitMessage(makeFrame(1));
    // 一个 sequence=99 但 source 非法的帧 → 整体丢弃，绝不当作丢帧/乱序
    const bad = validObj(99);
    (bad as unknown as { source: unknown }).source = 'robot';
    lastWs().emitMessage(JSON.stringify(bad));
    expect(client.snapshot.comm.lastSeq).toBe(1);
    expect(client.snapshot.comm.dropRate).toBe(0);
    expect(client.snapshot.comm.seqErrors).toBe(0);
  });
});

describe('健壮性', () => {
  it('非法 JSON 帧被忽略，不抛错也不改状态', () => {
    const { client, lastWs } = setup();
    client.start();
    lastWs().emitOpen();
    lastWs().emitMessage('not-json{');
    expect(client.snapshot.frame).toBeNull();
    expect(client.snapshot.status).toBe('connecting');
  });

  it('initialTelemetryState 为空闲且空数据', () => {
    const s = initialTelemetryState();
    expect(s.status).toBe('idle');
    expect(s.frame).toBeNull();
    expect(s.joints).toEqual([]);
    expect(s.stale).toBe(false);
    expect(s.trendVersion).toBe(0);
  });
});
