import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, RefreshCw, Square } from 'lucide-react';
import {
  getAgingLogStatus,
  getAgingRecordingStatus,
  startAgingRecording,
  stopAgingRecording,
  toErrorMessage,
  type AgingLogStatus,
  type AgingRecordingStatus,
} from '../../api/client';
import { formatDuration } from '../../utils/format';
import { useApp } from '../../state/AppContext';
import { useTelemetry } from '../../state/TelemetryContext';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { StatusBadge } from '../common/StatusBadge';

const EMPTY_STATUS: AgingRecordingStatus = {
  available: false,
  status: 'inactive',
  phase: 'idle',
  action_id: null,
  action_name: null,
  loop_mode: null,
  round: 0,
  completed_rounds: 0,
  target_rounds: null,
  stop_requested: false,
  recording_status: 'inactive',
  session_path: null,
  started_at: null,
  updated_at: new Date(0).toISOString(),
  frames_written: 0,
  rows_written: 0,
  error: null,
  root: null,
  recording_error: null,
  temp_limit_c: null,
  temp_protection: null,
  elapsed_seconds: null,
};

const PHASE_LABELS: Record<string, string> = {
  idle: '空闲',
  preflight: '检查中',
  initial_homing: '首次回零',
  positioning: '动作起点',
  running_trajectory: '执行动作',
  returning_home: '回零',
  verifying_home: '零位确认',
  interval_wait: '间隔等待',
  stopping: '停止回零',
  fault_homing: '故障回零',
  completed: '已完成',
  held: '安全保持',
  failed: '异常',
};

