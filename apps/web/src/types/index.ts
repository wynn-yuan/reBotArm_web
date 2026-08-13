/**
 * 全局领域类型定义。
 * 严格类型，便于后续对接真实 CAN/串口驱动时替换数据来源。
 */

// ===== 控制模式（互斥） =====
// idle: 空闲；teach_record: 零力矩拖拽录制；
// playback: 动作回放；aging: 老化运行；homing: 正在回零
export type ControlMode =
  | 'idle'
  | 'teach_record'
  | 'playback'
  | 'aging'
  | 'homing';

export const CONTROL_MODE_LABEL: Record<ControlMode, string> = {
  idle: '空闲',
  teach_record: '零力矩拖拽录制',
  playback: '动作回放',
  aging: '老化运行',
  homing: '正在回零',
};

// ===== 电机 / 关节 =====
// 1..6 是 6 个旋转关节，7 是夹爪
export type MotorId = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type MotorStatus = 'idle' | 'running' | 'fault' | 'disabled';

// 关节轴类型：J1 yaw / J2-J3 pitch / J4 roll / J5 pitch / J6 roll / Gripper 开合
export type JointAxis = 'yaw' | 'pitch' | 'roll' | 'grip';
/** 与 JointAxis 等价；保留为别名以便不同语境复用。 */
export type Axis = JointAxis;

export interface MotorTelemetry {
  id: MotorId;
  name: string;          // 例如 J1 / Gripper
  label: string;         // 中文描述，如 "基座旋转"
  position: number;      // 弧度，夹爪是开度百分比 0-1
  velocity: number;      // rad/s
  torque: number;        // Nm
  temperature: number;   // °C
  status: MotorStatus;
  statusCode: number;    // 驱动器状态码；0 = 正常（healthy）
  axis: JointAxis;
}

export interface TelemetrySnapshot {
  timestamp: number;     // ms
  motors: MotorTelemetry[];
  commFreq: number;      // Hz
  latencyMs: number;
  dropRate: number;      // 0-1
  canStatus: 'ok' | 'warn' | 'error';
  sessionId: string;
}

// ===== 已录动作 =====

/** 带录制时间戳的单帧采样（相对于录制开始，单位秒） */
export interface TimedSample {
  /** 相对录制开始的时间偏移（秒） */
  t: number;
  /** 7 个关节位置（rad） */
  positions: number[];
}

export interface RecordedAction {
  id: string;
  name: string;
  createdAt: number;
  durationMs: number;
  sampleCount: number;
  samplingHz: number;
  jointCount: number;     // 一般 7
  // 简化存储：每个关节是一段归一化后的轨迹
  trails: number[][];     // [joint][sample]
  /**
   * 带时间戳的原始采样（仅 raw 版本有）。
   * 用于轨迹处理时保留原始录制的运动速度信息。
   */
  timedSamples?: TimedSample[];
  /** raw never changes; processed is a separately saved offline derivative. */
  version?: 'raw' | 'processed' | 'seed';
  rawActionId?: string;
  processing?: {
    maxJointVelocity: number[];
    maxProgressSpeed: number;
    maxAcceleration: number;
    outputFrequency: number;
  };
  /** Legacy/demo data must never be used as a real aging source. */
  demoOnly?: boolean;
}

// ===== 老化配置 =====
export interface AgingConfig {
  actionId: string;
  /** count 按次数 / duration 按时长 / infinite 无限时长（不自动结束） */
  loopMode: 'count' | 'duration' | 'infinite';
  loopCount: number;
  durationMinutes: number;
  speedMultiplier: number;  // 0.25 .. 2.0
  loopIntervalSec: number;  // 0 .. 60
  samplingPeriodMs: number; // 50 .. 1000
  writePeriodSec: number;   // 1 .. 60
  segmentPeriodSec: number; // 60 .. 3600
  tempThresholdC: number;
  torqueThresholdNm: number;
  autoStop: boolean;
  // ---- 通信与状态保护 ----
  /** 通信丢失判定超时（ms），100 .. 10000 */
  communicationLossTimeoutMs: number;
  /** 触发保护停止的驱动器状态码列表 */
  triggerStatusCodes: number[];
  /** 遥测新鲜度超时时停止老化（进入通信丢失安全保持，不回零） */
  stopOnCommunicationLoss: boolean;
  /** 任一电机 statusCode 命中 triggerStatusCodes 时停止老化（受控回零） */
  stopOnStatusCode: boolean;
}

