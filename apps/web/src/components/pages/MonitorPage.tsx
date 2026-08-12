import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { useTelemetry } from '../../state/TelemetryContext';
import { ArmScene } from '../arm/ArmScene';
import { ResizablePanel } from '../common/ResizablePanel';
import { MetricCard } from '../common/MetricCard';
import { StatusBadge } from '../common/StatusBadge';
import { EmptyState } from '../common/EmptyState';
import { JOINT_TABLE } from '../../data/simulatedTelemetry';
import { formatDeg, formatNumber } from '../../utils/format';
import {
  GRIPPER_CALIBRATION_NOTE,
  GRIPPER_CALIBRATION_STEPS,
  armJointViews,
  computeRobotJointWrites,
} from '../../telemetry/jointTransform';
import type { WsTelemetryStatus } from '../../types';

/** 遥测新鲜度阈值（与 TelemetryContext 的 STALE_MS 保持一致，仅用于本页展示） */
const STALE_MS = 1500;

const WS_STATUS_LABEL: Record<WsTelemetryStatus, string> = {
  idle: '未启用',
  connecting: '连接中',
  connected: '已连接',
  error: '连接异常',
  stale: '数据陈旧',
};

function wsBadgeVariant(s: WsTelemetryStatus): 'online' | 'busy' | 'offline' | 'error' | 'info' {
  switch (s) {
    case 'connected':
      return 'online';
    case 'connecting':
      return 'busy';
    case 'stale':
    case 'error':
      return 'error';
    default:
      return 'offline';
  }
}