export function AgingPage() {
  const { state, pushLog } = useApp();
  const { wsStatus, stale, comm } = useTelemetry();
  const processedActions = useMemo(
    () => state.recordedActions.filter((action) => action.version === 'processed' && !action.demoOnly),
    [state.recordedActions],
  );
  const [selectedActionId, setSelectedActionId] = useState('');
  const [loopMode, setLoopMode] = useState<'count' | 'duration' | 'infinite'>('count');
  const [loopCount, setLoopCount] = useState(10);
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [intervalSec, setIntervalSec] = useState(2);
  const [tempLimitC, setTempLimitC] = useState('');
  const [logStatus, setLogStatus] = useState<AgingLogStatus | null>(null);
  const [runtime, setRuntime] = useState<AgingRecordingStatus>(EMPTY_STATUS);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<'start' | 'stop' | null>(null);

  /** 跟踪上一次轮询到的错误，用于检测新错误时 pushLog */
  const prevErrorRef = useRef<string | null>(null);
  const prevPhaseRef = useRef<string>('idle');

  useEffect(() => {
    if (!selectedActionId && processedActions[0]) setSelectedActionId(processedActions[0].id);
  }, [processedActions, selectedActionId]);

  const active = ['starting', 'running', 'stopping'].includes(runtime.status);
  const telemetryReady = state.connection.status === 'connected'
    && state.connection.source === 'motorbridge'
    && state.connection.capabilities.telemetry
    && wsStatus === 'connected'
    && !stale
    && comm.lastArrivalMs !== null;
  const selectedAction = processedActions.find((action) => action.id === selectedActionId) ?? null;
  const canStart = Boolean(
    selectedAction
      && telemetryReady
      && state.connection.capabilities.control
      && state.connection.capabilities.homing
      && logStatus?.aging_execution_available
      && !active,
  );

  const refresh = useCallback(async () => {
    try {
      const [logs, status] = await Promise.all([getAgingLogStatus(), getAgingRecordingStatus()]);
      setLogStatus(logs);
      setRuntime(status);
      setError(null);

      // 检测后端新错误 → 推送到前端操作日志
      const err = status.error || status.recording_error;
      if (err && err !== prevErrorRef.current) {
        prevErrorRef.current = err;
        pushLog({
          type: 'aging',
          result: 'error',
          title: '老化异常',
          detail: err,
          meta: { phase: status.phase ?? 'unknown', elapsed_seconds: status.elapsed_seconds ?? 0 },
        });
      }
      if (!err && status.phase === 'completed' && prevPhaseRef.current !== 'completed') {
        pushLog({
          type: 'aging',
          result: 'success',
          title: '老化完成',
          detail: `已完成 ${status.completed_rounds ?? 0} 轮，耗时 ${status.elapsed_seconds != null ? Math.round(status.elapsed_seconds) : '?'} 秒`,
          meta: { completed_rounds: status.completed_rounds, elapsed_seconds: status.elapsed_seconds ?? 0 },
        });
      }
      prevPhaseRef.current = status.phase ?? 'idle';
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [pushLog]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, active ? 500 : 2000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const submit = async () => {
    if (!confirmAction || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = confirmAction === 'start' && selectedAction
        ? await startAgingRecording(selectedAction.id, {
            loop_mode: loopMode,
            ...(loopMode === 'count' ? { loop_count: loopCount } : {}),
            ...(loopMode === 'duration' ? { duration_minutes: durationMinutes } : {}),
            interval_sec: intervalSec,
            ...(tempLimitC.trim() !== '' ? { temp_limit_c: Number(tempLimitC) } : {}),
          })
        : await stopAgingRecording();
      setRuntime(result);
      setConfirmAction(null);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const badge = runtime.status === 'running'
    ? { variant: 'online' as const, label: '运行中' }
    : runtime.status === 'held' || runtime.status === 'error'
      ? { variant: 'error' as const, label: runtime.status === 'held' ? '安全保持' : '异常' }
      : runtime.status === 'starting' || runtime.status === 'stopping'
        ? { variant: 'busy' as const, label: runtime.status === 'starting' ? '启动中' : '停止中' }
        : { variant: 'offline' as const, label: runtime.status === 'completed' ? '已完成' : '未启动' };

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">老化</h1>
        <div className="row">
          <button className="btn btn--ghost" type="button" onClick={() => void refresh()} disabled={loading} aria-label="刷新"><RefreshCw size={15} /></button>
          <StatusBadge variant={badge.variant}>{badge.label}</StatusBadge>
        </div>
      </div>

      {error && <div className="state-box state-box--error" role="alert"><div className="state-box__desc">{error}</div></div>}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, .85fr)', gap: 'var(--space-4)' }}>
        <section className="card">
          <div className="card-header"><div className="card-title">设置</div></div>
          <div className="card-body stack stack--lg">
            <div className="field">
              <label className="field-label" htmlFor="aging-action">动作</label>
              <select id="aging-action" className="select" value={selectedActionId} disabled={active} onChange={(event) => setSelectedActionId(event.target.value)}>
                <option value="">请选择</option>
                {processedActions.map((action) => <option key={action.id} value={action.id}>{action.name}</option>)}
              </select>
            </div>

            <div className="motion-center__form-grid">
              <div className="field">
                <label className="field-label" htmlFor="aging-mode">循环</label>
                <select id="aging-mode" className="select" value={loopMode} disabled={active} onChange={(event) => setLoopMode(event.target.value as typeof loopMode)}>
                  <option value="count">次数</option>
                  <option value="duration">时长</option>
                  <option value="infinite">无限</option>
                </select>
              </div>
              {loopMode === 'count' && <NumberField id="aging-count" label="次数" value={loopCount} min={1} step={1} disabled={active} onChange={setLoopCount} />}
              {loopMode === 'duration' && <NumberField id="aging-duration" label="分钟" value={durationMinutes} min={1} step={1} disabled={active} onChange={setDurationMinutes} />}
              <NumberField id="aging-interval" label="间隔（秒）" value={intervalSec} min={0} step={0.5} disabled={active} onChange={setIntervalSec} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="aging-temp-limit">温度保护 °C（可选，任一关节达此温度自动停止并归位）</label>
              <input id="aging-temp-limit" className="input" type="number" min="0" step="0.5" value={tempLimitC} placeholder="留空 = 不限制" disabled={active} onChange={(event) => setTempLimitC(event.target.value)} />
            </div>

            {!active
              ? <button className="btn btn--primary btn--lg" type="button" disabled={!canStart || submitting} onClick={() => setConfirmAction('start')}><Play size={16} /> 启动老化</button>
              : <button className="btn btn--warning btn--lg" type="button" disabled={runtime.status === 'stopping' || submitting} onClick={() => setConfirmAction('stop')}><Square size={16} /> 停止老化</button>}
          </div>
        </section>

        <section className="card">
          <div className="card-header"><div className="card-title">状态</div></div>
          <div className="card-body stack stack--md">
            <Row label="阶段" value={PHASE_LABELS[runtime.phase] ?? runtime.phase} />
            <Row label="动作" value={runtime.action_name ?? '—'} />
            <Row label="当前轮次" value={String(runtime.round)} />
            <Row label="已完成" value={String(runtime.completed_rounds)} />
            <Row label="已老化" value={runtime.elapsed_seconds != null ? formatDuration(runtime.elapsed_seconds * 1000) : '—'} />
            <Row label="遥测帧" value={String(runtime.frames_written)} />
            <Row label="数据行" value={String(runtime.rows_written)} />
            {runtime.temp_limit_c !== null && <Row label="温度保护" value={`${runtime.temp_limit_c} °C`} />}
            {runtime.temp_protection && (
              <div className="state-box state-box--error" role="alert">
                <div className="state-box__desc">
                  温度保护触发：M{runtime.temp_protection.joint} 温度 {runtime.temp_protection.temperature_c.toFixed(1)}°C 达到上限 {runtime.temp_protection.limit_c}°C，已自动停止并归位。
                </div>
              </div>
            )}
            {(runtime.error || runtime.recording_error) && <div className="state-box state-box--error" role="alert"><div className="state-box__desc">{runtime.error ?? runtime.recording_error}</div></div>}
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction === 'start' ? '确认启动老化？' : '确认停止老化？'}
        description={
          confirmAction === 'start'
            ? '启动老化将自动退出零力矩模式（若正在使用），随后以 MIT 模式执行动作。'
            : undefined
        }
        confirmLabel="确认"
        confirmVariant={confirmAction === 'start' ? 'primary' : 'warning'}
        busy={submitting}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => { void submit(); }}
      />
    </div>
  );
}

function NumberField({ id, label, value, min, step, disabled, onChange }: { id: string; label: string; value: number; min: number; step: number; disabled: boolean; onChange: (value: number) => void }) {
  return <div className="field"><label className="field-label" htmlFor={id}>{label}</label><input id={id} className="input" type="number" min={min} step={step} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} /></div>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="kv"><span className="kv__k">{label}</span><span className="kv__v mono">{value}</span></div>;
}
