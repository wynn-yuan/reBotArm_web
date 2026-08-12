import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { useTelemetry } from '../../state/TelemetryContext';
import { JointChart } from '../charts/JointChart';
import { StatusBadge } from '../common/StatusBadge';
import { EmptyState } from '../common/EmptyState';
import type { TrendMetric, TrendWindow } from '../../types';

/** 指标选择（顺序即展示顺序）；无开始/停止开关，连接后自动采集 */
const METRICS: Array<{ key: TrendMetric; label: string }> = [
  { key: 'position', label: '位置 (rad)' },
  { key: 'velocity', label: '速度 (rad/s)' },
  { key: 'torque', label: '扭矩 (Nm)' },
  { key: 'temperature', label: '温度 (°C)' },
  { key: 'status', label: '状态/错误码' },
];

const WINDOWS: Array<{ key: TrendWindow; label: string }> = [
  { key: '10s', label: '10 秒' },
  { key: '30s', label: '30 秒' },
  { key: '2m', label: '2 分钟' },
];

export function TrendsPage() {
  const { state } = useApp();
  const {
    getTrends,
    clearTrend,
    trendTick,
    windowSize,
    setWindowSize,
    wsStatus,
    stale,
    isSimulation,
    isMotorbridge,
    comm,
  } = useTelemetry();
  const connection = state.connection;
  const connected = connection.status === 'connected';
  const scanning = connection.scanning;
  const telemetryEnabled = connected && connection.capabilities.telemetry;

  const [metric, setMetric] = useState<TrendMetric>('position');

  // trendTick 仅在写入趋势点时递增（降采样后 ≤10Hz）：
  // 图表重绘被限制在 ≤10Hz，避免 50Hz 帧率下每帧全量重绘
  const series = useMemo(
    () => getTrends().filter((s) => s.metric === metric),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getTrends, metric, trendTick],
  );

  if (!connected) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <h1 className="page-title">关节趋势</h1>
            <div className="page-subtitle">位置 / 速度 / 扭矩 / 温度 / 状态码 · 多关节多窗</div>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <EmptyState
              variant={scanning ? 'loading' : 'empty'}
              title={scanning ? '正在扫描连接机械臂…' : '机械臂未连接'}
              desc={
                scanning
                  ? '扫描请求已发送，等待后端返回（POST /api/robot/scan）。'
                  : connection.error
                    ? `上次连接尝试失败：${connection.error}`
                    : `请点击顶部「连接机械臂」按钮扫描并连接（${connection.channel} · 期望电机 ID 1–7）。连接成功后，本页趋势采集自动开始，无需手动开始。`
              }
            />
          </div>
        </div>
      </div>
    );
  }

  if (!telemetryEnabled) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <h1 className="page-title">关节趋势</h1>
            <div className="page-subtitle">位置 / 速度 / 扭矩 / 温度 / 状态码 · 遥测能力未启用</div>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <EmptyState
              variant="empty"
              title="遥测能力未启用"
              desc={`机械臂已连接（${connection.channel}，${connection.source ?? '未知'} 适配器），但后端未提供 telemetry 能力。遥测就绪后本页自动采集真实反馈，不会展示伪造数据。`}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">关节趋势</h1>
          <div className="page-subtitle">
            WebSocket 遥测自动记录（固定容量环形缓冲）· 曲线按 10 Hz 降采样写入（≤1 点 / 100
            ms），通信统计仍按全帧率计算 · 仅提供时间窗选择，无开始/停止开关
          </div>
        </div>
        <div className="page-actions">
          {isSimulation && <StatusBadge variant="info">模拟遥测（simulation）</StatusBadge>}
          {isMotorbridge && <StatusBadge variant="online">真机遥测（motorbridge）</StatusBadge>}
          {!isSimulation && !isMotorbridge && (
            <StatusBadge variant="busy">{connection.source ?? '未知'} 适配器</StatusBadge>
          )}
          {stale && <StatusBadge variant="error">通信异常 · 数据陈旧</StatusBadge>}
        </div>
      </div>

      {isSimulation && (
        <div className="param-notice param-notice--info" role="status">
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>当前为模拟遥测（source = simulation）：趋势数据来自后端模拟适配器，不代表真实机械臂。</span>
        </div>
      )}

      {stale && (
        <div className="param-notice param-notice--warning" role="status">
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>遥测数据陈旧（超过阈值未更新）：曲线暂停更新，待链路恢复后自动继续。</span>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">指标与时间窗</div>
            <div className="card-subtitle">
              自动记录：位置 / 速度 / 扭矩 / 温度（MOS）/ 状态码 · 当前频率 {comm.freq.toFixed(1)} Hz · 丢帧{' '}
              {(comm.dropRate * 100).toFixed(2)}% · 缓冲 3600 点 ≈ 6 分钟
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            {/* 时间窗选择：只切换视图范围，不是开始/停止开关 */}
            <div role="group" aria-label="时间窗选择" style={{ display: 'flex', gap: 'var(--space-1)' }}>
              {WINDOWS.map((w) => (
                <button
                  key={w.key}
                  className="btn btn--ghost btn--sm"
                  aria-pressed={windowSize === w.key}
                  style={
                    windowSize === w.key
                      ? { borderColor: 'var(--color-accent, #14b8a6)', color: 'var(--color-accent, #14b8a6)' }
                      : undefined
                  }
                  onClick={() => setWindowSize(w.key)}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="card-body">
          <div className="stack stack--lg">
            {/* 指标切换 */}
            <div role="group" aria-label="指标选择" style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
              {METRICS.map((m) => (
                <button
                  key={m.key}
                  className="btn btn--ghost btn--sm"
                  aria-pressed={metric === m.key}
                  style={
                    metric === m.key
                      ? { borderColor: 'var(--color-accent, #14b8a6)', color: 'var(--color-accent, #14b8a6)' }
                      : undefined
                  }
                  onClick={() => setMetric(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {series.length === 0 || series.every((s) => s.data.length === 0) ? (
              <EmptyState
                variant={wsStatus === 'connecting' ? 'loading' : 'empty'}
                title={wsStatus === 'connecting' ? '正在连接遥测…' : '暂无趋势数据'}
                desc="收到遥测帧后自动开始记录并绘制曲线，无需手动开始。"
              />
            ) : (
              <JointChart
                series={series}
                metric={metric}
                windowSize={windowSize}
                onClear={clearTrend}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
