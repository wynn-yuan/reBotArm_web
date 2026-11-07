/**
 * 机型间轨迹转换：把在某款机械臂（如 RS）上录制的关节轨迹换算到另一款（如 DM）。
 *
 * 依据：两款机的 URDF 运动学一致（origin xyz/rpy 相同），但每个关节的转轴方向
 * 可能相反。因此同一物理姿态的关节角度互为相反数。这里从 model.urdf 解析
 * 关节转轴（经 origin rpy 旋转到父坐标系），用两轴的夹角符号决定是否取负。
 */
import type { RecordedAction } from '../types';

export interface JointAxis {
  x: number;
  y: number;
  z: number;
}

export type JointLimit = readonly [number, number] | null;

type V3 = [number, number, number];

function parseV3(text: string | null, fallback: V3): V3 {
  if (!text) return fallback;
  const parts = text.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return fallback;
  return parts as V3;
}

/** URDF <origin rpy> 把子坐标系转轴变换到父坐标系。 */
function rotateAxis(axis: V3, [roll, pitch, yaw]: V3): JointAxis {
  const [cr, sr, cp, sp, cy, sy] = [
    Math.cos(roll), Math.sin(roll), Math.cos(pitch), Math.sin(pitch), Math.cos(yaw), Math.sin(yaw),
  ];
  const [x, y, z] = axis;
  // R = Rz(yaw) · Ry(pitch) · Rx(roll)
  const x1 = x;
  const y1 = cr * y - sr * z;
  const z1 = sr * y + cr * z;
  const x2 = cp * x1 + sp * z1;
  const y2 = y1;
  const z2 = -sp * x1 + cp * z1;
  return { x: cy * x2 - sy * y2, y: sy * x2 + cy * y2, z: z2 };
}

/** 解析 model.urdf：关节名 → 父坐标系下的转轴。非 revolute 关节忽略。 */
export function parseJointAxes(urdf: string): Map<string, JointAxis> {
  const result = new Map<string, JointAxis>();
  const jointRe = /<joint\b([^>]*)>([\s\S]*?)<\/joint>/g;
  for (const match of urdf.matchAll(jointRe)) {
    const attrs = match[1];
    const name = /name="([^"]+)"/.exec(attrs)?.[1];
    const type = /type="([^"]+)"/.exec(attrs)?.[1];
    if (!name || (type !== 'revolute' && type !== 'continuous')) continue;
    const body = match[2];
    const axis = parseV3(/<axis\b[^>]*xyz="([^"]+)"/.exec(body)?.[1] ?? null, [1, 0, 0]);
    const rpy = parseV3(/<origin\b[^>]*rpy="([^"]+)"/.exec(body)?.[1] ?? null, [0, 0, 0]);
    result.set(name, rotateAxis(axis, rpy));
  }
  return result;
}

const axesCache = new Map<string, Promise<Map<string, JointAxis> | null>>();

/** 拉取某机型的 URDF 并解析转轴；失败返回 null（调用方按"无法转换"处理）。 */
export function fetchJointAxes(armId: string): Promise<Map<string, JointAxis> | null> {
  const cached = axesCache.get(armId);
  if (cached) return cached;
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  const task = fetch(`${base}robots/${encodeURIComponent(armId)}/model.urdf`)
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
    .then((text) => parseJointAxes(text))
    .catch(() => null);
  axesCache.set(armId, task);
  return task;
}

/**
 * 按关节顺序计算目标关节是否需要取负。
 * 两轴夹角余弦 < 0 即方向相反；接近正交视为不同机构，拒绝转换。
 */
export function jointFlips(
  sourceAxes: readonly (JointAxis | undefined)[],
  targetAxes: readonly (JointAxis | undefined)[],
  labels?: readonly string[],
): boolean[] {
  return targetAxes.map((target, index) => {
    const source = sourceAxes[index];
    const label = labels?.[index] ?? `J${index + 1}`;
    if (!source || !target) throw new Error(`${label} 缺少 URDF 转轴，无法转换`);
    const dot = source.x * target.x + source.y * target.y + source.z * target.z;
    if (Math.abs(dot) < 0.5) throw new Error(`${label} 的转轴不共线，两款机型机构不同，无法转换`);
    return dot < 0;
  });
}

export interface JointViolation {
  joint: number;
  min: number;
  max: number;
  lower: number;
  upper: number;
}

export interface ConvertTrailsResult {
  trails: number[][];
  violations: JointViolation[];
}

/**
 * 按 flips 取负并校验目标限位。
 *
 * "驱动关节" = flips.length（转动关节）。源动作多出来的轨迹（如 RS 的夹爪）
 * 直接丢弃；目标机型有夹爪但源动作没有对应轨迹时拒绝，绝不凭空生成。
 */
export function convertTrails(
  trails: readonly (readonly number[])[],
  flips: readonly boolean[],
  options: {
    targetHasGripper: boolean;
    limits?: readonly JointLimit[];
  },
): ConvertTrailsResult {
  if (trails.length < flips.length) {
    throw new Error(`源动作只有 ${trails.length} 条轨迹，目标机型需要 ${flips.length} 个转动关节`);
  }
  if (options.targetHasGripper && trails.length === flips.length) {
    throw new Error('目标机型带夹爪，但源动作没有夹爪轨迹，无法转换');
  }
  const converted = flips.map((flip, joint) => trails[joint].map((value) => (flip ? -value : value)));
  if (options.targetHasGripper) converted.push([...trails[flips.length]]);
  const violations: JointViolation[] = [];
  converted.forEach((trail, joint) => {
    const limit = options.limits?.[joint];
    if (!limit) return;
    const min = Math.min(...trail);
    const max = Math.max(...trail);
    if (min < limit[0] || max > limit[1]) {
      violations.push({ joint, min, max, lower: limit[0], upper: limit[1] });
    }
  });
  return { trails: converted, violations };
}

/**
 * 生成转换后的新动作（不改动源动作）。processed 版本保留处理参数与 raw 关联，
 * raw 版本保留 timedSamples（同步取负）。
 */
export function convertAction(
  action: RecordedAction,
  target: {
    armId: string;
    armName: string;
    flips: readonly boolean[];
    limits?: readonly JointLimit[];
    targetHasGripper: boolean;
  },
  now = Date.now(),
): RecordedAction {
  const { trails } = convertTrails(action.trails, target.flips, {
    targetHasGripper: target.targetHasGripper,
    limits: target.limits,
  });
  const timedSamples = action.timedSamples?.map((sample) => ({
    t: sample.t,
    positions: [
      ...target.flips.map((flip, joint) => (flip ? -(sample.positions[joint] ?? 0) : (sample.positions[joint] ?? 0))),
      ...(target.targetHasGripper ? [sample.positions[target.flips.length] ?? 0] : []),
    ],
  }));
  return {
    ...action,
    id: `${action.version === 'processed' ? 'processed' : 'act'}-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: `${action.name} · ${target.armName}`,
    createdAt: now,
    jointCount: trails.length,
    trails,
    timedSamples,
    armId: target.armId,
    armName: target.armName,
    rawActionId: action.rawActionId ?? (action.version === 'processed' ? action.id : undefined),
  };
}