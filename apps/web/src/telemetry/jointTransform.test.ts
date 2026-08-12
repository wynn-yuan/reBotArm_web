import { describe, expect, it } from 'vitest';
import {
  ARM_JOINT_IDS,
  ARM_JOINT_TRANSFORMS,
  GRIPPER_CALIBRATION_NOTE,
  GRIPPER_CALIBRATION_STEPS,
  GRIPPER_EVIDENCE,
  URDF_GRIPPER_LIMITS,
  URDF_REVOLUTE_LIMITS,
  armJointViews,
  computeRobotJointWrites,
  mapArmJoint,
  mapGripperJoint,
  type ArmJointId,
} from './jointTransform';

// ===== ID 1-6：scale / direction / offset =====

describe('ID 1-6 显式变换 urdf = raw * scale * direction + offset', () => {
  it('每个关节都有 scale/direction/offset 与依据条目（不得为空）', () => {
    for (const id of ARM_JOINT_IDS) {
      const t = ARM_JOINT_TRANSFORMS[id];
      expect(t).toBeDefined();
      expect(Number.isFinite(t.scale)).toBe(true);
      expect(t.scale).toBeGreaterThan(0);
      expect(t.direction === 1 || t.direction === -1).toBe(true);
      expect(Number.isFinite(t.offset)).toBe(true);
      expect(t.evidence.length).toBeGreaterThan(0);
    }
  });

  it('恒等变换来自参考控制栈依据：电机弧度直接用于同一 URDF 的 FK/IK（scale=1, direction=+1, offset=0）', () => {
    for (const id of ARM_JOINT_IDS) {
      const t = ARM_JOINT_TRANSFORMS[id];
      expect(t.scale).toBe(1);
      expect(t.direction).toBe(1);
      expect(t.offset).toBe(0);
    }
  });

  it('映射公式：mapped = raw * scale * direction + offset（raw=任意弧度恒等输出）', () => {
    for (const id of ARM_JOINT_IDS) {
      const m = mapArmJoint(id, 1.234);
      expect(m.mapped).toBeCloseTo(1.234, 12);
      const n = mapArmJoint(id, -2.5);
      expect(n.mapped).toBeCloseTo(-2.5, 12);
    }
  });

  it('raw 为 null → mapped 为 null（绝不伪造数值）', () => {
    for (const id of ARM_JOINT_IDS) {
      const m = mapArmJoint(id, null);
      expect(m.raw).toBeNull();
      expect(m.mapped).toBeNull();
      expect(m.clampedForModel).toBeNull();
      expect(m.limitStatus).toBe('unknown');
    }
  });

  it('机械零位不可远程确认 → zeroVerified 一律 false（不得假装已标定）', () => {
    for (const id of ARM_JOINT_IDS) {
      expect(mapArmJoint(id, 0).zeroVerified).toBe(false);
    }
  });
});

// ===== URDF 限位 =====

describe('URDF 限位（model.urdf <limit> 依据）', () => {
  it('限位表与 URDF 一致', () => {
    expect(URDF_REVOLUTE_LIMITS.joint1).toEqual({ lower: -2.8, upper: 2.8 });
    expect(URDF_REVOLUTE_LIMITS.joint2).toEqual({ lower: 0, upper: 3.14 });
    expect(URDF_REVOLUTE_LIMITS.joint3).toEqual({ lower: 0, upper: 3.14 });
    expect(URDF_REVOLUTE_LIMITS.joint4).toEqual({ lower: -1.57, upper: 1.57 });
    expect(URDF_REVOLUTE_LIMITS.joint5).toEqual({ lower: -1.57, upper: 1.57 });
    expect(URDF_REVOLUTE_LIMITS.joint6).toEqual({ lower: -3.14, upper: 3.14 });
    expect(URDF_GRIPPER_LIMITS.joint_left).toEqual({ lower: 0, upper: 0.05 });
    expect(URDF_GRIPPER_LIMITS.joint_right).toEqual({ lower: 0, upper: 0.0715 });
  });

  it('限位内 → ok，mapped 原样保留', () => {
    const m = mapArmJoint(1, 2.7);
    expect(m.limitStatus).toBe('ok');
    expect(m.mapped).toBeCloseTo(2.7, 12);
  });

  it('超出限位 → out 告警，真实映射值不被篡改，渲染用截断值单独提供', () => {
    const m = mapArmJoint(4, 2.0); // joint4 限位 [-1.57, 1.57]
    expect(m.limitStatus).toBe('out');
    expect(m.mapped).toBeCloseTo(2.0, 12); // 真实值保留（供告警展示）
    expect(m.clampedForModel).toBeCloseTo(1.57, 12); // 渲染截断值
    const below = mapArmJoint(2, -0.5); // joint2 限位 [0, 3.14]
    expect(below.limitStatus).toBe('out');
    expect(below.mapped).toBeCloseTo(-0.5, 12);
    expect(below.clampedForModel).toBe(0);
  });
});

// ===== ID 7 夹爪：未标定 =====