export function MonitorPage() {
  const { state } = useApp();
  const { joints, frame, comm, stale, wsStatus, isSimulation, restartTelemetry } =
    useTelemetry();
  const connection = state.connection;
  const connected = connection.status === 'connected';
  const scanning = connection.scanning;
  const telemetryEnabled = connected && connection.capabilities.telemetry;

  // 页面轻量时钟：使"数据年龄"在帧停止到达时持续更新
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  // 映射视图：原始 vs 映射后（ID 1-6）、超限关节、夹爪标定状态（只读纯函数）
  // 注意：所有 hooks 必须在任何提前返回之前无条件执行（Rules of Hooks），
  // 否则连接状态变化（连接/断开切换渲染分支）会因 hooks 数量变化而崩溃。
  const views = useMemo(() => armJointViews(joints), [joints]);
  const mapResult = useMemo(
    () => (frame ? computeRobotJointWrites(frame.joints) : null),
    [frame],
  );

  // 连接门禁：未连接（或扫描请求在途）时不展示实时反馈，避免把未连接状态
  // 呈现为真实在线数据；连接成功后才允许查看监控内容。
  if (!connected) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <h1 className="page-title">实时监控</h1>
            <div className="page-subtitle">三维视窗与电机遥测，监控与三维状态并发运行</div>
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
                    : `请点击顶部「连接机械臂」按钮扫描并连接（${connection.channel} · 期望电机 ID 1–7）。连接成功后，本页监控内容自动可用，无需手动开始。`
              }
            />
          </div>
        </div>
      </div>
    );
  }

  // 后端未提供 telemetry 能力：fail closed，不连接 WebSocket，也不展示任何伪造数据
  if (!telemetryEnabled) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <h1 className="page-title">实时监控</h1>
            <div className="page-subtitle">三维视窗与电机遥测 · 遥测能力未启用</div>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <EmptyState
              variant="empty"
              title="遥测能力未启用"
              desc={`机械臂已连接（${connection.channel}，${connection.source ?? '未知'} 适配器），但后端未提供 telemetry 能力。遥测就绪后本页自动展示真实反馈，不会返回伪造的实时数据。`}
            />
          </div>
        </div>
      </div>
    );
  }

  const ageMs = comm.lastArrivalMs !== null ? Math.max(0, now - comm.lastArrivalMs) : null;

  const outIds = mapResult?.outOfLimitIds ?? [];
  const gripperJoint = joints.find((j) => j.id === 7) ?? null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">实时监控</h1>
          <div className="page-subtitle">
            三维视窗与 WebSocket 只读遥测（/ws/robot/telemetry）· 自动连接，无需手动开始
          </div>
        </div>
        <div className="page-actions">
          <StatusBadge variant={wsBadgeVariant(wsStatus)}>
            遥测 {WS_STATUS_LABEL[wsStatus]}
          </StatusBadge>
          {wsStatus === 'error' && (
            <button
              className="btn btn--warning btn--sm"
              onClick={() => restartTelemetry()}
              aria-label="重试遥测连接"
            >
              重试遥测连接
            </button>
          )}
          {stale && <StatusBadge variant="error">通信异常 · 数据陈旧</StatusBadge>}
        </div>
      </div>

      {/* simulation 源：显著标注模拟遥测，防止误认为真机反馈 */}
      {isSimulation && (
        <div className="param-notice param-notice--info" role="status">
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>当前为模拟遥测（source = simulation）：数据来自后端模拟适配器，不代表真实机械臂状态。</span>
        </div>
      )}

      {/* 映射说明：恒等变换有参考控制栈依据；零位无法远程确认，不假装已标定 */}
      <div className="param-notice param-notice--info" role="note">
        <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>
          J1–J6 映射：urdf = raw × 1 × (+1) + 0（恒等变换，依据：参考控制栈将电机弧度反馈直接用于同一
          URDF 的正/逆运动学）。机械零位取决于现场 set_zero 操作，遥测无法远程确认，故零位按「未验证」标注。
        </span>
      </div>

      {/* 超出 URDF 限位告警（真实值 + 告警，绝不静默伪造正常值） */}
      {outIds.length > 0 && (
        <div className="param-notice param-notice--warning" role="alert">
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            以下关节映射值超出 URDF 限位：{outIds.map((id) => `J${id}`).join('、')}
            。请核对现场零位与电机方向；三维模型按限位截断显示，表格中为真实映射值。
          </span>
        </div>
      )}

      {/* 夹爪（ID 7）待标定告警 */}
      {joints.length > 0 && (
        <div className="param-notice param-notice--warning" role="status">
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{GRIPPER_CALIBRATION_NOTE}</span>
        </div>
      )}

      {/* 通信统计：频率 / 延迟 / 丢帧率 / 乱序 / 数据年龄 */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
        <MetricCard label="通信频率" value={comm.freq.toFixed(1)} unit="Hz" hint="由帧间隔估算" />
        <MetricCard label="延迟" value={comm.latencyMs.toFixed(0)} unit="ms" hint="帧到达间隔" />
        <MetricCard
          label="丢帧率"
          value={(comm.dropRate * 100).toFixed(2)}
          unit="%"
          hint="sequence 跳号统计"
        />
        <MetricCard label="乱序/重复" value={comm.seqErrors} unit="次" hint="sequence 回退统计" />
        <MetricCard
          label="数据年龄"
          value={ageMs === null ? '—' : `${Math.round(ageMs)}`}
          unit={ageMs === null ? '' : 'ms'}
          delta={
            stale
              ? `超过 ${STALE_MS} ms：通信异常，URDF 已暂停更新`
              : frame
                ? `sequence ${frame.sequence}`
                : '等待首帧…'
          }
        />
      </div>

      {/* 三维视窗：由实时遥测帧驱动（stale 时自动停止更新）；高度可拖拽调整（4K 屏放大模型） */}
      <div className="card" style={{ marginBottom: 'var(--space-3)' }}>
        <div className="card-body" style={{ padding: 0 }}>
          <ResizablePanel
            initialHeight={420}
            storageKey="rebotarm:monitor-arm-height"
            className="resizable-panel"
          >
            <ArmScene height="100%" />
          </ResizablePanel>
        </div>
      </div>

      {/* 每关节实时表：位置 / 速度 / 扭矩 / 电机温度 / 状态码 */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">关节实时遥测</div>
            <div className="card-subtitle">
              原始位置 = 电机反馈 rad · 映射位置 = raw × scale × direction + offset（J1–J6 为恒等变换）·
              位置并列展示供真机核对 · 速度 rad/s · 扭矩 Nm · 温度 °C · 状态码 0 = 正常
            </div>
          </div>
          {frame && (
            <span className="tertiary" style={{ fontSize: 'var(--font-xs)' }}>
              帧时间 {new Date(frame.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
            </span>
          )}
        </div>
        <div className="card-body">
          {joints.length === 0 ? (
            <EmptyState
              variant={wsStatus === 'connecting' ? 'loading' : 'empty'}
              title={wsStatus === 'connecting' ? '正在连接遥测…' : '等待遥测数据'}
              desc="WebSocket 遥测连接建立后，本表自动展示每关节实时反馈。"
            />
          ) : (
            <div className="table-scroll">
              <table className="motor-table" aria-label="关节实时遥测表">
                <thead>
                  <tr>
                    <th style={{ width: 90 }}>关节</th>
                    <th style={{ textAlign: 'right' }}>原始位置</th>
                    <th style={{ textAlign: 'right' }}>映射位置</th>
                    <th style={{ width: 110 }}>映射状态</th>
                    <th style={{ textAlign: 'right' }}>速度</th>
                    <th style={{ textAlign: 'right' }}>扭矩</th>
                    <th style={{ textAlign: 'right' }}>温度 (MOS)</th>
                    <th style={{ textAlign: 'right' }}>温度 (转子)</th>
                    <th style={{ width: 70, textAlign: 'right' }}>状态码</th>
                    <th style={{ width: 80 }}>数据</th>
                  </tr>
                </thead>
                <tbody>
                  {joints.map((j) => {
                    const def = JOINT_TABLE.find((d) => d.id === j.id);
                    const abnormal = j.statusCode !== null && j.statusCode !== 0;
                    const view = views.find((v) => v.id === j.id);
                    const isGripper = j.id === 7;
                    return (
                      <tr key={j.id}>
                        <td className="mono">{def?.name ?? `M${j.id}`}</td>
                        <td style={{ textAlign: 'right' }}>
                          {j.position === null
                            ? '—'
                            : isGripper
                              ? `${formatNumber(j.position, 3)} rad`
                              : formatDeg(j.position, 1)}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {isGripper
                            ? '—'
                            : view && view.mapped !== null
                              ? formatDeg(view.mapped, 1)
                              : '—'}
                        </td>
                        <td>
                          {isGripper ? (
                            <StatusBadge variant="busy">夹爪待标定</StatusBadge>
                          ) : j.position === null || !view ? (
                            <StatusBadge variant="offline">无数据</StatusBadge>
                          ) : view.limitStatus === 'out' ? (
                            <StatusBadge variant="error">超出限位</StatusBadge>
                          ) : (
                            <StatusBadge variant="online">限位内</StatusBadge>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {j.velocity === null ? '—' : `${formatNumber(j.velocity, 2)} rad/s`}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {j.torque === null ? '—' : `${formatNumber(j.torque, 2)} Nm`}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {j.tempMos === null ? '—' : `${formatNumber(j.tempMos, 1)} °C`}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {j.tempRotor === null ? '—' : `${formatNumber(j.tempRotor, 1)} °C`}
                        </td>
                        <td
                          className="mono"
                          style={{
                            textAlign: 'right',
                            color: abnormal ? 'var(--color-danger)' : undefined,
                            fontWeight: abnormal ? 600 : undefined,
                          }}
                        >
                          {j.statusCode ?? '—'}
                        </td>
                        <td>
                          {j.freshness === 'fresh' ? (
                            <StatusBadge variant="online">新鲜</StatusBadge>
                          ) : (
                            <StatusBadge variant="offline">无数据</StatusBadge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 夹爪手动标定步骤（只读控制台；步骤必须由用户在实机执行，Claude/前端不操作机械臂） */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">夹爪映射待标定 · 手动标定步骤</div>
            <div className="card-subtitle">
              缺失依据：电机角度→开度传动比、左右手指方向、机械零位、最大开度实测。
              当前仅展示 ID 7 原始弧度（当前值：
              {gripperJoint && gripperJoint.position !== null
                ? `${formatNumber(gripperJoint.position, 3)} rad`
                : '—'}
              ），夹爪模型动画已暂停。
            </div>
          </div>
        </div>
        <div className="card-body">
          <ol className="stack" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
            {GRIPPER_CALIBRATION_STEPS.map((step) => (
              <li key={step} className="tertiary" style={{ fontSize: 'var(--font-sm)' }}>
                {step}
              </li>
            ))}
            <li className="tertiary" style={{ fontSize: 'var(--font-sm)', fontWeight: 600 }}>
              注意：以上步骤均需人工在实机上完成；本控制台为只读遥测，不会下发任何电机运动指令。
            </li>
          </ol>
        </div>
      </div>
    </div>
  );
}
