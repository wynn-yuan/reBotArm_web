import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from 'react';
import type {
  AgingConfig,
  AgingState,
  ConnectionState,
  ControlMode,
  JointParam,
  LogEntry,
  MitGainChange,
  MotorId,
  PlaybackState,
  RecordedAction,
  RecordConfig,
  RecordingState,
  RobotConnection,
  ZeroTorqueStatus,
  SafetyState,
  SafetyTrigger,
} from '../types';
import { CONTROL_MODE_LABEL, READONLY_REASON } from '../types';
import { makeId, makeSeedJointParams } from '../data/simulatedTelemetry';
import { getConnection, postDisable, postScan, postDisconnect, toErrorMessage } from '../api/client';
import {
  deleteAgingAction,
  getAgingActions,
  getZeroTorqueStatus,
  postMechanicalZero,
  postPersistentGains,
  postZeroTorqueStart,
  postZeroTorqueStop,
  saveAgingAction,
} from '../api/client';
import { connectionReducer, INITIAL_CONNECTION } from './connectionReducer';

// ===== 状态切片 =====
interface AppState {
  controlMode: ControlMode;
  emergencyStop: boolean;
  /** 统一安全状态机：手动断开 / 通信异常 / 老化异常共用的停止→回零→失能序列 */
  safety: SafetyState;

  // 录制
  recording: RecordingState | null;
  // 回放
  playback: PlaybackState | null;
  // 老化
  aging: AgingState | null;
  /** 老化终止提示（自动完成 / 保护触发），下一次启动时清空 */
  agingNote: string | null;

  // 持久化数据
  recordedActions: RecordedAction[];
  logs: LogEntry[];

  // 参数配置：7 关节参数与最近一次真实零位写入时间镜像。
  // 只存在于前端状态，切换页面不丢失；绝不下发真实电机。
  jointParams: JointParam[];
  zeroLastSetAt: number | null;

  // 录制采样缓冲（用于构造已录动作）
  recordingBuffer: number[][];
  /** 带时间戳的录制采样（用于保留原始录制速度信息） */
  recordingTimedSamples: TimedSample[];

  /** 机械臂连接状态（完全来自后端 /api/robot/* 返回） */
  connection: ConnectionState;
}

type Action =
  | { type: 'SET_MODE'; mode: ControlMode }
  | { type: 'EMERGENCY_ON' }
  | { type: 'EMERGENCY_OFF' }
  | { type: 'RECORD_START'; payload: { name: string; samplingHz: number; countdownSec: number; now: number; recordingStartTime: number } }
  | { type: 'RECORD_COUNTDOWN_DONE'; payload: { now: number } }
  | { type: 'RECORD_TICK'; payload: { now: number; sampleCount: number; sample: number[]; relativeTime: number } }
  | { type: 'RECORD_STOP'; payload: { now: number; reentry: 'idle' } }
  | { type: 'PLAYBACK_START'; payload: { actionId: string; now: number; speedMultiplier: number } }
  | { type: 'AGING_START'; payload: { cfg: AgingConfig; now: number } }
  | { type: 'AGING_TICK'; payload: { now: number; loopsCompleted: number } }
  | { type: 'AGING_NOTE'; note: string | null }
  // ---- 统一安全状态机 ----
  | { type: 'SAFETY_BEGIN'; payload: { trigger: SafetyTrigger; now: number; commAvailable: boolean } }
  | { type: 'SAFETY_STOPPED' }
  | { type: 'SAFETY_HOMING_PROGRESS'; payload: { progress: number } }
  | { type: 'SAFETY_HOMING_OK' }
  | { type: 'SAFETY_HOMING_FAIL'; payload: { detail: string } }
  | { type: 'SAFETY_DISABLE_DONE' }
  | { type: 'SAFETY_DISABLE_FAIL'; payload: { detail: string } }
  | { type: 'SAFETY_COMM_LOST'; payload: { detail: string } }
  | { type: 'SAFETY_HOLD_CLEAR' }
  | { type: 'SAFETY_DISCONNECT_DONE'; payload: RobotConnection }
  | { type: 'SAFETY_DISCONNECT_FAIL'; payload: { detail: string } }
  | { type: 'READONLY_DISCONNECT'; payload: RobotConnection }
  | { type: 'READONLY_DISCONNECT_ERROR'; payload: { error: string } }
  | { type: 'ADD_LOG'; entry: LogEntry }
  | { type: 'ADD_ACTION'; action: RecordedAction }
  | { type: 'ACTIONS_LOAD'; actions: RecordedAction[] }
  | { type: 'DELETE_ACTION'; id: string }
  | { type: 'PARAMS_APPLY_MIT'; payload: { changes: Array<{ motorId: MotorId; kp: number; kd: number }>; now: number } }
  | { type: 'PARAMS_SET_ZERO'; payload: { now: number } }
  | { type: 'CONNECTION_SET'; payload: RobotConnection }
  | { type: 'CONNECTION_SCAN_START' }
  | { type: 'CONNECTION_ERROR'; payload: { error: string } };

// 互斥模式集合
const BUSINESS_MODES: ControlMode[] = ['teach_record', 'playback', 'aging'];

/**
 * 启动业务模式的合法性检查：
 * 紧急失能、回零中拒绝；
 * 仅允许从 idle 发起。
 */
