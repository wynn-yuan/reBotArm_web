import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleStop, Pause, Play, Save, Trash2 } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { useTelemetry } from '../../state/TelemetryContext';
import { ArmScene } from '../arm/ArmScene';
import { ResizablePanel } from '../common/ResizablePanel';
import { EmptyState } from '../common/EmptyState';
import { StatusBadge } from '../common/StatusBadge';
import { formatClock, formatDuration } from '../../utils/format';
import { retimeTrajectory, type TrajectoryRetimeResult } from '../../motion/trajectoryRetime';
import { URDF_REVOLUTE_LIMITS } from '../../telemetry/jointTransform';
import type { ControlMode, LiveJoint, RecordedAction, RecordConfig } from '../../types';

export const RECORDING_FREQUENCY = 100;
/** 连续抗抖滤波窗口；100 Hz 下 13 帧约等于 130 ms。 */
export const DEFAULT_SMOOTHING_WINDOW = 13;
export const JOINT_LABELS = ['J1 基座', 'J2 肩部', 'J3 肘部', 'J4 腕滚', 'J5 腕俯', 'J6 腕转', 'J7 夹爪'];
export const ACTION_JOINT_LIMITS = [
  URDF_REVOLUTE_LIMITS.joint1,
  URDF_REVOLUTE_LIMITS.joint2,
  URDF_REVOLUTE_LIMITS.joint3,
  URDF_REVOLUTE_LIMITS.joint4,
  URDF_REVOLUTE_LIMITS.joint5,
  URDF_REVOLUTE_LIMITS.joint6,
  { lower: 0, upper: 3 },
] as const;

export interface RecordGateInput {
  connected: boolean;
  zeroTorqueActive: boolean;
  emergency: boolean;
  safetyActive: boolean;
  mode: ControlMode;
  actionName: string;
  positions: readonly number[] | null;
  operatorConfirmed: boolean;
}

/** Pure UI gate: recording is local-only but still requires the live safety conditions. */
export function canStartOfflineRecording(input: RecordGateInput): boolean {
  return input.connected
    && input.zeroTorqueActive
    && !input.emergency
    && !input.safetyActive
    && input.mode === 'idle'
    && input.actionName.trim().length > 0
    && input.positions !== null
    && input.positions.length === 7
    && input.positions.every(Number.isFinite)
    && input.operatorConfirmed;
}

/** Convert the latest live telemetry into joint-major raw samples. Never synthesizes values. */
export function collectTelemetryPositions(joints: readonly LiveJoint[]): number[] | null {
  if (joints.length !== 7) return null;
  const byId = new Map(joints.map((joint) => [joint.id, joint.position]));
  const positions = Array.from({ length: 7 }, (_, index) => byId.get(index + 1) ?? null);
  return positions.every((position): position is number => position !== null && Number.isFinite(position))
    ? positions
    : null;
}

export interface JointLimitDiagnostic {
  joint: string;
  lower: number;
  upper: number;
  min: number | null;
  max: number | null;
  inLimit: boolean;
}

export function diagnoseJointLimits(trails: readonly (readonly number[])[]): JointLimitDiagnostic[] {
  return ACTION_JOINT_LIMITS.map((limit, joint) => {
    const values = trails[joint] ?? [];
    const min = values.length > 0 ? Math.min(...values) : null;
    const max = values.length > 0 ? Math.max(...values) : null;
    return {
      joint: JOINT_LABELS[joint],
      lower: limit.lower,
      upper: limit.upper,
      min,
      max,
      inLimit: min !== null && max !== null && min >= limit.lower && max <= limit.upper,
    };
  });
}

