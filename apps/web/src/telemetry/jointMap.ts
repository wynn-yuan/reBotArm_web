/**
 * 电机 ID 1–7 → URDF 关节「名称」映射（已从配置与 URDF 确认，不做猜测）。
 *
 * 依据：
 * - reBotArm_control/config/rebotarm_rs.yaml：joint1..joint6 = motor_id
 *   0x01..0x06（group arm），gripper = 0x07（group gripper）。
 * - URDF（rebot-b601-rs/model.urdf，与参考项目 00-arm-rs_asm-v3 一致）：
 *   旋转关节 joint1..joint6；夹爪直线关节 joint_left / joint_right。
 *
 * 数值变换（scale/direction/offset）、URDF 限位与夹爪标定状态一律见
 * telemetry/jointTransform.ts —— 本文件只做 ID → 关节名对应。
 *
 * 历史说明：旧版曾在此用 clamp01(position) * 0.05/0.0715 驱动夹爪，
 * 那是把「原始弧度」臆测为 0..1 开度；该映射无任何源码/配置依据，已移除。
 */
export type JointTarget =
  | { kind: 'rotational'; urdf: string }
  | { kind: 'gripper'; left: string; right: string };

export const JOINT_ID_TO_URDF: Record<number, JointTarget> = {
  1: { kind: 'rotational', urdf: 'joint1' },
  2: { kind: 'rotational', urdf: 'joint2' },
  3: { kind: 'rotational', urdf: 'joint3' },
  4: { kind: 'rotational', urdf: 'joint4' },
  5: { kind: 'rotational', urdf: 'joint5' },
  6: { kind: 'rotational', urdf: 'joint6' },
  7: { kind: 'gripper', left: 'joint_left', right: 'joint_right' },
};

/** 期望的电机 ID（固定 1..7，6 关节 + 夹爪）。 */
export const TELEMETRY_EXPECTED_IDS: number[] = [1, 2, 3, 4, 5, 6, 7];