function canStart(mode: ControlMode, from: ControlMode): boolean {
  if (from === 'homing') return false;
  if (mode === 'teach_record') return from === 'idle';
  if (mode === 'playback') return from === 'idle';
  if (mode === 'aging') return from === 'idle';
  return false;
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_MODE':
      // 任何非法的 SET_MODE 都视为 no-op
      if (state.emergencyStop) return state;
      // 未建立连接（模拟扫描未全部命中 1..7）时拒绝进入任何业务模式
      if (state.connection.status !== 'connected') return state;
      // 安全序列 / 保持进行中拒绝进入任何业务模式
      if (state.safety.status !== 'idle') return state;
      if (!canStart(action.mode, state.controlMode)) return state;
      // 切换到目标业务模式前，清空不兼容的子状态
      if (action.mode === 'teach_record') {
        if (state.controlMode !== 'idle') return state;
        return {
          ...state,
          controlMode: 'teach_record',
          playback: null,
          aging: null,
          recordingBuffer: Array.from({ length: 7 }, () => []),
        };
      }
      if (action.mode === 'playback') {
        if (state.controlMode !== 'idle') return state;
        return {
          ...state,
          controlMode: 'playback',
          recording: null,
          aging: null,
          recordingBuffer: [],
        };
      }
      if (action.mode === 'aging') {
        if (state.controlMode !== 'idle') return state;
        return {
          ...state,
          controlMode: 'aging',
          recording: null,
          playback: null,
          recordingBuffer: [],
        };
      }
      return state;

    case 'EMERGENCY_ON':
      return {
        ...state,
        emergencyStop: true,
        controlMode: 'idle',
        safety: { status: 'idle', trigger: null, startedAt: null, homingProgress: 0, failureDetail: null, commAvailable: true },
        recording: null,
        playback: null,
        aging: null,
        agingNote: null,
        recordingBuffer: [],
      };

    case 'EMERGENCY_OFF':
      return { ...state, emergencyStop: false };

    case 'RECORD_START': {
      // 互斥：仅允许从 idle 启动录制；未连接 / 安全序列进行中一律拒绝
      if (state.connection.status !== 'connected') return state;
      if (state.emergencyStop || state.safety.status !== 'idle') return state;
      if (state.controlMode !== 'idle') return state;
      const { name, samplingHz, now, countdownSec, recordingStartTime } = action.payload;
      return {
        ...state,
        controlMode: 'teach_record',
        recording: {
          name,
          samplingHz,
          startedAt: now + countdownSec * 1000,
          sampleCount: 0,
          countdownEndsAt: now + countdownSec * 1000,
          status: 'countdown',
          recordingStartTime: recordingStartTime ?? null,
        },
        recordingBuffer: Array.from({ length: 7 }, () => []),
        recordingTimedSamples: [],
      };
    }

    case 'RECORD_COUNTDOWN_DONE':
      if (!state.recording || state.recording.status !== 'countdown') return state;
      return {
        ...state,
        recording: { ...state.recording, status: 'recording', countdownEndsAt: null },
      };

    case 'RECORD_TICK': {
      if (!state.recording || state.recording.status !== 'recording') return state;
      if (
        action.payload.sample.length !== 7 ||
        action.payload.sample.some((value) => !Number.isFinite(value))
      ) return state;
      const next = state.recordingBuffer.map((arr, i) => {
        const v = action.payload.sample[i];
        return v === undefined ? arr : [...arr, v];
      });
      const timedSamples = state.recordingTimedSamples ?? [];
      const nextTimed = [...timedSamples, { t: action.payload.relativeTime, positions: [...action.payload.sample] }];
      return {
        ...state,
        recording: { ...state.recording, sampleCount: state.recording.sampleCount + 1 },
        recordingBuffer: next,
        recordingTimedSamples: nextTimed,
      };
    }

    case 'RECORD_STOP': {
      // 录制完成或取消：始终回到 idle；结束录制不触发任何硬件写入。
      return {
        ...state,
        recording: null,
        controlMode: 'idle',
        recordingBuffer: [],
      };
    }

    case 'PLAYBACK_START':
      // 互斥：仅允许从 idle 启动；未连接 / 安全序列进行中拒绝
      if (state.connection.status !== 'connected') return state;
      if (state.emergencyStop || state.safety.status !== 'idle' || state.controlMode !== 'idle') return state;
      return {
        ...state,
        controlMode: 'playback',
        recording: null,
        aging: null,
        recordingBuffer: [],
        playback: {
          actionId: action.payload.actionId,
          speedMultiplier: action.payload.speedMultiplier,
          startedAt: action.payload.now,
          status: 'running',
        },
      };

    case 'AGING_START':
      // 互斥：仅允许从 idle 启动；未连接 / 安全序列进行中拒绝
      if (state.connection.status !== 'connected') return state;
      if (state.emergencyStop || state.safety.status !== 'idle' || state.controlMode !== 'idle') return state;
      {
        const { cfg, now } = action.payload;
        // infinite：totalLoops = 0 且 endAt = null，即不存在自动完成条件，
        // 只能手动停止或由安全保护触发停止。
        const totalLoops = cfg.loopMode === 'count' ? cfg.loopCount : 0;
        const endAt = cfg.loopMode === 'duration' ? now + cfg.durationMinutes * 60_000 : null;
        return {
          ...state,
          controlMode: 'aging',
          recording: null,
          playback: null,
          recordingBuffer: [],
          agingNote: null,
          aging: {
            actionId: cfg.actionId,
            // 锁定配置快照：全局运行时监视器与运行中显示只读它
            config: cfg,
            startedAt: now,
            loopsCompleted: 0,
            totalLoops,
            endAt,
            status: 'running',
          },
        };
      }

    case 'AGING_TICK': {
      if (!state.aging) return state;
      return {
        ...state,
        aging: { ...state.aging, loopsCompleted: action.payload.loopsCompleted },
      };
    }

    case 'AGING_NOTE':
      return { ...state, agingNote: action.note };

    // =================== 统一安全状态机 ===================
    // 手动断开 / 通信异常 / 老化异常共用的停止 → 回零 → 失能 序列。
    // 阶段推进由 SafetyRuntimeMonitor 驱动；真实后端可逐步返回结果。
    case 'SAFETY_BEGIN': {
      const { trigger, now, commAvailable } = action.payload;
      // 序列开始前通信即不可用：无法确认任务停止、无法回零/失能，
      // 不盲目模拟，直接进入通信丢失安全保持。
      if (!commAvailable) {
        return {
          ...state,
          controlMode: 'idle',
          recording: null,
          playback: null,
          aging: null,
          agingNote: null,
          recordingBuffer: [],
          safety: {
            status: 'hold_comm_lost',
            trigger,
            startedAt: now,
            homingProgress: 0,
            failureDetail: '通信链路不可用，无法确认当前任务停止或执行回零/失能；进入安全保持，等待链路恢复',
            commAvailable: false,
          },
        };
      }
      // 通信可用：立即停止当前任务（controlMode → idle），进入 stopping 阶段
      return {
        ...state,
        controlMode: 'idle',
        recording: null,
        playback: null,
        aging: null,
        agingNote: null,
        recordingBuffer: [],
        safety: {
          status: 'stopping',
          trigger,
          startedAt: now,
          homingProgress: 0,
          failureDetail: null,
          commAvailable: true,
        },
      };
    }

    case 'SAFETY_STOPPED':
      // 任务已停止确认 → 进入回零
      if (state.safety.status !== 'stopping') return state;
      return { ...state, safety: { ...state.safety, status: 'homing', homingProgress: 0 } };

    case 'SAFETY_HOMING_PROGRESS':
      if (state.safety.status !== 'homing') return state;
      return {
        ...state,
        safety: { ...state.safety, homingProgress: Math.max(0, Math.min(1, action.payload.progress)) },
      };

    case 'SAFETY_HOMING_OK':
      // 回零完成确认 → 进入失能
      if (state.safety.status !== 'homing') return state;
      return { ...state, safety: { ...state.safety, status: 'disabling', homingProgress: 1 } };

    case 'SAFETY_HOMING_FAIL':
      // 回零失败：不得显示已安全断开，进入回零失败保持，需人工处理
      if (state.safety.status !== 'homing') return state;
      return {
        ...state,
        safety: { ...state.safety, status: 'hold_homing_failed', failureDetail: action.payload.detail, homingProgress: state.safety.homingProgress },
      };

    case 'SAFETY_DISABLE_DONE': {
      if (state.safety.status !== 'disabling') return state;
      const wasManual = state.safety.trigger === 'manual-disconnect';
      // 手动断开：回零+失能完成 → 进入 disconnecting，由驱动器调用 POST /api/robot/disconnect，
      // 成功后以后端返回的状态落库（不在前端伪造 disconnected）。
      // 其余（业务结束 / 老化故障）保留连接回到安全空闲。
      return {
        ...state,
        safety: wasManual
          ? { ...state.safety, status: 'disconnecting', homingProgress: 1 }
          : { status: 'idle', trigger: null, startedAt: null, homingProgress: 0, failureDetail: null, commAvailable: true },
      };
    }

    case 'SAFETY_DISABLE_FAIL':
      // 失能失败：不得显示已安全断开，进入失能失败保持，需人工处理
      if (state.safety.status !== 'disabling') return state;
      return {
        ...state,
        safety: { ...state.safety, status: 'hold_disable_failed', failureDetail: action.payload.detail },
      };

    case 'SAFETY_COMM_LOST':
      // 通信丢失：任务已停止，链路可用性未知，不盲目模拟回零/失能，
      // 进入通信丢失安全保持，等待恢复后人工确认再回零 → 失能。
      return {
        ...state,
        controlMode: 'idle',
        recording: null,
        playback: null,
        aging: null,
        agingNote: null,
        recordingBuffer: [],
        safety: {
          status: 'hold_comm_lost',
          trigger: state.safety.trigger ?? 'comm-lost',
          startedAt: Date.now(),
          homingProgress: state.safety.homingProgress,
          failureDetail: action.payload.detail,
          commAvailable: false,
        },
      };

    case 'SAFETY_HOLD_CLEAR':
      // 人工确认恢复 / 处理完成：清除保持并重新进入受控序列。
      // 通信丢失、回零失败 → 重试回零；失能失败 → 重试失能。
      // 必须先完成回零 → 失能才能清除安全状态、回到空闲。
      switch (state.safety.status) {
        case 'hold_comm_lost':
        case 'hold_homing_failed':
          return { ...state, safety: { ...state.safety, status: 'homing', homingProgress: 0, failureDetail: null, commAvailable: true } };
        case 'hold_disable_failed':
          return { ...state, safety: { ...state.safety, status: 'disabling', failureDetail: null, commAvailable: true } };
        default:
          return state;
      }

    case 'SAFETY_DISCONNECT_DONE': {
      // 后端确认断开成功：以返回的连接快照落库（status 为 disconnected），安全状态机完成。
      if (state.safety.status !== 'disconnecting') return state;
      return {
        ...state,
        safety: {
          status: 'disconnected',
          trigger: state.safety.trigger,
          startedAt: state.safety.startedAt,
          homingProgress: 1,
          failureDetail: null,
          commAvailable: true,
        },
        connection: connectionReducer(state.connection, { type: 'CONNECTION_SET', payload: action.payload }),
      };
    }

    case 'SAFETY_DISCONNECT_FAIL':
      // 断开接口调用失败：不得显示已安全断开，进入失能/断开失败保持，需人工处理。
      if (state.safety.status !== 'disconnecting') return state;
      return {
        ...state,
        safety: { ...state.safety, status: 'hold_disable_failed', failureDetail: action.payload.detail },
      };

    case 'READONLY_DISCONNECT':
      // 真机只读：无模拟安全序列，直接以断开接口返回快照清理会话。
      return {
        ...state,
        safety: {
          status: 'disconnected',
          trigger: 'manual-disconnect',
          startedAt: null,
          homingProgress: 0,
          failureDetail: null,
          commAvailable: true,
        },
        connection: connectionReducer(state.connection, { type: 'CONNECTION_SET', payload: action.payload }),
      };

    case 'READONLY_DISCONNECT_ERROR':
      // 真机只读断开失败：保留连接状态，仅记录错误，不伪装已断开。
      return { ...state, connection: connectionReducer(state.connection, { type: 'CONNECTION_ERROR', payload: { error: action.payload.error } }) };

    case 'ADD_LOG':
      return { ...state, logs: [action.entry, ...state.logs].slice(0, 500) };

    case 'ADD_ACTION':
      return { ...state, recordedActions: [action.action, ...state.recordedActions] };

    case 'ACTIONS_LOAD':
      // 后端动作库合并：按 id 去重，保留先到先得（本地新动作优先）。
      {
        const existing = new Set(state.recordedActions.map((a) => a.id));
        const fresh = action.actions.filter((a) => !existing.has(a.id));
        if (fresh.length === 0) return state;
        return { ...state, recordedActions: [...fresh, ...state.recordedActions] };
      }

    case 'DELETE_ACTION':
      return {
        ...state,
        recordedActions: state.recordedActions.filter((a) => a.id !== action.id),
      };

    case 'PARAMS_APPLY_MIT': {
      // API 成功后更新本地镜像；真实写入已在 applyMitGains 中完成。
      if (state.connection.status !== 'connected') return state;
      if (state.emergencyStop || state.safety.status !== 'idle' || state.controlMode !== 'idle') return state;
      const byId = new Map<MotorId, { kp: number; kd: number }>();
      action.payload.changes.forEach((c) => byId.set(c.motorId, { kp: c.kp, kd: c.kd }));
      return {
        ...state,
        jointParams: state.jointParams.map((p) => {
          const c = byId.get(p.motorId);
          return c ? { ...p, kp: c.kp, kd: c.kd, lastUpdated: action.payload.now } : p;
        }),
      };
    }

    case 'PARAMS_SET_ZERO': {
      // 仅在后端确认真实写入成功后更新本地时间镜像。
      if (state.connection.status !== 'connected') return state;
      if (state.emergencyStop || state.safety.status !== 'idle' || state.controlMode !== 'idle') return state;
      return { ...state, zeroLastSetAt: action.payload.now };
    }

    case 'CONNECTION_SET': {
      // 恢复 / 扫描返回：完全采用后端连接快照。
      // 若后端确认 connected 而前端仍处于"已安全断开"状态机，则复位安全状态机为空闲。
      const conn = connectionReducer(state.connection, action);
      const safety =
        action.payload.status === 'connected' && state.safety.status === 'disconnected'
          ? { status: 'idle' as const, trigger: null, startedAt: null, homingProgress: 0, failureDetail: null, commAvailable: true }
          : state.safety;
      return { ...state, connection: conn, safety };
    }

    case 'CONNECTION_SCAN_START':
      // 仅置本地请求在途标志；后端 status 保持最后一次扫描结果
      return { ...state, connection: connectionReducer(state.connection, action) };

    case 'CONNECTION_ERROR':
      // 409 / 网络错误：不得伪装成 connected，展示错误并清除在途标志
      return { ...state, connection: connectionReducer(state.connection, action) };

    default:
      return state;
  }
}

