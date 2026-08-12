import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Crosshair, Plug, PlugZap, Loader2, ShieldAlert } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { useTelemetry } from '../../state/TelemetryContext';
import { Modal } from '../common/Modal';
import { StatusBadge } from '../common/StatusBadge';
import { JOINT_TABLE } from '../../data/simulatedTelemetry';
import { armJointViews } from '../../telemetry/jointTransform';
import { formatDateTime, formatDeg, formatNumber } from '../../utils/format';
import type { MitGainChange, MotorId } from '../../types';

// ===== 常量与校验 =====
const KP_MIN = 0;
const KP_MAX = 500;
const KD_MIN = 0;
const KD_MAX = 50;
// 遥测新鲜度阈值：快照时间戳距今不超过该值才允许写入
const FRESH_MAX_MS = 1500;

/**
 * 编辑期间保留原始文本；仅当输入合法时解析成功。
 * 非法输入原样保留在输入框并显示错误，绝不静默修正。
 */
function parseGain(raw: string, min: number, max: number): number | null {
  const t = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  if (!Number.isFinite(v)) return null;
  return v >= min && v <= max ? v : null;
}

function motorIdHex(id: MotorId): string {
  return `0x${id.toString(16).toUpperCase().padStart(2, '0')}`;
}

interface DraftPair {
  kp: string;
  kd: string;
}

