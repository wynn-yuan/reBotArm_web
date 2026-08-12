/**
 * 关节映射与变换（任务 6）：显式、有依据、绝不伪造。
 *
 * 核心公式（每个旋转关节）：
 *   urdf_position = raw_position * scale * direction + offset
 *
 * ===== 依据（全部来自本地源码 / 配置，无猜测） =====
 *
 * 1) ID → 关节名
 *    reBotArm_control/config/rebotarm_rs.yaml：joint1..joint6 = motor_id
 *    0x01..0x06（group arm），gripper = 0x07（group gripper）。
 *
 * 2) ID 1..6 变换 = 恒等（scale=1, direction=+1, offset=0）
 *    - reBotArm_control_py/controllers/rebotarm_endpose_controller.py：
 *      move_to_ik / move_to_traj / safe_home 均把电机反馈 q（get_state()）
 *      经 pad_q_for_model 后直接送入同一 URDF（00-arm-rs_asm-v3）的
 *      Pinocchio FK/IK，并把 q_target 原样下发给电机；safe_home 以 q=0 为
 *      回零位。即参考控制栈中「电机弧度 == URDF 关节位置」。
 *    - reBotArm_control_py/kinematics/robot_model.py pad_q_for_model(91-98)：
 *      只做零填充，不存在任何 scale / direction / offset 变换。
 *    - config/rebotarm_rs.yaml 与 rebotarm.py JointCfg：整个配置与代码中
 *      不存在 scale / direction / offset 字段。
 *    - apps/server/src/rebot_server/telemetry.py：position 为 MotorState.pos
 *      原始弧度值，服务端不做任何变换。
 *
 * 3) 机械零位：不可远程确认（zeroVerified = false）
 *    - reBotArm_control_py/actuator/rebotarm.py set_zero()(588-611)：对每个
 *      关节调用 motorbridge set_zero_position()，把「当前机械姿态」写为电机
 *      零位；example/2_zero_and_read.py 即人工摆放后执行该流程。
 *    - 遥测帧不含「是否在 URDF 家位完成标零」的信息，前端无法确认 →
 *      按任务要求不得假装已标定，UI 必须如实标注。
 *
 * 4) URDF 限位（packages/robot-description/public/robots/rebot-b601-rs/
 *    model.urdf，与参考项目 urdf/00-arm-rs_asm-v3 完全一致）：
 *    joint1 [-2.8, 2.8]、joint2 [0, 3.14]、joint3 [0, 3.14]、
 *    joint4 [-1.57, 1.57]、joint5 [-1.57, 1.57]、joint6 [-3.14, 3.14]；
 *    joint_left [0, 0.05] m、joint_right [0, 0.0715] m（prismatic）。
 *    超限必须告警；渲染用的截断值单独标注，绝不冒充真实值。
 *
 * 5) ID 7 夹爪：映射待标定（calibrated = false）
 *    - 电机行程：test_config.yaml gripper close=0.0 / open=3.0（rad），
 *      main_test.py 以 "g 0.0" / "g 3.0" 下发。
 *    - URDF 行程：joint_left 0..0.05 m、joint_right 0..0.0715 m。
 *    - 但「电机弧度 → 开合米制」的传动比、左右手指方向、机械零位与最大
 *      物理开度在全部源码/配置中均无依据 → 禁止 clamp01 等臆测映射；
 *      只展示原始弧度，暂停夹爪模型动画，并给出手动标定步骤。
 */

export const ARM_JOINT_IDS = [1, 2, 3, 4, 5, 6] as const;
export type ArmJointId = (typeof ARM_JOINT_IDS)[number];

export const GRIPPER_ID = 7;

export interface JointTransformCfg {
  scale: number;
  direction: 1 | -1;
  offset: number;
  /** 机械零位是否已确认（遥测无法确认现场 set_zero → 全部 false） */
  zeroVerified: boolean;
  /** 依据条目（源码 / 配置路径） */
  evidence: readonly string[];
}

const IDENTITY_EVIDENCE = [
  'reBotArm_control_py/controllers/rebotarm_endpose_controller.py：get_state() 的电机弧度反馈经 pad_q_for_model 直接用于同一 URDF 的 FK/IK，safe_home() 以 q=0 为家位，q_target 原样下发电机',
  'reBotArm_control_py/kinematics/robot_model.py pad_q_for_model(91-98)：仅零填充，无任何 scale/direction/offset 变换',
  'config/rebotarm_rs.yaml 与 rebotarm.py JointCfg：不存在 scale/direction/offset 字段',
  'apps/server/src/rebot_server/telemetry.py：position 为 MotorState.pos 原始弧度，服务端无变换',
] as const;