const INITIAL_STATE: AppState = {
  controlMode: 'idle',
  emergencyStop: false,
  safety: { status: 'idle', trigger: null, startedAt: null, homingProgress: 0, failureDetail: null, commAvailable: true },
  recording: null,
  playback: null,
  aging: null,
  agingNote: null,
  // 动作库从空白开始：动作只能由真实遥测录制产生，seed 演示数据不参与动作/老化流程。
  recordedActions: [],
  logs: [],
  jointParams: makeSeedJointParams(),
  zeroLastSetAt: null,
  recordingBuffer: [],
  connection: INITIAL_CONNECTION,
};

// ===== Context =====

export interface AppContextValue {
  state: AppState;
  // 机械臂连接（模拟适配器）
  /** 是否已连接（1..7 全部发现） */
  robotConnected: boolean;
  /** 开始连接扫描（模拟只读扫描 can0，依次发现 ID 1..7） */
  startConnectionScan: () => void;
  /**
   * 断开连接：统一走安全状态机（停止任务 → 回零 → 失能 → 断开）。
   * 运行中/空闲均不直接断开；通信可用时执行受控序列，通信失联时进入安全保持。
   */
  disconnectRobot: () => void;
  // 工具
  startRecord: (cfg: RecordConfig) => void;
  /** 结束录制：commit=true 时保存 raw；不触发任何硬件写入。 */
  stopRecord: (options?: { commit: boolean; reentry: 'idle' }) => void;
  recordTick: (sample: number[]) => void;
  recordCountdownDone: () => void;
  saveProcessedAction: (action: RecordedAction) => void;
  startPlayback: (actionId: string, speedMultiplier?: number) => void;
  startAging: (cfg: AgingConfig) => void;
  agingTick: (loopsCompleted: number) => void;
  /** 设置老化终止提示（由全局运行时监视器调用）；传 null 清除 */
  setAgingNote: (note: string | null) => void;
  /** 业务/断开/老化故障统一安全序列入口：trigger 决定终点（手动断开→断开，其余→回空闲） */
  requestHomingAndDisable: (trigger?: SafetyTrigger) => void;
  /** 通信丢失安全停止：终止老化并进入通信丢失安全保持，不请求回零、不自动失能 */
  haltForCommunicationLoss: () => void;
  /** 人工确认链路恢复 / 处理完成后，重试受控回零 → 失能，清除安全保持 */
  acknowledgeCommunicationLost: () => void;
  // ---- 安全状态机驱动器回调（由 SafetyRuntimeMonitor 调用） ----
  safetyStopTaskDone: () => void;
  safetyHomingProgress: (progress: number) => void;
  safetyHomingOk: () => void;
  safetyHomingFail: (detail: string) => void;
  safetyDisableDone: () => void;
  safetyDisableFail: (detail: string) => void;
  safetyCommLost: (detail: string) => void;
  clearSafetyHold: () => void;
  safetyDisconnectDone: (conn: RobotConnection) => void;
  safetyDisconnectFail: (detail: string) => void;
  triggerEmergencyDisable: () => void;
  resetEmergency: () => void;
  deleteAction: (id: string) => void;
  pushLog: (entry: Omit<LogEntry, 'id' | 'sessionId' | 'timestamp'>) => void;
  /** 参数配置：持久化位置环 KP / 速度环 KP（不调用 send_mit）。 */
  applyMitGains: (changes: MitGainChange[]) => Promise<void>;
  /** 参数配置：用户确认后执行真实整机机械零位写入。 */
  setMechanicalZero: () => Promise<void>;
  zeroTorqueStatus: ZeroTorqueStatus;
  startZeroTorque: () => Promise<void>;
  stopZeroTorque: () => Promise<void>;
  describeMode: (m: ControlMode) => string;
  // 派生
  isBusy: boolean;
  busyMode: ControlMode | null;
  /** 安全序列 / 保持进行中（非安全空闲与已安全断开） */
  safetyActive: boolean;
  /** 真机只读模式：无控制能力（motorbridge 或能力未返回） */
  readOnly: boolean;
  /** 只读禁用原因（统一展示），非只读时为 null */
  readOnlyReason: string | null;
}