export function ParameterPage() {
  const {
    state,
    describeMode,
    applyMitGains,
    setMechanicalZero,
    startConnectionScan,
    disconnectRobot,
    zeroTorqueStatus,
    startZeroTorque,
    stopZeroTorque,
  } = useApp();
  const { joints, comm, stale } = useTelemetry();
  // J1–J6 映射视图（原始 vs 映射后）：恒等变换 + URDF 限位，见 telemetry/jointTransform.ts
  const telemetryViews = useMemo(() => armJointViews(joints), [joints]);
  // 遥测显示门禁：已连接且后端具备 telemetry 能力时展示 WebSocket 遥测；
  // simulation 源显式标注"模拟遥测"，motorbridge（或未知源）绝不以模拟遥测冒充真实反馈
  const showTelemetry = state.connection.status === 'connected' && state.connection.capabilities.telemetry;
  const isSimSource = state.connection.source === 'simulation';

  // 页面轻量时钟：每 250ms 触发一次重渲染，使遥测新鲜度（ageMs）在
  // 快照停止更新（遥测暂停 / 链路静默中断）时仍持续更新，
  // 防止 fresh / canWrite 永久保留旧值。卸载时清理计时器。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  // 输入草稿：页面级保留；已应用参数存于 AppContext，切换页面不丢失
  const [drafts, setDrafts] = useState<Record<MotorId, DraftPair>>(() => {
    const init = {} as Record<MotorId, DraftPair>;
    for (const p of state.jointParams) {
      init[p.motorId] = { kp: String(p.kp), kd: String(p.kd) };
    }
    return init;
  });

  // 二次确认弹窗：只需在风险提示后点击确认，不要求输入短语。
  const [confirmApplyOpen, setConfirmApplyOpen] = useState(false);
  const [confirmZeroOpen, setConfirmZeroOpen] = useState(false);
  const [zeroTorqueAction, setZeroTorqueAction] = useState<'start' | 'stop' | null>(null);

  // 持久化写入结果提示（页面级显著展示）
  const [applyNotice, setApplyNotice] = useState<{ at: number; count: number } | null>(null);
  const [zeroNotice, setZeroNotice] = useState<{ at: number } | null>(null);

  const emergency = state.emergencyStop;
  const safety = state.safety;
  const safetyStatus = safety.status;
  const commLostHold = safetyStatus === 'hold_comm_lost';
  const homingFailedHold = safetyStatus === 'hold_homing_failed';
  const disableFailedHold = safetyStatus === 'hold_disable_failed';
  const safetyActive = safetyStatus !== 'idle' && safetyStatus !== 'disconnected';
  const isIdle = state.controlMode === 'idle';

  // 机械臂连接（真实后端 API）：只有 ID 1–7 全部响应才算已连接
  const connection = state.connection;
  const connected = connection.status === 'connected';
  const scanning = connection.scanning;

  // 断开只释放后端连接，不在浏览器中模拟停止、回零或失能。
  // 运行任务由各自的后端流程停止，空闲时才允许直接断开。
  const canDisconnect =
    connected &&
    !scanning &&
    !safetyActive &&
    !emergency &&
    isIdle &&
    !state.recording &&
    !state.playback &&
    !state.aging;
  const disconnectBlockReason = !connected
    ? '未连接，无需断开'
    : scanning
      ? '扫描请求在途，请等待完成'
      : emergency
        ? '紧急失能已触发，不能手动断开'
        : safetyActive
          ? '安全序列 / 保持进行中，请等待完成'
          : !isIdle || state.recording || state.playback || state.aging
            ? '任务运行中，请先停止任务'
            : null;

  // 遥测新鲜度：距最近一帧到达的时间（依赖页面时钟持续更新）。
  const ageMs =
    comm.lastArrivalMs !== null ? Math.max(0, now - comm.lastArrivalMs) : Number.POSITIVE_INFINITY;
  const fresh = ageMs <= FRESH_MAX_MS && !stale;

  const zeroTorqueActive = ['starting', 'active', 'stopping'].includes(zeroTorqueStatus.status);
  // 持久增益写入独立于完整 control 能力，且与零力矩状态互斥。
  const canWrite =
    connected && state.connection.capabilities.persistent_gain_write && isIdle && !safetyActive && !emergency && fresh && !zeroTorqueActive;
  const canSetZero = connected && state.connection.capabilities.set_zero && isIdle && !safetyActive && !emergency && fresh && !zeroTorqueActive;
  const writeBlockReason = !connected
    ? '机械臂未连接：请先点击顶部「连接机械臂」或下方「开始扫描并连接」'
    : !state.connection.capabilities.persistent_gain_write
      ? '后端未开放已核实的持久增益接口'
      : emergency
        ? '紧急失能已触发，请先复位后再写入参数'
        : safetyActive
          ? '安全序列 / 保持进行中，完成后才能写入参数'
          : !isIdle
            ? `当前模式为「${describeMode(state.controlMode)}」，仅空闲模式允许参数写入`
            : !fresh
              ? '遥测数据不新鲜，等待链路恢复后才能写入'
              : null;

  // 解析全部草稿并与已应用参数比较：只应用已变更且合法的关节
  const { changes, invalidCount } = useMemo(() => {
    const list: MitGainChange[] = [];
    let invalid = 0;
    for (const p of state.jointParams) {
      const d = drafts[p.motorId];
      const kp = parseGain(d.kp, KP_MIN, KP_MAX);
      const kd = parseGain(d.kd, KD_MIN, KD_MAX);
      if (kp === null || kd === null) {
        invalid += 1;
        continue;
      }
      if (kp !== p.kp || kd !== p.kd) {
        const def = JOINT_TABLE.find((j) => j.id === p.motorId);
        list.push({
          motorId: p.motorId,
          name: def?.name ?? `M${p.motorId}`,
          fromKp: p.kp,
          fromKd: p.kd,
          toKp: kp,
          toKd: kd,
        });
      }
    }
    return { changes: list, invalidCount: invalid };
  }, [drafts, state.jointParams]);

  const setDraft = (id: MotorId, field: 'kp' | 'kd', raw: string) => {
    setDrafts((prev) => {
      const next: Record<MotorId, DraftPair> = { ...prev };
      next[id] = field === 'kp' ? { ...next[id], kp: raw } : { ...next[id], kd: raw };
      return next;
    });
  };

  // 批量填充臂关节（J1–J6）为 RS 默认值；不覆盖夹爪
  const fillArmDefaults = () => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const p of state.jointParams) {
        if (p.motorId === 7) continue;
        next[p.motorId] = { kp: String(p.defaultKp), kd: String(p.defaultKd) };
      }
      return next;
    });
  };

  // 恢复 RS 默认值：全部 7 个关节（含夹爪）
  const fillAllDefaults = () => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const p of state.jointParams) {
        next[p.motorId] = { kp: String(p.defaultKp), kd: String(p.defaultKd) };
      }
      return next;
    });
  };

  // 重置输入为当前已应用值
  const resetDraftsToApplied = () => {
    const init = {} as Record<MotorId, DraftPair>;
    for (const p of state.jointParams) {
      init[p.motorId] = { kp: String(p.kp), kd: String(p.kd) };
    }
    setDrafts(init);
  };

  const openApplyConfirm = () => {
    setConfirmApplyOpen(true);
  };

  const handleApplyConfirm = () => {
    if (changes.length === 0 || !canWrite) return;
    void applyMitGains(changes).then(() => {
      setApplyNotice({ at: Date.now(), count: changes.length });
      setConfirmApplyOpen(false);
    });
  };

  const openZeroConfirm = () => {
    setConfirmZeroOpen(true);
  };

  const handleZeroConfirm = () => {
    if (!canSetZero) return;
    void setMechanicalZero().then(() => {
      setZeroNotice({ at: Date.now() });
      setConfirmZeroOpen(false);
    }).catch(() => undefined);
  };

  const openZeroTorqueConfirm = (action: 'start' | 'stop') => {
    setZeroTorqueAction(action);
  };

  const handleZeroTorqueConfirm = () => {
    if (!zeroTorqueAction || (zeroTorqueAction === 'start' && !zeroTorqueCanStart)) return;
    const action = zeroTorqueAction;
    setZeroTorqueAction(null);
    void (action === 'start' ? startZeroTorque() : stopZeroTorque()).catch(() => undefined);
  };

  // 摘要数据
  const onlineCount = joints.filter((j) => j.statusCode === 0).length;
  const modeSummary = emergency ? '紧急失能' : commLostHold ? '通信丢失保持' : describeMode(state.controlMode);
  const zeroTorqueCanStart = connected && state.connection.capabilities.zero_torque && fresh && !emergency && !safetyActive && isIdle && zeroTorqueStatus.status === 'inactive';

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">参数配置</h1>
          <div className="page-subtitle">
            只读状态摘要 · 持久位置/速度环增益 · 后端零力矩模式 · 整机机械零位
          </div>
        </div>
        <div className="page-actions">
          <StatusBadge variant={state.connection.source === 'motorbridge' ? 'online' : 'info'}>
            {state.connection.source === 'motorbridge' ? 'motorbridge' : '模拟适配器'}
          </StatusBadge>
          <StatusBadge variant={canWrite ? 'online' : 'busy'}>
            {canWrite ? '持久增益可写' : '写入受限'}
          </StatusBadge>
        </div>
      </div>

      <div className={`card ${zeroTorqueStatus.status === 'active' ? 'card--danger' : ''}`}>
        <div className="card-header">
          <div>
            <div className="card-title"><ShieldAlert size={16} /> 零力矩模式</div>
            <div className="card-subtitle">后端 50Hz 控制循环 · enable_all → Mode.MIT → send_mit(0,0,0,0,0)</div>
          </div>
          <StatusBadge variant={zeroTorqueStatus.status === 'active' ? 'error' : zeroTorqueStatus.status === 'error' ? 'error' : zeroTorqueStatus.status === 'inactive' ? 'offline' : 'busy'}>
            {zeroTorqueStatus.status === 'active' ? '危险：零力矩中' : zeroTorqueStatus.status}
          </StatusBadge>
        </div>
        <div className="card-body">
          {zeroTorqueStatus.error && <div className="param-notice param-notice--danger" role="alert">{zeroTorqueStatus.error}</div>}
          <div className="row row--wrap" style={{ gap: 'var(--space-2)' }}>
            {zeroTorqueStatus.status === 'active' || zeroTorqueStatus.status === 'starting' || zeroTorqueStatus.status === 'stopping' ? (
              <button className="btn btn--danger" onClick={() => openZeroTorqueConfirm('stop')} disabled={zeroTorqueStatus.status !== 'active'}>
                退出零力矩模式
              </button>
            ) : (
              <button className="btn btn--danger" onClick={() => openZeroTorqueConfirm('start')} disabled={!zeroTorqueCanStart}>
                进入零力矩模式
              </button>
            )}
            <span className="field-hint">{state.connection.capabilities.zero_torque ? `后端循环频率 ${zeroTorqueStatus.frequency_hz}Hz` : '后端未开放零力矩能力'}</span>
          </div>
        </div>
      </div>

      {/* 机械臂连接（真实后端 API）：本页开始入口 = 开始扫描并连接 */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">
              <PlugZap size={16} /> 机械臂连接
            </div>
            <div className="card-subtitle">通道 {connection.channel} · 期望电机 ID 1–7 · 状态来自后端 /api/robot/*</div>
          </div>
          {connected ? (
            <StatusBadge variant="online">已连接 · {connection.found_ids.length}/7</StatusBadge>
          ) : scanning ? (
            <StatusBadge variant="busy">扫描中…（等待后端返回）</StatusBadge>
          ) : connection.status === 'partial' ? (
            <StatusBadge variant="error">部分连接 · {connection.found_ids.length}/7</StatusBadge>
          ) : connection.status === 'error' ? (
            <StatusBadge variant="error">连接错误</StatusBadge>
          ) : (
            <StatusBadge variant="offline">未连接</StatusBadge>
          )}
        </div>
        <div className="card-body">
          <div className="stack stack--sm">
            <div className="row row--wrap" style={{ gap: 'var(--space-4)' }}>
              <span className="kv">
                <span className="kv__k">发现</span>
                <span className="kv__v mono">{connection.found_ids.length} / {connection.expected_ids.length}</span>
              </span>
              <span className="kv">
                <span className="kv__k">扫描开始</span>
                <span className="kv__v mono">{connection.started_at ? formatDateTime(new Date(connection.started_at).getTime()) : '—'}</span>
              </span>
              <span className="kv">
                <span className="kv__k">扫描完成</span>
                <span className="kv__v mono">{connection.completed_at ? formatDateTime(new Date(connection.completed_at).getTime()) : '—'}</span>
              </span>
              <span className="kv">
                <span className="kv__k">适配器</span>
                <span className="kv__v mono">{connection.source ?? '—'}{connection.source === 'simulation' ? '（模拟）' : ''}</span>
              </span>
            </div>

            {/* 统一安全状态机阶段：防止误认为已断开 */}
            {safetyActive && (
              <div
                className="param-notice"
                style={
                  commLostHold || homingFailedHold || disableFailedHold
                    ? { background: 'var(--color-danger-dim)', borderColor: 'var(--color-danger-border)', color: 'var(--color-danger)' }
                    : undefined
                }
              >
                <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>
                  安全状态机进行中：
                  {safetyStatus === 'stopping'
                    ? '正在停止任务'
                    : safetyStatus === 'homing'
                      ? `正在回零 ${Math.round(safety.homingProgress * 100)}%`
                      : safetyStatus === 'disabling'
                        ? '正在失能'
                        : safetyStatus === 'disconnecting'
                          ? '正在调用断开接口'
                          : safetyStatus === 'hold_comm_lost'
                            ? '通信丢失安全保持'
                            : safetyStatus === 'hold_homing_failed'
                              ? '回零失败保持'
                              : safetyStatus === 'hold_disable_failed'
                                ? '失能/断开失败保持'
                                : '进行中'}
                  {safety.failureDetail ? ` — ${safety.failureDetail}` : ''}
                  。此阶段连接尚未断开，参数写入与运行模式已禁用。
                </span>
              </div>
            )}

            {/* 409 / 网络错误：不得伪装成已连接 */}
            {connection.error && !scanning && (
              <div className="param-notice param-notice--danger" role="alert">
                <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>连接请求失败：{connection.error}</span>
              </div>
            )}

            <div className="row row--wrap" aria-label="逐 ID 扫描结果">
              {connection.expected_ids.map((id) => {
                const found = connection.found_ids.includes(id);
                const missing = connection.missing_ids.includes(id);
                return (
                  <span
                    key={id}
                    className="tag"
                    style={
                      found
                        ? { color: 'var(--status-online)', borderColor: 'var(--color-online-border)', background: 'var(--color-online-dim)' }
                        : missing
                          ? { color: 'var(--color-danger)', borderColor: 'var(--color-danger-border)', background: 'var(--color-danger-dim)' }
                          : undefined
                    }
                  >
                    ID {id}{found ? ' · 已发现' : missing ? ' · 缺失' : ''}
                  </span>
                );
              })}
            </div>

            {connection.missing_ids.length > 0 && (connection.status === 'partial' || connection.status === 'error') && (
              <div className="param-notice param-notice--danger" role="alert">
                <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>
                  缺失电机 ID：{connection.missing_ids.join('、')}。仅当 1–7 全部发现时才视为已连接。
                  {connection.message ? `（${connection.message}）` : ''}
                </span>
              </div>
            )}

            <div className="row row--wrap" style={{ gap: 'var(--space-2)' }}>
              <button
                className={`btn ${connected ? '' : 'btn--primary'}`}
                onClick={() => { void startConnectionScan(); }}
                disabled={scanning}
                title="POST /api/robot/scan：只读扫描（不下发任何运动指令）"
              >
                {scanning ? <Loader2 size={14} className="spin" /> : <PlugZap size={14} />}
                {scanning
                  ? '扫描中…'
                  : connected
                    ? '重新扫描'
                    : connection.status === 'partial' || connection.status === 'error'
                      ? '重新扫描并连接'
                      : '开始扫描并连接'}
              </button>
              <button
                className="btn"
                onClick={disconnectRobot}
                disabled={!canDisconnect}
                title={disconnectBlockReason ?? undefined}
              >
                断开连接
              </button>
            </div>
            <span className="tertiary" style={{ fontSize: 'var(--font-xs)' }}>
              {connected
                ? `已连接：${connection.channel} 上 ID 1–7 全部响应（${connection.source ?? '未知'} 适配器）。参数写入与运行模式均以此为门禁。`
                : connection.message ?? '仅当电机 ID 1–7 全部响应时才视为已连接；连接成功后参数写入与运行模式才可用。'}
            </span>
          </div>
        </div>
      </div>

      {/* 只读状态摘要 */}
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">
              <Activity size={16} /> 只读状态摘要
            </div>
            <div className="card-subtitle">适配器 · CAN · 模式 · 遥测新鲜度 · 电机在线</div>
          </div>
          <span className="tertiary" style={{ fontSize: 'var(--font-xs)' }}>
            读取状态对应 motorbridge get_state / request_feedback（status_code）
          </span>
        </div>
        <div className="card-body">
          <div className="grid grid--6" style={{ marginBottom: 'var(--space-4)' }}>
            <div>
              <div className="metric-label">适配器</div>
              <div className="mono" style={{ fontSize: 'var(--font-lg)', fontWeight: 600 }}>
                simulation
              </div>
              <div className="field-hint">motorbridge 模拟</div>
            </div>
            <div>
              <div className="metric-label">CAN 总线</div>
              <div className="mono" style={{ fontSize: 'var(--font-lg)', fontWeight: 600 }}>
                can0
              </div>
              <div className="field-hint">未来 Linux adapter 接入</div>
            </div>
            <div>
              <div className="metric-label">当前模式</div>
              <div style={{ fontSize: 'var(--font-lg)', fontWeight: 600, color: emergency || commLostHold ? 'var(--color-danger)' : undefined }}>
                {modeSummary}
              </div>
            </div>
            <div>
              <div className="metric-label">遥测新鲜度{isSimSource && showTelemetry ? '（模拟）' : ''}</div>
              {!showTelemetry ? (
                <div className="mono tertiary" style={{ fontSize: 'var(--font-lg)', fontWeight: 600 }}>未接入</div>
              ) : (
                <div
                  className="mono"
                  style={{ fontSize: 'var(--font-lg)', fontWeight: 600, color: fresh ? undefined : 'var(--color-danger)' }}
                >
                  {fresh
                    ? `新鲜 · ${Math.round(ageMs)} ms`
                    : Number.isFinite(ageMs)
                      ? `过期 · ${(ageMs / 1000).toFixed(1)} s 未更新`
                      : '等待遥测帧…'}
                </div>
              )}
              <div className="field-hint">{!showTelemetry ? '未连接或后端无 telemetry 能力' : stale ? '遥测超时 · 通信异常' : `阈值 ${FRESH_MAX_MS} ms`}</div>
            </div>
            <div>
              <div className="metric-label">电机在线</div>
              {!showTelemetry ? (
                <div className="mono tertiary" style={{ fontSize: 'var(--font-lg)', fontWeight: 600 }}>未接入</div>
              ) : (
                <div className="mono" style={{ fontSize: 'var(--font-lg)', fontWeight: 600 }}>
                  {onlineCount} / 7
                </div>
              )}
              <div className="field-hint">状态码为 0 视为在线</div>
            </div>
            <div>
              <div className="metric-label">反馈主机 ID</div>
              <div className="mono" style={{ fontSize: 'var(--font-lg)', fontWeight: 600 }}>
                0xFD
              </div>
              <div className="field-hint">电机 ID 0x01–0x07</div>
            </div>
          </div>

          <div className="param-two-col">
            {/* 实时遥测表：来自 WebSocket /ws/robot/telemetry；未接入时不展示任何数据 */}
            <div>
              <div className="section-title" style={{ marginBottom: 'var(--space-2)' }}>
                实时遥测{isSimSource && showTelemetry ? '（模拟）' : ''}
                <span className="section-title__hint">位置 · 速度 · 温度 · 状态码</span>
              </div>
              {!showTelemetry ? (
                <div className="param-notice" style={{ background: 'var(--color-warning-dim)', borderColor: 'var(--color-warning-border)', color: 'var(--color-warning)' }}>
                  <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>未连接或后端未提供 telemetry 能力：不展示任何模拟遥测数据。</span>
                </div>
              ) : joints.length === 0 ? (
                <div className="param-notice" style={{ background: 'var(--color-warning-dim)', borderColor: 'var(--color-warning-border)', color: 'var(--color-warning)' }}>
                  <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>遥测已启用但尚未收到任何帧，等待 WebSocket 数据…</span>
                </div>
              ) : (
                <div className="table-scroll">
                  <table className="motor-table" aria-label="实时遥测表">
                    <thead>
                      <tr>
                        <th style={{ width: 90 }}>关节</th>
                        <th style={{ textAlign: 'right' }}>原始位置</th>
                        <th style={{ textAlign: 'right' }}>映射位置</th>
                        <th style={{ textAlign: 'right' }}>速度</th>
                        <th style={{ textAlign: 'right' }}>温度</th>
                        <th style={{ width: 70, textAlign: 'right' }}>状态码</th>
                      </tr>
                    </thead>
                    <tbody>
                      {joints.map((j) => {
                        const def = JOINT_TABLE.find((d) => d.id === j.id);
                        const view = telemetryViews.find((v) => v.id === j.id);
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
                                ? '待标定'
                                : view && view.mapped !== null
                                  ? `${formatDeg(view.mapped, 1)}${view.limitStatus === 'out' ? ' ⚠' : ''}`
                                  : '—'}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {j.velocity === null ? '—' : `${formatNumber(j.velocity, 2)} rad/s`}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {j.tempMos === null ? '—' : `${formatNumber(j.tempMos, 1)} °C`}
                            </td>
                            <td className="mono" style={{ textAlign: 'right' }}>
                              {j.statusCode ?? '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* 参数表：型号 · CAN ID */}
            <div>
              <div className="section-title" style={{ marginBottom: 'var(--space-2)' }}>
                参数一览
                <span className="section-title__hint">型号 · CAN ID</span>
              </div>
              <div className="table-scroll">
                <table className="motor-table" aria-label="参数一览表">
                  <thead>
                    <tr>
                      <th style={{ width: 80 }}>关节</th>
                      <th>型号</th>
                      <th style={{ textAlign: 'right' }}>电机 ID</th>
                      <th style={{ textAlign: 'right' }}>主机 ID</th>
                      <th style={{ textAlign: 'right' }}>最近写入</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.jointParams.map((p) => {
                      const def = JOINT_TABLE.find((j) => j.id === p.motorId);
                      return (
                        <tr key={p.motorId}>
                          <td className="mono">{def?.name ?? `M${p.motorId}`}</td>
                          <td className="mono">{p.model}</td>
                          <td className="mono" style={{ textAlign: 'right' }}>
                            {motorIdHex(p.motorId)}
                          </td>
                          <td className="mono" style={{ textAlign: 'right' }}>
                            0x{p.hostId.toString(16).toUpperCase()}
                          </td>
                          <td style={{ textAlign: 'right', fontSize: 'var(--font-sm)' }}>
                            {p.lastUpdated ? formatDateTime(p.lastUpdated) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="param-two-col">
        {/* 持久位置/速度环增益编辑 */}
        <div className="stack stack--lg">
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">
                  <Plug size={16} /> 持久增益编辑（位置 KP / 速度 KP）
                </div>
                <div className="card-subtitle">
                  位置环 KP {KP_MIN}–{KP_MAX}（0x701E） · 速度环 KP {KD_MIN}–{KP_MAX}（0x701F） · 写入后校验并保存
                </div>
              </div>
              <span className="tertiary" style={{ fontSize: 'var(--font-xs)' }}>
                {changes.length} 个关节待写入{invalidCount > 0 ? ` · ${invalidCount} 个输入非法` : ''}
              </span>
            </div>
            <div className="card-body">
              <div className="stack stack--lg">
                {writeBlockReason && (
                  <div className="param-notice param-notice--danger" role="alert">
                    <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span>当前禁止写入：{writeBlockReason}</span>
                  </div>
                )}

                {applyNotice && (
                  <div className="param-notice param-notice--success" role="status">
                    <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span>
                      持久参数写入成功（{formatDateTime(applyNotice.at)}）：已更新 {applyNotice.count}{' '}
                      个关节。未调用 send_mit；如需使能，必须另行由用户点击顶部人工使能。
                    </span>
                  </div>
                )}

                <div className="table-scroll">
                  <table className="motor-table" aria-label="持久化位置环与速度环增益编辑表">
                    <thead>
                      <tr>
                        <th style={{ width: 130 }}>关节</th>
                        <th style={{ textAlign: 'right' }}>当前 KP / KD</th>
                        <th>KP 输入</th>
                        <th>KD 输入</th>
                        <th style={{ width: 90 }}>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.jointParams.map((p) => {
                        const def = JOINT_TABLE.find((j) => j.id === p.motorId);
                        const d = drafts[p.motorId];
                        const kpV = parseGain(d.kp, KP_MIN, KP_MAX);
                        const kdV = parseGain(d.kd, KD_MIN, KD_MAX);
                        const kpInvalid = kpV === null;
                        const kdInvalid = kdV === null;
                        const changed = !kpInvalid && !kdInvalid && (kpV !== p.kp || kdV !== p.kd);
                        return (
                          <tr key={p.motorId}>
                            <td>
                              <div className="mono">{def?.name ?? `M${p.motorId}`}</div>
                              <div className="field-hint">
                                {def?.label} · {p.model} · {motorIdHex(p.motorId)}
                              </div>
                            </td>
                            <td className="mono" style={{ textAlign: 'right' }}>
                              {p.kp} / {p.kd}
                            </td>
                            <td>
                              <div className="param-input-cell">
                                <input
                                  className="input mono"
                                  type="text"
                                  inputMode="decimal"
                                  value={d.kp}
                                  aria-label={`关节 ${def?.name ?? p.motorId} KP`}
                                  aria-invalid={kpInvalid}
                                  aria-describedby={`param-kp-hint-${p.motorId}`}
                                  onChange={(e) => setDraft(p.motorId, 'kp', e.target.value)}
                                />
                                <span
                                  className="field-hint"
                                  id={`param-kp-hint-${p.motorId}`}
                                  style={kpInvalid ? { color: 'var(--color-danger)' } : undefined}
                                >
                                  {kpInvalid
                                    ? `非法：需为 ${KP_MIN}–${KP_MAX} 的数值；已保留，未写入`
                                    : `范围 ${KP_MIN}–${KP_MAX}`}
                                </span>
                              </div>
                            </td>
                            <td>
                              <div className="param-input-cell">
                                <input
                                  className="input mono"
                                  type="text"
                                  inputMode="decimal"
                                  value={d.kd}
                                  aria-label={`关节 ${def?.name ?? p.motorId} KD`}
                                  aria-invalid={kdInvalid}
                                  aria-describedby={`param-kd-hint-${p.motorId}`}
                                  onChange={(e) => setDraft(p.motorId, 'kd', e.target.value)}
                                />
                                <span
                                  className="field-hint"
                                  id={`param-kd-hint-${p.motorId}`}
                                  style={kdInvalid ? { color: 'var(--color-danger)' } : undefined}
                                >
                                  {kdInvalid
                                    ? `非法：需为 ${KD_MIN}–${KD_MAX} 的数值；已保留，未写入`
                                    : `范围 ${KD_MIN}–${KD_MAX}`}
                                </span>
                              </div>
                            </td>
                            <td>
                              {kpInvalid || kdInvalid ? (
                                <StatusBadge variant="error">输入非法</StatusBadge>
                              ) : changed ? (
                                <StatusBadge variant="busy">待写入</StatusBadge>
                              ) : (
                                <span className="tag">未变更</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="row row--wrap" style={{ gap: 'var(--space-2)' }}>
                  <button
                    className="btn btn--primary"
                    disabled={!canWrite || changes.length === 0}
                    onClick={openApplyConfirm}
                    title={writeBlockReason ?? (changes.length === 0 ? '没有已变更且合法的关节' : '打开二次确认')}
                  >
                    应用变更（{changes.length} 个关节）
                  </button>
                  <button className="btn" onClick={fillArmDefaults} title="把 J1–J6 输入填为 RS 默认值，不覆盖夹爪；仅修改输入框">
                    批量填充臂关节（J1–J6）
                  </button>
                  <button className="btn" onClick={fillAllDefaults} title="把全部 7 个关节输入填为 RS 默认值；仅修改输入框">
                    恢复 RS 默认值
                  </button>
                  <button className="btn btn--ghost" onClick={resetDraftsToApplied} title="丢弃草稿，恢复为当前已应用值">
                    重置输入为当前值
                  </button>
                </div>
                <span className="tertiary" style={{ fontSize: 'var(--font-xs)' }}>
                  批量填充与恢复默认只修改输入框草稿；实际写入需点击「应用变更」，仅应用已变更关节，并完成二次确认。
                  {invalidCount > 0 ? `当前有 ${invalidCount} 个关节输入非法，不会被应用。` : ''}
                </span>
              </div>
            </div>
          </div>

          {/* 接口映射（只读） */}
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">
                  <Activity size={16} /> 接口映射（只读）
                </div>
                <div className="card-subtitle">未来 Linux adapter / motorbridge 映射 · 当前均为 simulation</div>
              </div>
            </div>
            <div className="card-body card-body--flush">
              <div className="table-scroll">
                <table className="motor-table" aria-label="接口映射表">
                  <thead>
                    <tr>
                      <th style={{ width: 130 }}>功能</th>
                      <th>motorbridge 语义</th>
                      <th style={{ width: 110 }}>当前来源</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>读取状态</td>
                      <td>get_state / request_feedback / status_code</td>
                      <td>
                        <span className="tag">simulation</span>
                      </td>
                    </tr>
                    <tr>
                      <td>持久增益写入</td>
                      <td>motorbridge 0.5.1 `robstride_write_param_f32`：位置环 KP 0x701E、速度环 KP 0x701F；逐项读取校验后 `store_parameters`</td>
                      <td>
                        <span className="tag">motorbridge</span>
                      </td>
                    </tr>
                    <tr>
                      <td>整机机械零位</td>
                      <td>RebotArm.set_zero：内部先 disable_all 失能全部电机，再逐电机 set_zero_position</td>
                      <td>
                        <span className="tag">simulation</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {/* 整机机械零位（危险操作卡） */}
        <div className="stack stack--lg">
          <div className="card card--danger">
            <div className="card-header">
              <div>
                <div className="card-title">
                  <Crosshair size={16} /> 整机机械零位
                </div>
                <div className="card-subtitle">危险操作 · 改变 7 个电机的位置参考 · 仅整机，不提供单关节零位</div>
              </div>
              <StatusBadge variant={canSetZero ? 'online' : 'busy'}>{canSetZero ? '可进入' : '受限'}</StatusBadge>
            </div>
            <div className="card-body">
              <div className="stack stack--lg">
                <ul className="stack stack--sm" style={{ paddingLeft: 'var(--space-4)', listStyle: 'disc', color: 'var(--text-secondary)', fontSize: 'var(--font-sm)', lineHeight: 'var(--leading-normal)' }}>
                  <li>会改变全部 7 个电机的位置参考（整机 set_zero_position），请确保机械臂已人工摆放到机械零位。</li>
                  <li>参考流程逐电机执行 disable → 读取 0x7019 → set_zero_position → store_parameters。</li>
                  <li>仅在空闲、无急停、无安全保持且遥测新鲜时可进入设置流程。</li>
                  <li>这是持久化写入；确认前请托住机械臂并准备硬件断电，失败时按现场流程处置。</li>
                </ul>

                {state.zeroLastSetAt !== null && (
                  <div className="kv">
                    <span className="kv__k">上次真实设置</span>
                    <span className="kv__v mono">{formatDateTime(state.zeroLastSetAt)}</span>
                  </div>
                )}

                {zeroNotice && (
                  <div className="param-notice param-notice--success" role="status">
                    <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span>
                      机械零位已由后端写入并持久化（{formatDateTime(zeroNotice.at)}）。
                    </span>
                  </div>
                )}

                <button
                  className="btn btn--danger btn--lg"
                  disabled={!canSetZero}
                  onClick={openZeroConfirm}
                  title={writeBlockReason ?? '打开整机机械零位二次确认'}
                >
                  <Crosshair size={16} /> 设置整机机械零位
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 二次确认：应用持久化增益变更 */}
      <Modal
        open={confirmApplyOpen}
        title="应用持久化增益变更？"
        onClose={() => setConfirmApplyOpen(false)}
        footer={
          <>
            <button className="btn btn--ghost" onClick={() => setConfirmApplyOpen(false)}>
              取消
            </button>
            <button
              className="btn btn--warning"
              disabled={changes.length === 0 || !canWrite}
              onClick={handleApplyConfirm}
            >
              确认写入（{changes.length} 个关节）
            </button>
          </>
        }
      >
        <div className="section-title" style={{ marginBottom: 'var(--space-2)' }}>
          变更前后摘要
          <span className="section-title__hint">仅包含已变更关节</span>
        </div>
        <div className="table-scroll" style={{ marginBottom: 'var(--space-3)' }}>
          <table className="motor-table" aria-label="变更前后摘要表">
            <thead>
              <tr>
                <th style={{ width: 90 }}>关节</th>
                <th style={{ textAlign: 'right' }}>KP（前 → 后）</th>
                <th style={{ textAlign: 'right' }}>KD（前 → 后）</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.motorId}>
                  <td className="mono">{c.name}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {c.fromKp} → {c.toKp}
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {c.fromKd} → {c.toKd}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

      </Modal>

      {/* 二次确认：整机机械零位 */}
      <Modal
        open={confirmZeroOpen}
        title="设置整机机械零位？"
        onClose={() => setConfirmZeroOpen(false)}
        footer={
          <>
            <button className="btn btn--ghost" onClick={() => setConfirmZeroOpen(false)}>
              取消
            </button>
            <button
              className="btn btn--danger"
              disabled={!canSetZero}
              onClick={handleZeroConfirm}
            >
              确认设置机械零位
            </button>
          </>
        }
      >
        <div className="section-title" style={{ marginBottom: 'var(--space-2)' }}>
          7 关节当前位置
        </div>
        <div className="table-scroll" style={{ marginBottom: 'var(--space-3)' }}>
          <table className="motor-table" aria-label="7 关节当前位置表">
            <thead>
              <tr>
                <th style={{ width: 90 }}>关节</th>
                <th>描述</th>
                <th style={{ textAlign: 'right' }}>当前位置</th>
              </tr>
            </thead>
            <tbody>
              {joints.map((j) => {
                const def = JOINT_TABLE.find((d) => d.id === j.id);
                return (
                  <tr key={j.id}>
                    <td className="mono">{def?.name ?? `M${j.id}`}</td>
                    <td>{def?.label ?? '—'}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>
                      {j.position === null
                        ? '—'
                        : j.id === 7
                          ? `${formatNumber(j.position, 3)} rad（夹爪待标定）`
                          : formatDeg(j.position, 1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="field-hint">请在点击确认前再次确认机械臂已人工摆放到机械零位、被可靠支撑且工作区安全。</div>
      </Modal>

      <Modal
        open={zeroTorqueAction !== null}
        title={zeroTorqueAction === 'start' ? '确认进入零力矩模式？' : '确认退出零力矩模式？'}
        onClose={() => setZeroTorqueAction(null)}
        footer={
          <>
            <button className="btn btn--ghost" onClick={() => setZeroTorqueAction(null)}>取消</button>
            <button
              className="btn btn--danger"
              disabled={zeroTorqueAction === 'start' && !zeroTorqueCanStart}
              onClick={handleZeroTorqueConfirm}
            >
              {zeroTorqueAction === 'start' ? '确认进入' : '确认退出'}
            </button>
          </>
        }
      >
        <div className="field-hint">点击确认即表示现场已托住机械臂、清空工作区并准备好硬件断电。</div>
      </Modal>
    </div>
  );
}
