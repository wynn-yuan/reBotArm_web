import type {
  Axis,
  MotorId,
  MotorModel,
  JointParam,
  RecordedAction,
  LogEntry,
} from '../types';

// ===== 关节定义 =====
// 6 个旋转关节 + 1 个夹爪。轴顺序与真实 reBot B601-RS 保持一致。
const JOINT_DEFS: Array<{
  id: MotorId;
  name: string;
  label: string;
  axis: Axis;
  baseTemp: number;
}> = [
  { id: 1, name: 'J1', label: '基座旋转', axis: 'yaw',   baseTemp: 38 },
  { id: 2, name: 'J2', label: '肩部俯仰', axis: 'pitch', baseTemp: 40 },
  { id: 3, name: 'J3', label: '肘部俯仰', axis: 'pitch', baseTemp: 41 },
  { id: 4, name: 'J4', label: '腕部 1 旋转', axis: 'roll', baseTemp: 39 },
  { id: 5, name: 'J5', label: '腕部 2 俯仰', axis: 'pitch', baseTemp: 40 },
  { id: 6, name: 'J6', label: '腕部 3 旋转', axis: 'roll', baseTemp: 38 },
  { id: 7, name: 'Gripper', label: '夹爪', axis: 'grip', baseTemp: 32 },
];

export const JOINT_TABLE = JOINT_DEFS;

// ===== 参数配置：RS 硬件参考默认值（rebotarm_rs.yaml） =====
// 反馈主机 ID 统一为 0xFD；电机 CAN ID 与 MotorId 一致（0x01..0x07）
export const MOTOR_HOST_ID = 0xfd;

const RS_DEFAULT_PARAMS: Record<MotorId, { model: MotorModel; kp: number; kd: number }> = {
  1: { model: 'rs-06', kp: 50, kd: 3 },   // J1 rs-06 MIT kp=50 kd=3
  2: { model: 'rs-06', kp: 150, kd: 10 }, // J2 rs-06 150/10
  3: { model: 'rs-06', kp: 150, kd: 10 }, // J3 rs-06 150/10
  4: { model: 'rs-00', kp: 50, kd: 5 },   // J4 rs-00 50/5
  5: { model: 'rs-00', kp: 50, kd: 4 },   // J5 rs-00 50/4
  6: { model: 'rs-00', kp: 50, kd: 4 },   // J6 rs-00 50/4
  7: { model: 'rs-00', kp: 50, kd: 4 },   // Gripper rs-00 50/4
};

/** 生成 7 关节初始参数：型号 / 电机 ID / 主机 ID / KP / KD 均取 RS 参考默认值 */
export function makeSeedJointParams(): JointParam[] {
  return JOINT_DEFS.map((def) => {
    const d = RS_DEFAULT_PARAMS[def.id];
    return {
      motorId: def.id,
      hostId: MOTOR_HOST_ID,
      model: d.model,
      kp: d.kp,
      kd: d.kd,
      defaultKp: d.kp,
      defaultKd: d.kd,
      lastUpdated: null,
    };
  });
}

// ===== 模拟遥测已移除 =====
// 历史版本曾在此生成前端模拟遥测快照（generateSnapshot）。接入后端只读
// WebSocket 遥测（/ws/robot/telemetry）后，该路径被完全移除：
// motorbridge 真机连接绝不读取任何前端模拟遥测数据（要求 15）。
// 实时数据一律来自 state/TelemetryContext + telemetry/telemetryClient。

// ===== 会话 =====
let _sessionId = makeId('sess');

export function getSessionId(): string {
  return _sessionId;
}

export function makeId(prefix: string): string {
  return `${prefix}-${Math.floor(Math.random() * 1e6)
    .toString(36)
    .padStart(4, '0')}-${Date.now().toString(36).slice(-4)}`;
}

export function resetSession(): void {
  _sessionId = makeId('sess');
}

// ===== 主入口：实时遥测一律来自后端 WebSocket =====
// 前端不再生成任何模拟遥测快照；实时值见 state/TelemetryContext。

// ===== 内置已录动作（占位） =====
export function makeSeedActions(): RecordedAction[] {
  const now = Date.now();
  return [
    makeAction({
      id: 'act-pick-place-01',
      name: '取-放-01（示例）',
      createdAt: now - 1000 * 60 * 60 * 26,
      samplingHz: 50,
      durationMs: 8000,
    }),
    makeAction({
      id: 'act-stack-02',
      name: '码垛-02（示例）',
      createdAt: now - 1000 * 60 * 60 * 8,
      samplingHz: 50,
      durationMs: 12000,
    }),
  ];
}

function makeAction(opts: {
  id: string;
  name: string;
  createdAt: number;
  samplingHz: number;
  durationMs: number;
}): RecordedAction {
  const sampleCount = Math.floor((opts.durationMs / 1000) * opts.samplingHz);
  // 7 个关节，每条轨迹随机形状但平滑
  const trails: number[][] = [];
  for (let j = 0; j < 7; j++) {
    const seed = j * 0.7 + 1.3;
    const arr: number[] = new Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const u = i / sampleCount;
      // 简单带阻尼的正弦 + 偏置
      const v =
        j === 6
          ? 0.4 + 0.5 * (0.5 - 0.5 * Math.cos(u * Math.PI * 2 * (j % 2 === 0 ? 1 : 2)))
          : 0.5 * Math.sin(u * Math.PI * 2 + seed) + 0.3 * Math.sin(u * Math.PI * 4 + seed * 1.7);
      arr[i] = Number(v.toFixed(3));
    }
    trails.push(arr);
  }
  return {
    id: opts.id,
    name: opts.name,
    createdAt: opts.createdAt,
    durationMs: opts.durationMs,
    sampleCount,
    samplingHz: opts.samplingHz,
    jointCount: 7,
    trails,
  };
}

// ===== 模拟产生日志 =====
export function makeSeedLogs(): LogEntry[] {
  const now = Date.now();
  return [
    {
      id: makeId('log'),
      sessionId: getSessionId(),
      timestamp: now - 1000 * 60 * 12,
      type: 'system',
      result: 'info',
      title: 'Web 控制台启动',
      detail: '第一阶段 UI 原型，仅模拟数据',
    },
    {
      id: makeId('log'),
      sessionId: getSessionId(),
      timestamp: now - 1000 * 60 * 9,
      type: 'teach_record',
      result: 'success',
      title: '完成一次遥操录制',
      detail: `动作名：取-放-01（示例）；时长 8.0s；采样 50Hz`,
    },
    {
      id: makeId('log'),
      sessionId: getSessionId(),
      timestamp: now - 1000 * 60 * 6,
      type: 'playback',
      result: 'success',
      title: '完成一次回放',
      detail: '动作：取-放-01（示例）',
    },
    {
      id: makeId('log'),
      sessionId: getSessionId(),
      timestamp: now - 1000 * 60 * 3,
      type: 'homing',
      result: 'warning',
      title: '回零序列耗时较长',
      detail: '用时 3.4s（参考值 2.5s）',
    },
  ];
}