const ZERO_EVIDENCE = [
  'reBotArm_control_py/actuator/rebotarm.py set_zero()(588-611)：motorbridge set_zero_position() 将当前机械姿态写为电机零位',
  'example/2_zero_and_read.py：人工摆放姿态后执行标零',
  '遥测帧不含标零状态字段，前端无法远程确认',
] as const;

const IDENTITY_TRANSFORM: JointTransformCfg = {
  scale: 1,
  direction: 1,
  offset: 0,
  zeroVerified: false,
  evidence: IDENTITY_EVIDENCE,
};

/** ID 1..6：恒等变换（依据见上）。任何修改必须先补充源码/配置依据。 */
export const ARM_JOINT_TRANSFORMS: Record<ArmJointId, JointTransformCfg> = {
  1: IDENTITY_TRANSFORM,
  2: IDENTITY_TRANSFORM,
  3: IDENTITY_TRANSFORM,
  4: IDENTITY_TRANSFORM,
  5: IDENTITY_TRANSFORM,
  6: IDENTITY_TRANSFORM,
};

/** 零位相关依据（UI 展示用）。 */
export const ZERO_EVIDENCE_ITEMS: readonly string[] = ZERO_EVIDENCE;

// ===== URDF 限位（model.urdf <limit lower upper>，单位 rad / m） =====

export interface UrdfLimit {
  lower: number;
  upper: number;
}

export const URDF_REVOLUTE_LIMITS: Record<string, UrdfLimit> = {
  joint1: { lower: -2.8, upper: 2.8 },
  joint2: { lower: 0, upper: 3.14 },
  joint3: { lower: 0, upper: 3.14 },
  joint4: { lower: -1.57, upper: 1.57 },
  joint5: { lower: -1.57, upper: 1.57 },
  joint6: { lower: -3.14, upper: 3.14 },
};

export const URDF_GRIPPER_LIMITS: Record<'joint_left' | 'joint_right', UrdfLimit> = {
  joint_left: { lower: 0, upper: 0.05 },
  joint_right: { lower: 0, upper: 0.0715 },
};

// ===== 旋转关节映射 =====

export type LimitStatus = 'ok' | 'out' | 'unknown';

export interface ArmJointMapped {
  id: ArmJointId;
  urdfName: string;
  /** 原始电机反馈（rad），null 原样保持 */
  raw: number | null;
  /** raw * scale * direction + offset；null → null（绝不伪造） */
  mapped: number | null;
  /** 仅供三维渲染的限位截断值（不得当作真实数据展示） */
  clampedForModel: number | null;
  limitStatus: LimitStatus;
  zeroVerified: boolean;
  transform: JointTransformCfg;
}

function isFiniteNumber(v: number | null): v is number {
  return v !== null && Number.isFinite(v);
}

/** 按显式变换 + URDF 限位映射一个旋转关节（ID 1..6）。 */
export function mapArmJoint(id: ArmJointId, raw: number | null): ArmJointMapped {
  const t = ARM_JOINT_TRANSFORMS[id];
  const urdfName = `joint${id}`;
  const limit = URDF_REVOLUTE_LIMITS[urdfName];
  if (!isFiniteNumber(raw)) {
    return {
      id,
      urdfName,
      raw: null,
      mapped: null,
      clampedForModel: null,
      limitStatus: 'unknown',
      zeroVerified: t.zeroVerified,
      transform: t,
    };
  }
  const mapped = raw * t.scale * t.direction + t.offset;
  const out = mapped < limit.lower || mapped > limit.upper;
  const clamped = Math.min(limit.upper, Math.max(limit.lower, mapped));
  return {
    id,
    urdfName,
    raw,
    mapped,
    clampedForModel: clamped,
    limitStatus: out ? 'out' : 'ok',
    zeroVerified: t.zeroVerified,
    transform: t,
  };
}

// ===== 夹爪（ID 7）：待标定 =====

export interface GripperEvidence {
  motorTravel: { close: number; open: number; unit: 'rad'; source: string };
  urdfStroke: { left: UrdfLimit; right: UrdfLimit; source: string };
  /** 缺失的依据项 —— 任一缺失即不得标定 */
  missing: readonly string[];
}

export const GRIPPER_EVIDENCE: GripperEvidence = {
  motorTravel: {
    close: 0.0,
    open: 3.0,
    unit: 'rad',
    source: 'reBotArm_control/config/test_config.yaml gripper.close/open；main_test.py 以 "g 0.0"/"g 3.0" 使用',
  },
  urdfStroke: {
    left: URDF_GRIPPER_LIMITS.joint_left,
    right: URDF_GRIPPER_LIMITS.joint_right,
    source: 'model.urdf joint_left/joint_right <limit>（prismatic，0..0.05 / 0..0.0715 m）',
  },
  missing: [
    '电机角度 → 夹爪开度的传动比（0..3 rad ↔ 0..0.05 / 0..0.0715 m 行程之间无丝杆/齿轮参数依据）',
    '左右手指开合方向与 URDF joint_left/joint_right 正方向的对应关系',
    '机械零位确认（close=0.0 仅为 test_config.yaml 的指令名义值，未经实机验证）',
    '最大开度的物理实测值',
  ],
};