describe('ID 7 夹爪：标定依据缺失 → 永不 clamp01，永不产生开度', () => {
  it('依据登记：电机行程 0..3 rad（test_config.yaml）与 URDF 行程，且缺失项齐全', () => {
    expect(GRIPPER_EVIDENCE.motorTravel.close).toBe(0);
    expect(GRIPPER_EVIDENCE.motorTravel.open).toBe(3);
    expect(GRIPPER_EVIDENCE.missing.length).toBeGreaterThanOrEqual(4);
  });

  it('mapGripperJoint 永远返回未标定分支：只透出 raw，不输出米制开度', () => {
    const g = mapGripperJoint(2.35);
    expect(g.calibrated).toBe(false);
    if (!g.calibrated) {
      expect(g.raw).toBeCloseTo(2.35, 12);
      expect(g.missing.length).toBeGreaterThan(0);
    }
    // 超出名义行程的原始值也原样展示，不截断不臆测
    const big = mapGripperJoint(7.7);
    expect(big.calibrated).toBe(false);
    if (!big.calibrated) expect(big.raw).toBeCloseTo(7.7, 12);
    const nul = mapGripperJoint(null);
    expect(nul.calibrated).toBe(false);
    if (!nul.calibrated) expect(nul.raw).toBeNull();
  });

  it('computeRobotJointWrites：夹爪不产生 joint_left/joint_right 写入（模型动画暂停）', () => {
    const r = computeRobotJointWrites([{ id: 7, position: 2.0 }]);
    expect(r.writes).toEqual([]);
    expect(r.gripper.calibrated).toBe(false);
    expect(GRIPPER_CALIBRATION_NOTE).toContain('待标定');
  });

  it('提供人工标定步骤，且明确前端/自动工具不操作机械臂', () => {
    expect(GRIPPER_CALIBRATION_STEPS.length).toBeGreaterThanOrEqual(5);
    expect(GRIPPER_CALIBRATION_STEPS.join('\n')).toContain('手动');
  });
});

// ===== 整帧映射 =====

describe('computeRobotJointWrites（整帧）', () => {
  it('ID 1-6 产生 jointN 写入（限位截断），ID 7 无写入，超限 ID 被收集', () => {
    const r = computeRobotJointWrites([
      { id: 1, position: 1.0 },
      { id: 2, position: 3.2 }, // 超出 joint2 上限 3.14
      { id: 3, position: null }, // 缺失 → 无写入
      { id: 7, position: 1.5 },
    ]);
    expect(r.writes).toEqual([
      { jointName: 'joint1', value: 1.0 },
      { jointName: 'joint2', value: 3.14 },
    ]);
    expect(r.outOfLimitIds).toEqual([2]);
    expect(r.gripper.calibrated).toBe(false);
  });

  it('armJointViews：原始值与映射值并列（供真机核对），顺序固定 1..6', () => {
    const views = armJointViews([
      { id: 6, position: -3.2 },
      { id: 1, position: 0.5 },
    ]);
    expect(views.map((v) => v.id)).toEqual([1, 2, 3, 4, 5, 6]);
    const v1 = views.find((v) => v.id === 1);
    expect(v1?.raw).toBeCloseTo(0.5, 12);
    expect(v1?.mapped).toBeCloseTo(0.5, 12);
    expect(v1?.limitStatus).toBe('ok');
    const v6 = views.find((v) => v.id === 6) as { raw: number | null; mapped: number | null; limitStatus: string };
    expect(v6.raw).toBeCloseTo(-3.2, 12);
    expect(v6.mapped).toBeCloseTo(-3.2, 12);
    expect(v6.limitStatus).toBe('out');
    const v2 = views.find((v) => v.id === 2);
    expect(v2?.raw).toBeNull();
    expect(v2?.mapped).toBeNull();
  });
});

// ===== 真机数据绝不套用模拟映射 =====

describe('真机（motorbridge）数据不套用模拟映射', () => {
  it('对真机帧使用的变换与模拟帧完全一致且有依据：无 clamp01、无百分比、无模拟曲线参与', () => {
    // 旧版夹爪映射 clamp01(rad)*0.05/0.0715 会把 raw=2.0 变成 0.05/0.0715；
    // 新映射下 ID 7 无任何米制输出（未标定），旋转关节恒等直通。
    const realJoints = [
      { id: 1, position: -2.79 },
      { id: 2, position: 3.13 },
      { id: 7, position: 2.0 },
    ];
    const r = computeRobotJointWrites(realJoints);
    const j1 = r.writes.find((w) => w.jointName === 'joint1');
    expect(j1?.value).toBeCloseTo(-2.79, 12); // 负值直通，无 clamp01
    const j2 = r.writes.find((w) => w.jointName === 'joint2');
    expect(j2?.value).toBeCloseTo(3.13, 12); // >1 的值直通，无 clamp01
    expect(r.writes.some((w) => w.jointName === 'joint_left')).toBe(false);
    expect(r.writes.some((w) => w.jointName === 'joint_right')).toBe(false);
  });

  it('旋转关节映射不产生 0..1 截断行为（clamp01 特征检测）', () => {
    const id: ArmJointId = 6; // 限位最宽 [-3.14, 3.14]
    for (const raw of [-3.0, -1.0, 0.0, 1.0, 3.0]) {
      expect(mapArmJoint(id, raw).mapped).toBeCloseTo(raw, 12);
    }
  });
});