export interface AgingCheckItem {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

// ===== 日志 =====
export type LogEventType =
  | 'teach_record'
  | 'playback'
  | 'aging'
  | 'homing'
  | 'emergency'
  | 'system';

export type LogResult = 'success' | 'warning' | 'error' | 'info';

export interface LogEntry {
  id: string;
  sessionId: string;
  timestamp: number;
  type: LogEventType;
  result: LogResult;
  title: string;
  detail?: string;
  meta?: Record<string, string | number>;
}

// ===== 录制配置 =====
export interface RecordConfig {
  name: string;
  samplingHz: number;       // 10 / 30 / 50 / 100
  countdownSec: number;     // 3 / 5 / 10
}

// ===== 录制内部状态 =====
export interface RecordingState {
  name: string;
  samplingHz: number;
  startedAt: number;
  /** 录制开始时的 performance.now() 基准，用于计算 TimedSample.t */
  recordingStartTime: number | null;
  sampleCount: number;
  countdownEndsAt: number | null;
  status: 'countdown' | 'recording' | 'finishing';
}

// ===== 回放内部状态 =====
export interface PlaybackState {
  actionId: string;
  speedMultiplier: number;
  startedAt: number;
  status: 'running' | 'paused' | 'finishing';
}

// ===== 老化内部状态 =====
export interface AgingState {
  actionId: string;
  /** 本次启动时锁定的配置快照；运行时判定与显示只读它，不依赖页面草稿 */
  config: AgingConfig;
  startedAt: number;
  loopsCompleted: number;
  totalLoops: number;        // loopMode === 'count' 时生效；infinite 时为 0
  endAt: number | null;      // loopMode === 'duration' 时生效；infinite 时为 null
  status: 'running' | 'paused' | 'finishing';
}

// ===== 机械臂连接（真实后端 API） =====
// 连接状态完全来自后端 /api/robot/{connection,scan,disconnect} 的返回。
// 只有期望电机 ID 全部发现（status === 'connected'）才视为已连接。
export type RobotConnectionStatus =
  | 'disconnected'
  | 'scanning'
  | 'connected'
  | 'partial'
  | 'error';

/** 后端返回的连接快照：字段名与 API 契约一致（snake_case）。 */
export interface RobotConnection {
  status: RobotConnectionStatus;
  /** CAN 通道（如 can0） */
  channel: string;
  /** 期望的电机 ID 列表（固定 1..7） */
  expected_ids: number[];
  /** 最近一次扫描发现的电机 ID */
  found_ids: number[];
  /** 最近一次扫描缺失的电机 ID */
  missing_ids: number[];
  /** 最近一次扫描开始时间（ISO，可能为 null） */
  started_at: string | null;
  /** 最近一次扫描完成时间（ISO，可能为 null） */
  completed_at: string | null;
  /** 适配器来源：simulation / motorbridge（用于显示模拟模式） */
  source: string | null;
  /** 后端附带的人类可读说明 */
  message: string | null;
  /**
   * 后端随连接响应返回的能力（可选）。存在时前端经 fail-closed 严格解析后
   * 直接采用（connectionReducer.capabilitiesFor）；缺失时按 source 派生
   * （simulation → 全开，其余 → fail closed）。绝不依据 source 猜测真机能力。
   * 运行时对象可能额外携带 active_report_write（HealthCapabilities）。
   */
  capabilities?: RobotCapabilities;
}

/** 前端连接状态：后端字段 + 本地请求/错误标志。 */
export interface ConnectionState extends RobotConnection {
  /** 是否有扫描请求在途（防重复点击、显示"扫描中"） */
  scanning: boolean;
  /** 最近一次请求的错误（409 / 网络错误），无则 null */
  error: string | null;
  /** 最近一次成功同步时间戳 */
  syncedAt: number | null;
  /** 后端控制能力（未返回时 fail closed，见 FAIL_CLOSED_CAPABILITIES） */
  capabilities: RobotCapabilities;
}

// ===== 后端能力（为后续 /api/robot/capabilities 预留） =====
// 语义：某项能力在后端明确提供前一律视为 false（fail closed）。
// 仅 scan 默认可用；每项写能力都由后端 capability 与环境门禁单独决定。
export interface RobotCapabilities {
  /** 只读扫描 */
  scan: boolean;
  /** 遥测数据流 */
  telemetry: boolean;
  /** 手动、二次确认后的 enable_all；不代表完整运动控制。 */
  enable: boolean;
  /** 运动控制（录制 / 回放 / 老化统一受控） */
  control: boolean;
  /** 受控回零 */
  homing: boolean;
  /** 失能 / 紧急失能 */
  disable: boolean;
  /** 旧的聚合参数能力；保持关闭，避免误开放未实现的参数操作。 */
  parameter_write: boolean;
  /** 仅持久化 RobStride 位置环 KP / 速度环 KP（0x701E/0x701F） */
  persistent_gain_write: boolean;
  /** MIT 帧 kp/kd 写入；本阶段保持关闭 */
  mit_gain_write: boolean;
  /** 用户确认后的整机机械零位持久化写入 */
  set_zero: boolean;
  /** 后端拥有的零力矩状态机 */
  zero_torque: boolean;
}

/** fail closed：能力未返回时的默认值。 */
export const FAIL_CLOSED_CAPABILITIES: RobotCapabilities = {
  scan: true,
  telemetry: false,
  enable: false,
  control: false,
  homing: false,
  disable: false,
  parameter_write: false,
  persistent_gain_write: false,
  mit_gain_write: false,
  set_zero: false,
  zero_torque: false,
};

/**
 * 后端 /api/health 返回的能力契约（在 RobotCapabilities 之上多一个
 * active_report_write）。前后端字段一一对应；前端解析时 fail closed，
 * 仅当字段显式为 true 才视为具备该能力。
 */
export interface HealthCapabilities extends RobotCapabilities {
  /** 唯一被授权的电机写（robstride_set_active_report 开关）。
   *  仅 REBOT_ADAPTER=motorbridge + REBOT_ALLOW_ACTIVE_REPORT_WRITE=1
   *  且 SDK 版本门禁通过时为 true。 */
  active_report_write: boolean;
}

export interface ZeroTorqueStatus {
  status: 'inactive' | 'starting' | 'active' | 'stopping' | 'error';
  frequency_hz: number;
  channel: string;
  motor_ids: number[];
  started_at: string | null;
  updated_at: string;
  error: string | null;
}

/** simulation 原型演示模式：允许完整模拟控制流程。 */
export const SIMULATION_CAPABILITIES: RobotCapabilities = {
  scan: true,
  telemetry: true,
  enable: false,
  control: true,
  homing: true,
  disable: true,
  parameter_write: true,
  persistent_gain_write: false,
  mit_gain_write: false,
  set_zero: false,
  zero_torque: false,
};

/** 真机只读禁用原因（所有被禁写操作统一展示）。 */
export const READONLY_REASON = '当前为真机只读连接，后端控制能力尚未启用';

// ===== 统一安全状态机 =====
// 手动断开、通信异常、老化故障统一走同一套状态机，后续真实后端可
// 逐步返回执行结果（SAFETY_STOPPED / _HOMING_OK / _DISABLE_DONE ...）。
// 状态转换见 AppContext reducer 与 SafetyRuntimeMonitor 驱动器。
export type SafetyStatus =
  | 'idle'                  // 无安全序列进行
  | 'stopping'              // 正在停止当前任务
  | 'homing'                // 正在回零（回零已完成前不声称到位）
  | 'disabling'             // 正在失能
  | 'disconnecting'         // 回零+失能完成：正在调用 POST /api/robot/disconnect
  | 'disconnected'          // 已安全断开（回零 → 失能 → 断开接口全部完成）
  | 'hold_comm_lost'        // 通信丢失安全保持：不盲目模拟回零/失能
  | 'hold_homing_failed'    // 回零失败保持：需人工处理
  | 'hold_disable_failed';  // 失能失败保持：需人工处理

export type SafetyTrigger =
  | 'manual-disconnect'     // 用户点击断开（运行中或空闲）
  | 'business-end'          // 业务模式正常结束（回零并失能）
  | 'comm-lost'             // 通信丢失
  | 'aging-fault';          // 老化故障 / 状态码命中

export interface SafetyState {
  status: SafetyStatus;
  trigger: SafetyTrigger | null;
  startedAt: number | null;
  /** 回零进度 0..1 */
  homingProgress: number;
  /** 失败 / 保持阶段的人工处理提示 */
  failureDetail: string | null;
  /** 序列开始或恢复时通信是否可用（决定可否回零/失能） */
  commAvailable: boolean;
}

export const SAFETY_STATUS_LABEL: Record<SafetyStatus, string> = {
  idle: '安全空闲',
  stopping: '正在停止任务',
  homing: '正在回零',
  disabling: '正在失能',
  disconnecting: '正在调用断开接口',
  disconnected: '已安全断开',
  hold_comm_lost: '通信丢失安全保持',
  hold_homing_failed: '回零失败保持',
  hold_disable_failed: '失能失败保持',
};

export const SAFETY_TRIGGER_LABEL: Record<SafetyTrigger, string> = {
  'manual-disconnect': '手动断开',
  'business-end': '正常结束',
  'comm-lost': '通信丢失',
  'aging-fault': '老化故障',
};

// ===== 趋势曲线（WebSocket 遥测） =====
export type TrendMetric = 'position' | 'velocity' | 'torque' | 'temperature' | 'status';
export type TrendWindow = '10s' | '30s' | '2m';

export interface TrendSeriesPoint {
  t: number;
  v: number;
}

/** 趋势点别名（环形缓冲使用）。 */
export type TrendPoint = TrendSeriesPoint;

export interface TrendSeries {
  motorId: number;
  metric: TrendMetric;
  data: TrendSeriesPoint[];
}

// ===== WebSocket 只读遥测（/ws/robot/telemetry） =====
// 帧契约与后端一致：position rad / velocity rad/s / torque Nm / temperature °C。
export interface TelemetryJoint {
  id: number;
  position: number | null;
  velocity: number | null;
  torque: number | null;
  current: null;
  temperature: { mos: number | null; rotor: number | null };
  status_code: number | null;
  error_code: null;
  freshness: 'fresh' | 'none';
}

export interface TelemetryFrame {
  timestamp: string; // ISO-8601 UTC
  sequence: number;
  channel: string;
  source: string; // 'simulation' | 'motorbridge'
  units: Record<string, string>;
  joints: TelemetryJoint[];
}

/** WebSocket 遥测连接状态（与 robot connection 状态相互独立）。 */
export type WsTelemetryStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'stale';

/** 通信统计（由遥测帧计算）。 */
export interface CommStats {
  /** 更新频率（Hz），由最近帧间隔估算 */
  freq: number;
  /** 数据到达延迟（ms）≈ 距上一帧到达的间隔 */
  latencyMs: number;
  /** 丢帧率 0..1（基于 sequence 跳号） */
  dropRate: number;
  /** 累计乱序/跳号次数 */
  seqErrors: number;
  /** 最近一帧 sequence */
  lastSeq: number | null;
  /** 最近一帧到达的墙钟时间（ms） */
  lastArrivalMs: number | null;
}

/** 每关节最新实时值（透出给监控/趋势/URDF）。 */
export interface LiveJoint {
  id: number;
  position: number | null;
  velocity: number | null;
  torque: number | null;
  tempMos: number | null;
  tempRotor: number | null;
  statusCode: number | null;
  freshness: 'fresh' | 'none';
}

// ===== 参数配置：电机参数 =====
// 电机型号（RS 硬件参考配置 rebotarm_rs.yaml）：J1–J3 为 rs-06，J4–J6 与夹爪为 rs-00
export type MotorModel = 'rs-06' | 'rs-00';

/**
 * 单个关节的持久化增益镜像。
 * 兼容字段 kp/kd 分别映射到 0x701E 位置环 Kp 与 0x701F 速度环 Kp；
 * 它们不是 MIT 帧参数，也不等价于零力矩。
 */
export interface JointParam {
  motorId: MotorId;           // CAN 电机 ID（0x01..0x07）
  hostId: number;             // 反馈主机 ID（0xFD）
  model: MotorModel;
  kp: number;                 // 持久位置环 Kp（0x701E）
  kd: number;                 // 持久速度环 Kp（0x701F，兼容旧字段名）
  defaultKp: number;          // RS 硬件参考默认 KP
  defaultKd: number;          // RS 硬件参考默认 KD
  lastUpdated: number | null; // 最近一次后端确认写入时间
}

/** 单个关节的持久化增益变更（前后对比，用于二次确认摘要与审计日志） */
export interface MitGainChange {
  motorId: MotorId;
  name: string;
  fromKp: number;
  fromKd: number;
  toKp: number;
  toKd: number;
}

// ===== 工具：会话 =====
export interface SessionInfo {
  id: string;
  startedAt: number;
  controlMode: ControlMode;
  emergency: boolean;
}