export function createProcessedAction(
  raw: RecordedAction,
  result: TrajectoryRetimeResult,
  config: { maxJointVelocity: number[]; maxProgressSpeed: number; maxAcceleration: number },
  createdAt = Date.now(),
): RecordedAction {
  return {
    id: `processed-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    name: `${raw.name} · 处理后`,
    createdAt,
    durationMs: result.duration * 1000,
    sampleCount: result.sampleCount,
    samplingHz: result.diagnostics.outputFrequency,
    jointCount: 7,
    trails: result.trails.map((trail) => [...trail]),
    version: 'processed',
    rawActionId: raw.id,
    processing: { ...config, outputFrequency: result.diagnostics.outputFrequency },
  };
}

function makeDefaultVelocities(): number[] {
  return [1, 1, 1, 1, 1, 1, 1];
}

export function MotionCenterPage() {
  const {
    state,
    startRecord,
    stopRecord,
    recordTick,
    recordCountdownDone,
    saveProcessedAction,
    deleteAction,
    safetyActive,
    startZeroTorque,
    stopZeroTorque,
    zeroTorqueStatus,
  } = useApp();
  const { joints, stale } = useTelemetry();
  const [actionName, setActionName] = useState('');
  const [countdownSec, setCountdownSec] = useState(3);
  const [countdownLeft, setCountdownLeft] = useState(0);
  const [selectedRawId, setSelectedRawId] = useState<string | null>(null);
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(null);
  const [velocities, setVelocities] = useState(makeDefaultVelocities);
  const [targetProgressSpeed, setTargetProgressSpeed] = useState(0.8);
  const [maxAcceleration, setMaxAcceleration] = useState(1.5);
  const [overallSpeed, setOverallSpeed] = useState(1);
  const [retimeResult, setRetimeResult] = useState<TrajectoryRetimeResult | null>(null);
  const [retimeError, setRetimeError] = useState<string | null>(null);
  const [preserveTiming, setPreserveTiming] = useState(true);
  const [returnHome, setReturnHome] = useState(true);
  const [smoothingWindow, setSmoothingWindow] = useState(DEFAULT_SMOOTHING_WINDOW);
  const [previewProgress, setPreviewProgress] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewSpeed, setPreviewSpeed] = useState(1);

  const livePositions = useMemo(() => collectTelemetryPositions(joints), [joints]);
  const freshPositions = stale ? null : livePositions;
  const livePositionsRef = useRef<number[] | null>(freshPositions);
  useEffect(() => {
    livePositionsRef.current = freshPositions;
  }, [freshPositions]);

  const connected = state.connection.status === 'connected';
  const emergency = state.emergencyStop;
  const recording = state.recording;
  const isRecording = state.controlMode === 'teach_record' && recording !== null;
  const isCountdown = recording?.status === 'countdown';
  const zeroTorqueActive = zeroTorqueStatus.status === 'active';
  const canRecord = canStartOfflineRecording({
    connected,
    zeroTorqueActive,
    emergency,
    safetyActive,
    mode: state.controlMode,
    actionName,
    positions: freshPositions,
    operatorConfirmed: true,
  });

  const rawActions = useMemo(
    () => state.recordedActions.filter((action) => action.version !== 'processed' && !action.demoOnly),
    [state.recordedActions],
  );
  const selectedRaw = rawActions.find((action) => action.id === selectedRawId) ?? rawActions[0] ?? null;
  const previewAction = state.recordedActions.find((action) => action.id === selectedPreviewId)
    ?? selectedRaw
    ?? state.recordedActions[0]
    ?? null;

  useEffect(() => {
    if (!selectedRawId && rawActions[0]) setSelectedRawId(rawActions[0].id);
  }, [rawActions, selectedRawId]);

  useEffect(() => {
    if (!selectedPreviewId && previewAction) setSelectedPreviewId(previewAction.id);
  }, [previewAction, selectedPreviewId]);

  useEffect(() => {
    if (!recording || recording.status !== 'countdown' || !recording.countdownEndsAt) {
      setCountdownLeft(0);
      return;
    }
    const tick = () => setCountdownLeft(Math.max(0, Math.ceil((recording.countdownEndsAt! - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    if (!recording || recording.status !== 'countdown' || !recording.countdownEndsAt) return;
    if (recording.countdownEndsAt <= Date.now() && countdownLeft === 0) recordCountdownDone();
  }, [countdownLeft, recordCountdownDone, recording]);

  useEffect(() => {
    if (!recording || recording.status !== 'recording') return;
    const timer = window.setInterval(() => {
      const sample = livePositionsRef.current;
      if (sample) {
        recordTick([...sample]);
      }
    }, 1000 / RECORDING_FREQUENCY);
    return () => window.clearInterval(timer);
  }, [recordTick, recording]);

  useEffect(() => {
    setPreviewPlaying(false);
    setPreviewProgress(0);
  }, [previewAction?.id]);

  useEffect(() => {
    if (!previewPlaying || !previewAction) return;
    const durationMs = Math.max(1, previewAction.durationMs);
    const timer = window.setInterval(() => {
      setPreviewProgress((current) => {
        const next = current + (50 * previewSpeed) / durationMs;
        if (next >= 1) {
          setPreviewPlaying(false);
          return 1;
        }
        return next;
      });
    }, 50);
    return () => window.clearInterval(timer);
  }, [previewAction, previewPlaying, previewSpeed]);

  const previewPositions = useMemo(() => {
    if (!previewAction) return null;
    const sample = Math.min(
      previewAction.sampleCount - 1,
      Math.max(0, Math.round(previewProgress * Math.max(0, previewAction.sampleCount - 1))),
    );
    return previewAction.trails.map((trail) => trail[sample] ?? trail[trail.length - 1] ?? 0);
  }, [previewAction, previewProgress]);

  const handleStartRecording = useCallback(() => {
    if (!canRecord) return;
    const config: RecordConfig = { name: actionName.trim(), samplingHz: RECORDING_FREQUENCY, countdownSec };
    startZeroTorque().then(() => {
      startRecord(config);
    }).catch(() => {
      startRecord(config); // 零力矩启动失败也继续录制
    });
  }, [actionName, canRecord, countdownSec, startRecord, startZeroTorque]);

  const handleProcess = useCallback(() => {
    if (!selectedRaw) {
      setRetimeError('请先选择一个 raw 原始动作。');
      return;
    }
    try {
      const sampleTimes = selectedRaw.timedSamples?.length === selectedRaw.sampleCount
        ? selectedRaw.timedSamples.map((sample) => sample.t)
        : undefined;
      const result = retimeTrajectory({
        trails: selectedRaw.trails,
        samplingHz: selectedRaw.samplingHz,
        sampleTimes,
        maxJointVelocity: velocities,
        maxProgressSpeed: targetProgressSpeed,
        maxAcceleration,
        outputFrequency: RECORDING_FREQUENCY,
        jointLimits: ACTION_JOINT_LIMITS,
        overallSpeedScale: overallSpeed,
        smoothingWindow,
        keypointEpsilon: smoothingWindow <= 7 ? 0.04 : smoothingWindow <= 13 ? 0.08 : 0.15,
        maxKeypoints: 48,
        preserveRecordedTiming: preserveTiming,
        returnHome,
        homePosition: [0, 0, 0, 0, 0, 0, 0],
      });
      setRetimeError(null);
      setRetimeResult(result);
    } catch (error) {
      setRetimeResult(null);
      setRetimeError(error instanceof Error ? error.message : String(error));
    }
  }, [maxAcceleration, preserveTiming, returnHome, selectedRaw, smoothingWindow, targetProgressSpeed, velocities, overallSpeed]);

  const handleSaveProcessed = () => {
    if (!selectedRaw || !retimeResult) return;
    const action = createProcessedAction(selectedRaw, retimeResult, {
      maxJointVelocity: [...velocities],
      maxProgressSpeed: targetProgressSpeed,
      maxAcceleration,
    });
    saveProcessedAction(action);
    setSelectedPreviewId(action.id);
  };

  const limitDiagnostics = retimeResult ? diagnoseJointLimits(retimeResult.trails) : selectedRaw ? diagnoseJointLimits(selectedRaw.trails) : [];
  const recordingDuration = recording ? Math.max(0, Date.now() - recording.startedAt) : 0;

  return (
    <div className="page motion-center-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">动作中心</h1>
        </div>
        <StatusBadge variant={isRecording ? 'online' : safetyActive || emergency ? 'error' : 'offline'}>
          {isRecording ? isCountdown ? `录制倒计时 ${countdownLeft}s` : '正在零力矩录制' : '离线动作工作区'}
        </StatusBadge>
      </div>

      <div className="motion-center__layout">
        <div className="motion-center__controls">
          <section className="card">
            <div className="card-header">
              <div className="card-title"><CircleStop size={16} /> 零力矩拖拽录制</div>
              <StatusBadge variant={isRecording ? 'online' : 'offline'}>{isRecording ? '录制中' : '待命'}</StatusBadge>
            </div>
            <div className="card-body stack">
              <div className="field">
                <label className="field-label" htmlFor="motion-name">动作名称</label>
                <input id="motion-name" className="input" value={actionName} disabled={isRecording} onChange={(event) => setActionName(event.target.value)} placeholder="例如：抓取-抬升-放置" />
              </div>
              <div className="motion-center__form-grid">
                <div className="field"><label className="field-label" htmlFor="motion-frequency">采样频率</label><input id="motion-frequency" className="input" value={`${RECORDING_FREQUENCY} Hz`} readOnly /></div>
                <div className="field"><label className="field-label" htmlFor="motion-countdown">倒计时</label><select id="motion-countdown" className="select" value={countdownSec} disabled={isRecording} onChange={(event) => setCountdownSec(Number(event.target.value))}><option value={0}>立即开始</option><option value={3}>3 s</option><option value={5}>5 s</option></select></div>
              </div>
              {!isRecording ? (
                <button className="btn btn--primary" disabled={!canRecord} onClick={handleStartRecording}><Play size={14} /> 开始录制</button>
              ) : isCountdown ? (
                <button className="btn btn--warning" onClick={() => { stopRecord({ commit: false, reentry: 'idle' }); stopZeroTorque(); }}>取消倒计时</button>
              ) : (
                <button className="btn btn--warning" onClick={() => { stopRecord({ commit: true, reentry: 'idle' }); stopZeroTorque(); }}><Save size={14} /> 结束并保存 raw</button>
              )}
              {isRecording && <div className="motion-center__recording-stats"><span>已采样 <b>{recording?.sampleCount ?? 0}</b> 帧</span><span>时长 <b>{formatDuration(recordingDuration)}</b></span><span>只保存 raw</span></div>}
            </div>
          </section>

          <section className="card">
            <div className="card-header"><div className="card-title">固定速度轨迹处理</div></div>
            <div className="card-body stack">
              <div className="field"><label className="field-label" htmlFor="raw-action">原始动作</label><select id="raw-action" className="select" value={selectedRaw?.id ?? ''} onChange={(event) => { setSelectedRawId(event.target.value); setRetimeResult(null); setRetimeError(null); }}><option value="">请选择 raw 动作</option>{rawActions.map((action) => <option key={action.id} value={action.id}>{action.name} · {action.sampleCount} 帧</option>)}</select></div>
              <div className="motion-center__joint-grid">
                {JOINT_LABELS.map((label, joint) => <div className="field" key={label}><label className="field-label" htmlFor={`velocity-${joint}`}>{label} 速度上限</label><div className="motion-center__number-input"><input id={`velocity-${joint}`} className="input" type="number" min="0.01" step="0.01" value={velocities[joint]} onChange={(event) => setVelocities((current) => current.map((value, index) => index === joint ? Number(event.target.value) : value))} /><span>rad/s</span></div></div>)}
              </div>
              <div className="motion-center__form-grid">
                <div className="field"><label className="field-label" htmlFor="progress-speed">整体目标进度速度</label><div className="motion-center__number-input"><input id="progress-speed" className="input" type="number" min="0.01" step="0.05" value={targetProgressSpeed} onChange={(event) => setTargetProgressSpeed(Number(event.target.value))} /><span>1/s</span></div></div>
                <div className="field"><label className="field-label" htmlFor="max-acceleration">{preserveTiming ? '加速度参考值' : '关节加速度上限'}</label><div className="motion-center__number-input"><input id="max-acceleration" className="input" type="number" min="0.01" step="0.05" value={maxAcceleration} onChange={(event) => setMaxAcceleration(Number(event.target.value))} /><span>rad/s²</span></div></div>
                <div className="field"><label className="field-label" htmlFor="overall-speed">整体速度比例</label><div className="motion-center__number-input"><input id="overall-speed" className="input" type="number" min="0.1" max="2" step="0.05" value={overallSpeed} onChange={(event) => setOverallSpeed(Number(event.target.value))} /><span>×</span></div></div>
                <div className="field"><label className="field-label" htmlFor="smoothing-strength">抗抖强度</label><select id="smoothing-strength" className="select" value={smoothingWindow} onChange={(event) => setSmoothingWindow(Number(event.target.value))}><option value={7}>轻度（约 70 ms）</option><option value={13}>标准（约 130 ms）</option><option value={21}>强力（约 210 ms）</option></select></div>
              </div>
              <label className="field field--checkbox">
                <input type="checkbox" checked={preserveTiming} onChange={(event) => setPreserveTiming(event.target.checked)} />
                <span>保留示教节奏（速度为硬限制，加速度仅提示，仅在超速时延长）</span>
              </label>
              <label className="field field--checkbox">
                <input type="checkbox" checked={returnHome} onChange={(event) => setReturnHome(event.target.checked)} />
                <span>自动补全首尾回零动作</span>
              </label>
              <div className="field-hint">算法会先去除瞬时尖峰，再把滤波曲线简化成少量形状控制点并连续插值。控制点不会造成中途停顿；如需严格限制加速度，请关闭“保留示教节奏”。</div>
              <div className="kv"><span className="kv__k">输出频率</span><span className="kv__v mono">{RECORDING_FREQUENCY} Hz（固定）</span></div>
              <button className="btn btn--primary" disabled={!selectedRaw} onClick={handleProcess}><Play size={14} /> 计算轨迹处理</button>
              {retimeError && <div className="motion-center__error" role="alert">{retimeError}</div>}
              {retimeResult && <RetimeSummary raw={selectedRaw} result={retimeResult} limits={limitDiagnostics} onSave={handleSaveProcessed} />}
            </div>
          </section>
        </div>

        <section className="card motion-center__preview-card">
          <div className="card-header"><div className="card-title">模型预览</div><StatusBadge variant={previewPlaying ? 'online' : 'offline'}>{previewPlaying ? '播放中' : '已暂停'}</StatusBadge></div>
          <div className="card-body card-body--flush">
            <ResizablePanel
              initialHeight={420}
              storageKey="rebotarm:motion-center-preview-height"
              className="resizable-panel"
            >
              <ArmScene height="100%" view="perspective" overridePositions={previewPositions} />
            </ResizablePanel>
          </div>
          <div className="motion-center__preview-controls">
            <select className="select" value={previewAction?.id ?? ''} onChange={(event) => setSelectedPreviewId(event.target.value)} aria-label="选择预览动作"><option value="">暂无动作</option>{state.recordedActions.filter((action) => !action.demoOnly).map((action) => <option key={action.id} value={action.id}>{action.name} · {action.version === 'processed' ? 'processed' : 'raw'}</option>)}</select>
            <button className="btn btn--primary" disabled={!previewAction} onClick={() => setPreviewPlaying((playing) => !playing)}>{previewPlaying ? <Pause size={14} /> : <Play size={14} />} {previewPlaying ? '暂停' : '播放'}</button>
            <label className="motion-center__range-label"><span>进度</span><input type="range" min="0" max="1" step="0.001" value={previewProgress} onChange={(event) => { setPreviewPlaying(false); setPreviewProgress(Number(event.target.value)); }} /></label>
            <select className="select motion-center__speed" value={previewSpeed} onChange={(event) => setPreviewSpeed(Number(event.target.value))} aria-label="预览速度"><option value={0.5}>0.5x</option><option value={1}>1x</option><option value={2}>2x</option></select>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-header"><div className="card-title">动作</div><span className="tertiary">{state.recordedActions.filter((action) => !action.demoOnly).length}</span></div>
        <div className="card-body card-body--flush">{state.recordedActions.filter((action) => !action.demoOnly).length === 0 ? <EmptyState title="暂无动作" desc="" /> : <div className="table-scroll"><table className="motor-table"><thead><tr><th>名称</th><th>版本</th><th>关联 raw</th><th style={{ textAlign: 'right' }}>时长</th><th style={{ textAlign: 'right' }}>样本</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{state.recordedActions.filter((action) => !action.demoOnly).map((action) => <tr key={action.id}><td>{action.name}</td><td><StatusBadge variant={action.version === 'processed' ? 'online' : 'offline'}>{action.version === 'processed' ? 'processed' : 'raw'}</StatusBadge></td><td className="mono tertiary">{action.rawActionId ?? '—'}</td><td style={{ textAlign: 'right' }}>{formatDuration(action.durationMs)}</td><td style={{ textAlign: 'right' }}>{action.sampleCount}</td><td>{formatClock(action.createdAt)}</td><td><div className="row"><button className="btn btn--sm btn--primary" onClick={() => setSelectedPreviewId(action.id)}><Play size={12} /> 预览</button><button className="btn btn--sm" onClick={() => deleteAction(action.id)} disabled={previewAction?.id === action.id}><Trash2 size={12} /> 删除</button></div></td></tr>)}</tbody></table></div>}</div>
      </section>
    </div>
  );
}

function RetimeSummary({ raw, result, limits, onSave }: { raw: RecordedAction | null; result: TrajectoryRetimeResult; limits: JointLimitDiagnostic[]; onSave: () => void }) {
  const warnings = result.diagnostics.warnings;
  const peakVelocities = result.peakVelocities;
  const originalDuration = (raw?.durationMs ?? 0) / 1000;

  return <div className="motion-center__result" aria-live="polite"><div className="motion-center__result-head"><b>处理诊断</b><button className="btn btn--primary btn--sm" onClick={onSave}><Save size={12} /> 保存 processed</button></div><div className="motion-center__metrics">
    <span>原始时长 <b>{formatDuration(originalDuration * 1000 || (raw?.durationMs ?? 0))}</b></span>
    <span>处理后 <b>{formatDuration(result.duration * 1000)}</b></span>
    <span>样本 <b>{raw?.sampleCount ?? 0} → {result.sampleCount}</b></span>
    {(result.diagnostics.smoothingWindowSamples ?? 0) > 0 && <span>抗抖窗口 <b>{result.diagnostics.smoothingWindowSamples} 帧</b></span>}
    {(result.diagnostics.smoothingWindowSamples ?? 0) > 0 && <span>形状控制点 <b>{result.diagnostics.retainedPathPoints}</b></span>}
    {(result.diagnostics.addedHomePoints ?? 0) > 0 && <span>回零段 <b>{result.diagnostics.addedHomePoints}</b></span>}
  </div><div className="motion-center__peaks"><b>各关节峰值速度</b>{peakVelocities.map((peak, joint) => <span key={JOINT_LABELS[joint]}>{JOINT_LABELS[joint]} <em>{peak.toFixed(3)} rad/s</em></span>)}</div><div className="motion-center__limits"><b>限位诊断</b>{limits.map((diagnostic) => <span key={diagnostic.joint} className={diagnostic.inLimit ? 'motion-center__limit-ok' : 'motion-center__limit-bad'}>{diagnostic.joint}: {diagnostic.inLimit ? '通过' : '超限'} ({diagnostic.min?.toFixed(3) ?? '—'} … {diagnostic.max?.toFixed(3) ?? '—'})</span>)}</div>{warnings.length > 0 && <div className="field-hint">提示：{warnings.join('；')}</div>}</div>;
}