export function sameZeroTorqueStatus(
  left: ZeroTorqueStatus,
  right: ZeroTorqueStatus,
): boolean {
  return left.status === right.status
    && left.frequency_hz === right.frequency_hz
    && left.channel === right.channel
    && left.started_at === right.started_at
    && left.updated_at === right.updated_at
    && left.error === right.error
    && left.motor_ids.length === right.motor_ids.length
    && left.motor_ids.every((id, index) => id === right.motor_ids[index]);
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const [zeroTorqueStatus, setZeroTorqueStatus] = useState<ZeroTorqueStatus>({
    status: 'inactive',
    frequency_hz: 50,
    channel: 'can1',
    motor_ids: [1, 2, 3, 4, 5, 6, 7],
    started_at: null,
    updated_at: new Date(0).toISOString(),
    error: null,
  });

  // 派生：连接是否已建立（1..7 全部发现）
  const robotConnected = state.connection.status === 'connected';
  // 派生：真机只读模式 = 不具控制能力（control 能力未启用）。
  // simulation 源 → capabilities 全开 → 非只读；motorbridge 或能力未返回 → fail closed → 只读。
  const readOnly = !state.connection.capabilities.control;
  const readOnlyReason = readOnly ? READONLY_REASON : null;

  const pushLog = useCallback((entry: Omit<LogEntry, 'id' | 'sessionId' | 'timestamp'>) => {
    dispatch({
      type: 'ADD_LOG',
      entry: {
        ...entry,
        id: makeId('log'),
        sessionId: 'current',
        timestamp: Date.now(),
      },
    });
  }, []);

  /** 真机只读模式下拒绝写操作（统一日志）。 */
  const rejectReadOnly = useCallback(() => {
    pushLog({
      type: 'system',
      result: 'error',
      title: '操作被拒绝：真机只读',
      detail: READONLY_REASON,
    });
  }, [pushLog]);

  useEffect(() => {
    if (!state.connection.capabilities.zero_torque) {
      setZeroTorqueStatus((prev) => ({ ...prev, status: 'inactive', error: null }));
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    const refresh = async () => {
      let nextDelayMs = 2000;
      try {
        const status = await getZeroTorqueStatus();
        if (['starting', 'active', 'stopping'].includes(status.status)) {
          nextDelayMs = 500;
        }
        if (!cancelled) {
          setZeroTorqueStatus((previous) =>
            sameZeroTorqueStatus(previous, status) ? previous : status,
          );
        }
      } catch {
        // The backend remains authoritative; a transient GET failure does not
        // invent an active state in the UI.
      } finally {
        // Recursive timeout prevents overlapping requests. Inactive polling
        // is deliberately slower and identical responses retain the same
        // object reference, so the global AppContext tree does not rerender
        // every 500 ms while the 3D model is animating.
        if (!cancelled) timer = window.setTimeout(() => { void refresh(); }, nextDelayMs);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [state.connection.capabilities.zero_torque]);

  const startZeroTorque = useCallback(async () => {
    try {
      const status = await postZeroTorqueStart();
      setZeroTorqueStatus(status);
      pushLog({
        type: 'system',
        result: status.status === 'active' ? 'success' : 'warning',
        title: status.status === 'active' ? '零力矩模式已进入' : '零力矩模式未激活',
        detail: `后端循环 ${status.frequency_hz}Hz；严格流程为 enable_all → Mode.MIT → 全零 send_mit。${status.error ?? ''}`,
        meta: { adapter: state.connection.source ?? 'unknown', frequencyHz: status.frequency_hz },
      });
    } catch (err) {
      pushLog({
        type: 'system',
        result: 'error',
        title: '零力矩模式进入失败',
        detail: toErrorMessage(err),
      });
      throw err;
    }
  }, [pushLog, state.connection.source]);

  const stopZeroTorque = useCallback(async () => {
    try {
      const status = await postZeroTorqueStop();
      setZeroTorqueStatus(status);
      pushLog({
        type: 'system',
        result: status.status === 'inactive' ? 'success' : 'error',
        title: status.status === 'inactive' ? '零力矩模式已退出' : '零力矩模式退出异常',
        detail: `后端先停止并 join 循环，再调用 disable_all。${status.error ?? ''}`,
        meta: { adapter: state.connection.source ?? 'unknown' },
      });
    } catch (err) {
      pushLog({ type: 'system', result: 'error', title: '零力矩模式退出失败', detail: toErrorMessage(err) });
      throw err;
    }
  }, [pushLog, state.connection.source]);

  // ---------- 机械臂连接（真实后端 API） ----------
  // 连接状态完全来自后端 /api/robot/*；扫描不再在前端用定时器伪造 ID 发现。
  /** 启动时恢复后端连接状态（GET /api/robot/connection）。 */
  const initializeConnection = useCallback(async () => {
    try {
      const conn = await getConnection();
      dispatch({ type: 'CONNECTION_SET', payload: conn });
    } catch (err) {
      // 后端不可达：保持 disconnected，展示错误，不得伪装成已连接
      dispatch({ type: 'CONNECTION_ERROR', payload: { error: toErrorMessage(err) } });
    }
  }, []);

  useEffect(() => {
    initializeConnection();
  }, [initializeConnection]);

  /** 启动时从后端动作库恢复已保存的 processed 动作（刷新不丢）。 */
  const loadActionsFromServer = useCallback(async () => {
    try {
      const actions = await getAgingActions();
      if (actions.length > 0) dispatch({ type: 'ACTIONS_LOAD', actions });
    } catch {
      // 后端不可达时动作库暂不可用；本地动作不受影响，静默重试下次加载。
    }
  }, []);

  useEffect(() => {
    void loadActionsFromServer();
  }, [loadActionsFromServer]);

  /** 顶部「连接机械臂」：调用 POST /api/robot/scan（只读扫描，阻塞至后端返回）。 */
  const startConnectionScan = useCallback(async () => {
    // 二次守卫：请求在途时不重复发起（防重复点击）
    if (state.connection.scanning) return;
    dispatch({ type: 'CONNECTION_SCAN_START' });
    pushLog({
      type: 'system',
      result: 'info',
      title: '开始扫描机械臂连接',
      detail: 'POST /api/robot/scan：只读扫描（不下发任何运动指令）',
    });
    try {
      const conn = await postScan();
      dispatch({ type: 'CONNECTION_SET', payload: conn });
      pushLog({
        type: 'system',
        result: conn.status === 'connected' ? 'success' : 'warning',
        title: '机械臂连接扫描完成',
        detail: conn.message ?? `后端状态：${conn.status}`,
        meta: { channel: conn.channel, source: conn.source ?? 'unknown', foundIds: conn.found_ids.length },
      });
    } catch (err) {
      const msg = toErrorMessage(err);
      dispatch({ type: 'CONNECTION_ERROR', payload: { error: msg } });
      pushLog({
        type: 'system',
        result: 'error',
        title: '机械臂连接扫描失败',
        detail: msg,
      });
    }
  }, [state.connection.scanning, pushLog]);

  /** 真机只读断开：直接调用只读断开接口（无模拟安全序列）。 */
  const readOnlyDisconnect = useCallback(async () => {
    try {
      const conn = await postDisconnect();
      dispatch({ type: 'READONLY_DISCONNECT', payload: conn });
      pushLog({
        type: 'system',
        result: 'success',
        title: '真机只读会话已清理',
        detail: `POST /api/robot/disconnect：${conn.message ?? '连接已断开'}`,
      });
    } catch (err) {
      const msg = toErrorMessage(err);
      dispatch({ type: 'READONLY_DISCONNECT_ERROR', payload: { error: msg } });
      pushLog({
        type: 'system',
        result: 'error',
        title: '真机只读断开失败',
        detail: msg,
      });
    }
  }, [pushLog]);

  const disconnectRobot = useCallback(() => {
    if (state.connection.status !== 'connected') return;
    // Never use the removed browser timer to claim homing/disable success.
    // Active backend-owned modes reject this request with 409; otherwise the
    // endpoint only releases the connection owner and sends no motion command.
    if (
      state.controlMode !== 'idle' ||
      state.safety.status !== 'idle' ||
      state.recording ||
      state.playback ||
      state.aging
    ) return;
    void readOnlyDisconnect();
  }, [state.connection.status, state.safety.status, state.controlMode, state.recording, state.playback, state.aging, readOnlyDisconnect]);

  // ---------- 启动 / 终止 ----------
  const startRecord = useCallback(
    (cfg: RecordConfig) => {
      if (!robotConnected) {
        pushLog({
          type: 'system',
          result: 'warning',
          title: '启动被拒绝：机械臂未连接',
          detail: '请先点击顶部「连接机械臂」完成扫描连接（can0 · ID 1–7）',
        });
        return;
      }
      if (zeroTorqueStatus.status !== 'active') {
        pushLog({
          type: 'system',
          result: 'warning',
          title: '录制被拒绝：零力矩模式未激活',
          detail: '请由操作员人工确认并进入零力矩模式后再开始录制。',
        });
        return;
      }
      const now = Date.now();
      dispatch({
        type: 'RECORD_START',
        payload: {
          name: cfg.name,
          samplingHz: cfg.samplingHz,
          countdownSec: cfg.countdownSec,
          now,
        },
      });
      pushLog({
        type: 'teach_record',
        result: 'info',
        title: '开始零力矩拖拽录制',
        detail: `动作名：${cfg.name}；采样 ${cfg.samplingHz}Hz；倒计时 ${cfg.countdownSec}s`,
        meta: { name: cfg.name, samplingHz: cfg.samplingHz },
      });
    },
    [robotConnected, zeroTorqueStatus.status, pushLog],
  );

  const stopRecord = useCallback(
    (options?: { commit: boolean; reentry: 'idle' }) => {
      const { recording, recordingBuffer } = state;
      if (!recording) return;
      const commit = options?.commit ?? true;
      const reentry: 'idle' = options?.reentry ?? 'idle';
      const hasCompleteBuffer = recordingBuffer.length === 7 && recordingBuffer.every((trail) => trail.length > 0);
      if (commit && recording.status === 'recording' && hasCompleteBuffer) {
        const sampleCount = recordingBuffer[0].length;
        const durationMs = (sampleCount / recording.samplingHz) * 1000;
        const newAction: RecordedAction = {
          id: makeId('act'),
          name: recording.name,
          createdAt: Date.now(),
          durationMs,
          sampleCount,
          samplingHz: recording.samplingHz,
          jointCount: 7,
          trails: recordingBuffer.map((trail) => [...trail]),
          version: 'raw',
        };
        dispatch({ type: 'ADD_ACTION', action: newAction });
        pushLog({
          type: 'teach_record',
          result: 'success',
          title: '完成一次零力矩拖拽录制',
          detail: `动作名：${recording.name}；时长 ${(durationMs / 1000).toFixed(1)}s；采样 ${recording.samplingHz}Hz`,
        });
      } else if (recording.status === 'countdown') {
        pushLog({
          type: 'teach_record',
          result: 'warning',
          title: '录制已取消',
          detail: '在倒计时阶段结束，未采集到样本',
        });
      }
      dispatch({ type: 'RECORD_STOP', payload: { now: Date.now(), reentry } });
    },
    [state, pushLog],
  );

  const recordTick = useCallback((sample: number[]) => {
    dispatch({ type: 'RECORD_TICK', payload: { now: Date.now(), sampleCount: 0, sample } });
  }, []);

  const recordCountdownDone = useCallback(() => {
    dispatch({ type: 'RECORD_COUNTDOWN_DONE', payload: { now: Date.now() } });
  }, []);

  const saveProcessedAction = useCallback(
    async (action: RecordedAction) => {
      if (action.version !== 'processed' || !action.rawActionId) return;
      dispatch({ type: 'ADD_ACTION', action: { ...action, trails: action.trails.map((trail) => [...trail]) } });
      try {
        await saveAgingAction(action);
        pushLog({
          type: 'playback',
          result: 'success',
          title: '已保存处理后动作',
          detail: `动作「${action.name}」已保存到后端动作库，老化测试可复用。`,
        });
      } catch (err) {
        pushLog({
          type: 'playback',
          result: 'warning',
          title: '处理后动作已保存（未持久化）',
          detail: `后端动作库暂不可用：${toErrorMessage(err)}`,
        });
      }
    },
    [pushLog],
  );

  const startPlayback = useCallback(
    (actionId: string, speedMultiplier = 1) => {
      if (!robotConnected) {
        pushLog({
          type: 'system',
          result: 'warning',
          title: '启动被拒绝：机械臂未连接',
          detail: '请先点击顶部「连接机械臂」完成扫描连接（can0 · ID 1–7）',
        });
        return;
      }
      if (readOnly) {
        rejectReadOnly();
        return;
      }
      dispatch({
        type: 'PLAYBACK_START',
        payload: { actionId, speedMultiplier, now: Date.now() },
      });
      pushLog({
        type: 'playback',
        result: 'info',
        title: '开始动作回放',
        detail: `动作 ID：${actionId}；速度倍率 ${speedMultiplier}x`,
      });
    },
    [robotConnected, readOnly, rejectReadOnly, pushLog],
  );

  const startAging = useCallback(
    (cfg: AgingConfig) => {
      if (!robotConnected) {
        pushLog({
          type: 'system',
          result: 'warning',
          title: '启动被拒绝：机械臂未连接',
          detail: '请先点击顶部「连接机械臂」完成扫描连接（can0 · ID 1–7）',
        });
        return;
      }
      if (readOnly) {
        rejectReadOnly();
        return;
      }
      const now = Date.now();
      dispatch({ type: 'AGING_START', payload: { cfg, now } });
      pushLog({
        type: 'aging',
        result: 'info',
        title: '开始老化测试',
        detail:
          cfg.loopMode === 'count'
            ? `动作 ${cfg.actionId}；循环 ${cfg.loopCount} 次`
            : cfg.loopMode === 'duration'
              ? `动作 ${cfg.actionId}；持续 ${cfg.durationMinutes} 分钟`
              : `动作 ${cfg.actionId}；无限时长，仅手动停止或安全保护触发停止`,
        meta: { speedMultiplier: cfg.speedMultiplier, samplingPeriodMs: cfg.samplingPeriodMs },
      });
    },
    [robotConnected, readOnly, rejectReadOnly, pushLog],
  );

  const agingTick = useCallback((loopsCompleted: number) => {
    dispatch({ type: 'AGING_TICK', payload: { now: Date.now(), loopsCompleted } });
  }, []);

  const setAgingNote = useCallback((note: string | null) => {
    dispatch({ type: 'AGING_NOTE', note });
  }, []);

  // ---------- 统一安全状态机入口 ----------
  // 手动断开 / 业务正常结束 / 老化故障统一进入停止 → 回零 → 失能 序列。
  // 阶段推进交给 SafetyRuntimeMonitor（依据遥测实时校验通信，失联则转安全保持）。
  const requestHomingAndDisable = useCallback(
    (trigger: SafetyTrigger = 'business-end') => {
      // 若已在安全序列中，不重复发起
      if (state.safety.status !== 'idle') return;
      // 真机只读：无回零能力，不得在无控制能力时模拟回零/失能
      if (!state.connection.capabilities.homing || !state.connection.capabilities.disable) return;
      const now = Date.now();
      const previous = state.controlMode;
      dispatch({ type: 'SAFETY_BEGIN', payload: { trigger, now, commAvailable: true } });
      const taskDetail =
        trigger === 'manual-disconnect'
          ? '请求安全断开'
          : trigger === 'aging-fault'
            ? '老化故障触发停止'
            : previous === 'teach_record'
                ? '结束零力矩拖拽录制'
                : previous === 'playback'
                  ? '结束动作回放'
                  : previous === 'aging'
                    ? '结束老化测试'
                    : '回到空闲';
      pushLog({
        type: 'homing',
        result: 'info',
        title: '进入安全序列',
        detail: `${taskDetail}：停止任务 → 回零 → 失能`,
        meta: { trigger, safetyStatus: 'stopping' },
      });
    },
    [state.safety.status, state.controlMode, state.connection.capabilities.homing, state.connection.capabilities.disable, pushLog],
  );

  // ---------- 通信丢失安全停止 ----------
  // 链路可用性无法确认时的最小安全动作：停止老化并进入通信丢失安全保持，
  // 不请求回零、不自动失能；恢复后由人工确认再执行受控回零 → 失能。
  const haltForCommunicationLoss = useCallback(() => {
    dispatch({
      type: 'SAFETY_COMM_LOST',
      payload: { detail: '通信超时：链路可用性无法确认，未下发回零/失能指令，进入通信丢失安全保持' },
    });
    pushLog({
      type: 'aging',
      result: 'error',
      title: '通信丢失，进入安全保持',
      detail: '老化已停止；链路可用性无法确认，未下发回零指令。请恢复通信并确认现场安全后，再执行回零 → 失能以清除保持',
    });
  }, [pushLog]);

  const acknowledgeCommunicationLost = useCallback(() => {
    dispatch({ type: 'SAFETY_HOLD_CLEAR' });
    pushLog({
      type: 'system',
      result: 'warning',
      title: '通信已恢复，开始受控回零',
      detail: '人工确认链路恢复；将执行回零 → 失能 以清除安全保持，完成后回到安全空闲',
    });
  }, [pushLog]);

  // ---------- 安全状态机驱动器回调 ----------
  const safetyStopTaskDone = useCallback(() => {
    dispatch({ type: 'SAFETY_STOPPED' });
    pushLog({
      type: 'homing',
      result: 'info',
      title: '任务已停止，开始回零',
      detail: '进入回零阶段，未下发真实电机指令（模拟）',
      meta: { safetyStatus: 'homing' },
    });
  }, [pushLog]);

  const safetyHomingProgress = useCallback((progress: number) => {
    dispatch({ type: 'SAFETY_HOMING_PROGRESS', payload: { progress } });
  }, []);

  const safetyHomingOk = useCallback(() => {
    dispatch({ type: 'SAFETY_HOMING_OK' });
    pushLog({
      type: 'homing',
      result: 'success',
      title: '回零到位，开始失能',
      detail: '所有关节确认到位（模拟反馈），电机进入失能阶段',
      meta: { safetyStatus: 'disabling' },
    });
  }, [pushLog]);

  const safetyHomingFail = useCallback(
    (detail: string) => {
      dispatch({ type: 'SAFETY_HOMING_FAIL', payload: { detail } });
      pushLog({
        type: 'homing',
        result: 'error',
        title: '回零失败，进入安全保持',
        detail: `${detail}；未显示已安全断开/已回零，请人工检查后处理`,
      });
    },
    [pushLog],
  );

  const safetyDisableDone = useCallback(() => {
    dispatch({ type: 'SAFETY_DISABLE_DONE' });
    pushLog({
      type: 'homing',
      result: 'success',
      title: '失能完成',
      detail: '电机已失能（模拟反馈）。若为手动断开，连接已安全断开；否则回到安全空闲',
      meta: { safetyStatus: 'idle' },
    });
  }, [pushLog]);

  const safetyDisableFail = useCallback(
    (detail: string) => {
      dispatch({ type: 'SAFETY_DISABLE_FAIL', payload: { detail } });
      pushLog({
        type: 'homing',
        result: 'error',
        title: '失能失败，进入安全保持',
        detail: `${detail}；未显示已安全断开，请人工检查后处理`,
      });
    },
    [pushLog],
  );

  const safetyCommLost = useCallback(
    (detail: string) => {
      dispatch({ type: 'SAFETY_COMM_LOST', payload: { detail } });
      pushLog({
        type: 'system',
        result: 'error',
        title: '安全序列期间通信失联，进入安全保持',
        detail: `${detail}；未盲目模拟回零/失能，等待链路恢复后人工确认再完成回零 → 失能`,
      });
    },
    [pushLog],
  );

  const clearSafetyHold = useCallback(() => {
    dispatch({ type: 'SAFETY_HOLD_CLEAR' });
    pushLog({
      type: 'system',
      result: 'warning',
      title: '人工确认完成，重试受控序列',
      detail: '重新执行回零（或失能）以清除安全保持；完成后回到安全空闲',
    });
  }, [pushLog]);

  // ---------- 断开接口回调（由 SafetyRuntimeMonitor 在 disconnecting 阶段调用） ----------
  const safetyDisconnectDone = useCallback(
    (conn: RobotConnection) => {
      dispatch({ type: 'SAFETY_DISCONNECT_DONE', payload: conn });
      pushLog({
        type: 'system',
        result: 'success',
        title: '安全断开完成',
        detail: `POST /api/robot/disconnect 成功：${conn.message ?? '连接已断开'}`,
        meta: { channel: conn.channel, status: conn.status, source: conn.source ?? 'unknown' },
      });
    },
    [pushLog],
  );

  const safetyDisconnectFail = useCallback(
    (detail: string) => {
      dispatch({ type: 'SAFETY_DISCONNECT_FAIL', payload: { detail } });
      pushLog({
        type: 'system',
        result: 'error',
        title: '断开接口调用失败，进入安全保持',
        detail: `${detail}；未显示已安全断开，请人工检查后端后重试`,
      });
    },
    [pushLog],
  );

  // ---------- 紧急失能 ----------
  const triggerEmergencyDisable = useCallback(async () => {
    // 未连接时紧急失能不可用：没有已建立的控制链路可失能
    if (state.connection.status !== 'connected') {
      pushLog({
        type: 'system',
        result: 'warning',
        title: '紧急失能不可用',
        detail: '机械臂未连接，没有已建立的控制链路。请先点击顶部「连接机械臂」完成扫描连接',
      });
      return;
    }
    // 真机只读：无失能能力，不得在无控制能力时触发失能
    if (!state.connection.capabilities.disable) {
      rejectReadOnly();
      return;
    }
    try {
      await postDisable();
      dispatch({ type: 'EMERGENCY_ON' });
      pushLog({
        type: 'emergency',
        result: 'error',
        title: '触发紧急失能',
        detail: '后端已确认 disable_all',
      });
    } catch (err) {
      pushLog({
        type: 'emergency',
        result: 'error',
        title: '紧急失能失败',
        detail: toErrorMessage(err),
      });
    }
  }, [state.connection.status, state.connection.capabilities.disable, rejectReadOnly, pushLog]);

  const resetEmergency = useCallback(() => {
    dispatch({ type: 'EMERGENCY_OFF' });
    pushLog({
      type: 'emergency',
      result: 'warning',
      title: '紧急失能已复位',
      detail: '需要重新进入业务模式或回零',
    });
  }, [pushLog]);

  const deleteAction = useCallback(
    async (id: string) => {
      dispatch({ type: 'DELETE_ACTION', id });
      pushLog({
        type: 'system',
        result: 'info',
        title: '已删除已录动作',
        detail: `动作 ID：${id}`,
      });
      try {
        await deleteAgingAction(id);
      } catch {
        // 后端动作库删除失败时仅提示；本地动作已移除，刷新后可能回弹。
        pushLog({
          type: 'system',
          result: 'warning',
          title: '后端动作库删除失败',
          detail: '动作已从当前列表移除，但后端仍保留此动作。',
        });
      }
    },
    [pushLog],
  );

  // ---------- 参数配置（持久化位置/速度环增益） ----------
  const applyMitGains = useCallback(
    async (changes: MitGainChange[]) => {
      if (changes.length === 0) return;
      // 未连接一律拒绝
      if (!robotConnected) {
        pushLog({
          type: 'system',
          result: 'warning',
          title: '参数写入被拒绝：机械臂未连接',
          detail: '请先点击顶部「连接机械臂」完成扫描连接（can0 · ID 1–7）',
        });
        return;
      }
      if (!state.connection.capabilities.persistent_gain_write) {
        pushLog({
          type: 'system',
          result: 'warning',
          title: '参数写入被拒绝：持久增益能力未开放',
          detail: '后端未开放已核实的 0x701E/0x701F 持久参数接口；未触碰电机',
        });
        return;
      }
      // 运行中 / 安全序列 / 急停 一律拒绝（controlMode !== 'idle' 覆盖运行中）
      if (state.emergencyStop || state.safety.status !== 'idle' || state.controlMode !== 'idle') return;
      await postPersistentGains(
        changes.map((c) => ({ motor_id: c.motorId, kp: c.toKp, kd: c.toKd })),
      );
      const now = Date.now();
      dispatch({
        type: 'PARAMS_APPLY_MIT',
        payload: {
          changes: changes.map((c) => ({ motorId: c.motorId, kp: c.toKp, kd: c.toKd })),
          now,
        },
      });
      pushLog({
        type: 'system',
        result: 'success',
        title: '已持久化位置环 KP / 速度环 KP',
        detail: `变更 ${changes.length} 个关节：${changes
          .map((c) => `${c.name} KP ${c.fromKp}→${c.toKp} / KD ${c.fromKd}→${c.toKd}`)
          .join('；')}。KP/KD=0 不等于零力矩拖拽；写入与人工使能是独立操作。`,
        meta: { jointCount: changes.length, adapter: state.connection.source ?? 'unknown', parameterIds: '0x701E,0x701F' },
      });
    },
    [robotConnected, state.emergencyStop, state.safety.status, state.connection.capabilities.persistent_gain_write, state.controlMode, state.connection.source, pushLog],
  );

  // 用户确认后的真实机械零位 API；后端复用单一长期 Controller。
  const setMechanicalZero = useCallback(async () => {
    if (!robotConnected) {
      pushLog({
        type: 'system',
        result: 'warning',
        title: '设置零位被拒绝：机械臂未连接',
        detail: '请先点击顶部「连接机械臂」完成扫描连接（can0 · ID 1–7）',
      });
      return;
    }
    if (!state.connection.capabilities.set_zero) {
      const message = '后端未开放机械零位能力；未触碰电机';
      pushLog({ type: 'system', result: 'warning', title: '真实机械零位未开放', detail: message });
      return;
    }
    if (state.emergencyStop || state.safety.status !== 'idle' || state.controlMode !== 'idle') return;
    try {
      const result = await postMechanicalZero();
      const now = Date.now();
      dispatch({ type: 'PARAMS_SET_ZERO', payload: { now } });
      pushLog({
        type: 'system',
        result: 'success',
        title: '整机机械零位已写入',
        detail: `已按逐电机 disable → 读取 0x7019 → set_zero_position → store_parameters 完成 ${result.motor_ids.length} 个电机。`,
        meta: { jointCount: result.motor_ids.length, adapter: state.connection.source ?? 'unknown', parameterId: '0x7019' },
      });
    } catch (err) {
      pushLog({ type: 'system', result: 'error', title: '整机机械零位写入失败', detail: toErrorMessage(err) });
      throw err;
    }
  }, [robotConnected, state.emergencyStop, state.safety.status, state.connection.capabilities.set_zero, state.connection.source, state.controlMode, pushLog]);

  // 派生：是否处于业务模式
  const isBusy = BUSINESS_MODES.includes(state.controlMode);
  const busyMode: ControlMode | null = isBusy ? state.controlMode : null;
  // 派生：安全序列 / 保持进行中（非安全空闲与已安全断开）
  const safetyActive =
    state.safety.status !== 'idle' && state.safety.status !== 'disconnected';

  const value = useMemo<AppContextValue>(
    () => ({
      state,
      robotConnected,
      startConnectionScan,
      disconnectRobot,
      initializeConnection,
      startRecord,
      stopRecord,
      recordTick,
      recordCountdownDone,
      saveProcessedAction,
      startPlayback,
      startAging,
      agingTick,
      setAgingNote,
      requestHomingAndDisable,
      haltForCommunicationLoss,
      acknowledgeCommunicationLost,
      safetyStopTaskDone,
      safetyHomingProgress,
      safetyHomingOk,
      safetyHomingFail,
      safetyDisableDone,
      safetyDisableFail,
      safetyCommLost,
      clearSafetyHold,
      safetyDisconnectDone,
      safetyDisconnectFail,
      readOnlyDisconnect,
      triggerEmergencyDisable,
      resetEmergency,
      deleteAction,
      pushLog,
      applyMitGains,
      setMechanicalZero,
      zeroTorqueStatus,
      startZeroTorque,
      stopZeroTorque,
      isBusy,
      busyMode,
      safetyActive,
      readOnly,
      readOnlyReason,
      describeMode: (m) => CONTROL_MODE_LABEL[m],
    }),
    [
      state,
      robotConnected,
      startConnectionScan,
      disconnectRobot,
      initializeConnection,
      startRecord,
      stopRecord,
      recordTick,
      recordCountdownDone,
      saveProcessedAction,
      startPlayback,
      startAging,
      agingTick,
      setAgingNote,
      requestHomingAndDisable,
      haltForCommunicationLoss,
      acknowledgeCommunicationLost,
      safetyStopTaskDone,
      safetyHomingProgress,
      safetyHomingOk,
      safetyHomingFail,
      safetyDisableDone,
      safetyDisableFail,
      safetyCommLost,
      clearSafetyHold,
      safetyDisconnectDone,
      safetyDisconnectFail,
      readOnlyDisconnect,
      readOnly,
      readOnlyReason,
      triggerEmergencyDisable,
      resetEmergency,
      deleteAction,
      pushLog,
      applyMitGains,
      setMechanicalZero,
      zeroTorqueStatus,
      startZeroTorque,
      stopZeroTorque,
      isBusy,
      busyMode,
      safetyActive,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

// ===== 录制采样 Hook =====
// 在 recording 进入 recording 阶段后，按 samplingHz 周期调用 onSample。
// 倒计时 → recording 的状态切换由调用方（MotionCenterPage）触发。
