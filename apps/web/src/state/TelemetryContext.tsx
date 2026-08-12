import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from './AppContext';
import { resolveTelemetryWsUrl } from '../api/client';
import {
  TelemetryClient,
  initialTelemetryState,
  shouldOpenTelemetry,
  type TelemetryClientState,
} from '../telemetry/telemetryClient';
import type { TrendSeries, TrendWindow, WsTelemetryStatus } from '../types';

/**
 * WebSocket 只读遥测全局状态（/ws/robot/telemetry）。
 *
 * 生命周期（全部自动，无开始/停止开关）：
 * - 仅当 connection.status === 'connected' 且 capabilities.telemetry === true 时自动连接；
 * - robot 断开 / 能力失效 / 页面卸载 → TelemetryClient.stop()，之后绝不重连；
 * - 网络中断 → 客户端内部有上限指数退避重连；
 * - 数据陈旧（stale）→ ArmModel 停止更新 URDF，监控页展示通信异常。
 *
 * WebSocket 错误只影响遥测状态，绝不改变 robot connection（要求 17）。
 */

const WINDOW_SECONDS: Record<TrendWindow, number> = { '10s': 10, '30s': 30, '2m': 120 };

interface TelemetryContextValue {
  /** 最近一帧（未连接/无数据时为 null） */
  frame: TelemetryClientState['frame'];
  /** 每关节最新值（顺序 = 电机 ID 1..7） */
  joints: TelemetryClientState['joints'];
  /** WebSocket 连接状态（与 robot connection 相互独立） */
  wsStatus: WsTelemetryStatus;
  /** 数据是否陈旧（超过阈值未更新） */
  stale: boolean;
  /** 通信统计：频率 / 延迟 / 丢帧率 / 乱序数 */
  comm: TelemetryClientState['comm'];
  /** 是否模拟遥测（source === 'simulation'） */
  isSimulation: boolean;
  /** 是否真机遥测（source === 'motorbridge'） */
  isMotorbridge: boolean;
  /** 趋势时间窗（不提供开始开关） */
  windowSize: TrendWindow;
  setWindowSize: (w: TrendWindow) => void;
  /** 趋势版本号：仅在写入趋势点时递增（降采样后 ≤10Hz），供图表订阅重渲染 */
  trendTick: number;
  /** 读取趋势（按时间窗过滤后的环形缓冲快照） */
  getTrends: () => TrendSeries[];
  clearTrend: () => void;
  /**
   * 显式恢复遥测连接（Phase 7A）：当重连耗尽 maxAttempts 进入 fail-closed
   * error 终态后，自动重连已真正停止；调用本方法重置退避并立即重连。
   * 连接正常时调用为幂等无副作用。
   */
  restartTelemetry: () => void;
}

const TelemetryContext = createContext<TelemetryContextValue | null>(null);

export function TelemetryProvider({ children }: { children: ReactNode }) {
  const { state } = useApp();
  const connection = state.connection;
  // 仅当连接状态 connected 且 capabilities.telemetry 时自动连接（要求 1）
  const connectionStatus = connection.status;
  const telemetryCapability = connection.capabilities.telemetry === true;
  const shouldConnect = shouldOpenTelemetry({
    status: connectionStatus,
    capabilities: { telemetry: telemetryCapability },
  });
  const isSimulation = connection.source === 'simulation';
  const isMotorbridge = connection.source === 'motorbridge';

  const [snap, setSnap] = useState<TelemetryClientState>(initialTelemetryState);
  const [windowSize, setWindowSize] = useState<TrendWindow>('30s');
  const clientRef = useRef<TelemetryClient | null>(null);

  useEffect(() => {
    if (!shouldConnect) {
      // 未连接 / 无遥测能力：保持空闲，绝不打开 WebSocket
      const existing = clientRef.current;
      clientRef.current = null;
      existing?.stop();
      setSnap(initialTelemetryState());
      return undefined;
    }
    if (clientRef.current !== null) return undefined;
    const client = new TelemetryClient({
      url: resolveTelemetryWsUrl(),
      onChange: (s) => setSnap(s),
    });
    clientRef.current = client;
    client.start();
    return () => {
      // robot 断开 / 能力变化 / 页面卸载：关闭且不再重连
      if (clientRef.current === client) {
        clientRef.current = null;
        client.stop();
        setSnap(initialTelemetryState());
      }
    };
  }, [shouldConnect]);

  const getTrends = useCallback((): TrendSeries[] => {
    const client = clientRef.current;
    if (!client) return [];
    return client.getTrends(WINDOW_SECONDS[windowSize] * 1000);
  }, [windowSize]);

  const clearTrend = useCallback(() => {
    clientRef.current?.clearTrends();
  }, []);

  const restartTelemetry = useCallback(() => {
    clientRef.current?.restart();
  }, []);

  const value = useMemo<TelemetryContextValue>(
    () => ({
      frame: snap.frame,
      joints: snap.joints,
      wsStatus: snap.status,
      stale: snap.stale,
      comm: snap.comm,
      isSimulation,
      isMotorbridge,
      windowSize,
      setWindowSize,
      trendTick: snap.trendVersion,
      getTrends,
      clearTrend,
      restartTelemetry,
    }),
    [snap, isSimulation, isMotorbridge, windowSize, getTrends, clearTrend, restartTelemetry],
  );

  return <TelemetryContext.Provider value={value}>{children}</TelemetryContext.Provider>;
}

export function useTelemetry(): TelemetryContextValue {
  const ctx = useContext(TelemetryContext);
  if (!ctx) throw new Error('useTelemetry must be used within TelemetryProvider');
  return ctx;
}