export type GripperMapped =
  | { calibrated: false; raw: number | null; missing: readonly string[] }
  | { calibrated: true; raw: number; leftMeters: number; rightMeters: number };

/**
 * 夹爪映射：当前无标定参数，永远返回未标定分支。
 * 禁止对原始弧度做 clamp01 / 比例臆测；只透出 raw 供展示。
 */
export function mapGripperJoint(raw: number | null): GripperMapped {
  return {
    calibrated: false,
    raw: isFiniteNumber(raw) ? raw : null,
    missing: GRIPPER_EVIDENCE.missing,
  };
}

/** 手动标定步骤（必须由用户在实机上执行；本控制台只读，不下发任何运动指令）。 */
export const GRIPPER_CALIBRATION_STEPS: readonly string[] = [
  '将夹爪手动移动到完全闭合位（可参考 reBotArm_control/example/2_zero_and_read.py 的随动模式观察读数），记录此时电机角度；',
  '确认闭合基准：核对标零后的读数与 test_config.yaml 的 close=0.0 是否一致；',
  '将夹爪手动移动到完全张开位，记录电机角度（名义 open=3.0 rad），并用卡尺实测指间物理开度；',
  '在多个中间开度分别记录「电机角度 ↔ 实测开度（mm）」，拟合左、右手指各自的换算比例；',
  '确认左右手指张开方向与 URDF joint_left/joint_right 正方向（axis (0,0,1)）是否一致，记录方向符号；',
  '将比例、方向、零位偏移写入映射配置后，重新对比模型与实机验证。',
];

export const GRIPPER_CALIBRATION_NOTE =
  '夹爪映射待标定：电机角度到开度的传动比、左右方向、机械零位与最大开度均无依据，已暂停夹爪模型动画，仅展示原始弧度。';

// ===== 整帧映射（供 URDF 渲染与 UI 共用） =====

export interface RobotJointWrite {
  jointName: string;
  value: number;
}

export interface FrameMapResult {
  /** 可直接写入 URDF 关节的数值（旋转关节为限位截断后的映射值） */
  writes: RobotJointWrite[];
  /** 超出 URDF 限位的电机 ID（需要告警） */
  outOfLimitIds: ArmJointId[];
  /** 夹爪映射结果（未标定 → 无 writes，模型动画暂停） */
  gripper: GripperMapped;
}

/**
 * 把一帧关节值映射为 URDF 写入指令。
 * 夹爪未标定时绝不产生 joint_left/joint_right 写入（暂停动画，不伪造开度）。
 */
export function computeRobotJointWrites(
  joints: ReadonlyArray<{ id: number; position: number | null }>,
): FrameMapResult {
  const writes: RobotJointWrite[] = [];
  const outOfLimitIds: ArmJointId[] = [];
  let gripperRaw: number | null = null;
  for (const j of joints) {
    if ((ARM_JOINT_IDS as readonly number[]).includes(j.id)) {
      const m = mapArmJoint(j.id as ArmJointId, j.position);
      if (m.clampedForModel !== null) {
        writes.push({ jointName: m.urdfName, value: m.clampedForModel });
      }
      if (m.limitStatus === 'out') outOfLimitIds.push(m.id);
    } else if (j.id === GRIPPER_ID) {
      gripperRaw = isFiniteNumber(j.position) ? j.position : null;
    }
  }
  return { writes, outOfLimitIds, gripper: mapGripperJoint(gripperRaw) };
}

// ===== UI 视图（原始值 + 映射值并列，供真机核对） =====

export interface ArmJointView {
  id: ArmJointId;
  urdfName: string;
  raw: number | null;
  mapped: number | null;
  limitStatus: LimitStatus;
  zeroVerified: boolean;
}

/** 从「每关节最新值」列表构建 ID 1..6 的展示视图（顺序固定 1..6）。 */
export function armJointViews(
  joints: ReadonlyArray<{ id: number; position: number | null }>,
): ArmJointView[] {
  return ARM_JOINT_IDS.map((id) => {
    const j = joints.find((x) => x.id === id);
    const m = mapArmJoint(id, j ? j.position : null);
    return {
      id,
      urdfName: m.urdfName,
      raw: m.raw,
      mapped: m.mapped,
      limitStatus: m.limitStatus,
      zeroVerified: m.zeroVerified,
    };
  });
}
