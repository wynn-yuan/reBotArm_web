import { describe, expect, it } from 'vitest';
import { JOINT_ID_TO_URDF, TELEMETRY_EXPECTED_IDS } from './jointMap';

describe('遥测电机 ID → URDF 关节名称映射（配置依据，不允许猜测）', () => {
  it('期望的遥测电机 ID 固定为 1..7', () => {
    expect(TELEMETRY_EXPECTED_IDS).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('ID 1..6 为旋转关节，映射到 URDF joint1..joint6（rebotarm_rs.yaml motor_id 0x01..0x06）', () => {
    for (let id = 1; id <= 6; id++) {
      const target = JOINT_ID_TO_URDF[id];
      expect(target).toBeDefined();
      expect(target.kind).toBe('rotational');
      if (target.kind === 'rotational') {
        expect(target.urdf).toBe(`joint${id}`);
      }
    }
  });

  it('ID 7 为夹爪：左右直线关节名称（数值变换/标定状态见 jointTransform.ts）', () => {
    const target = JOINT_ID_TO_URDF[7];
    expect(target).toBeDefined();
    expect(target.kind).toBe('gripper');
    if (target.kind === 'gripper') {
      expect(target.left).toBe('joint_left');
      expect(target.right).toBe('joint_right');
      // 旧版的 leftScale/rightScale（clamp01 臆测映射）已被移除：
      // 夹爪无传动比依据，映射与标定状态由 jointTransform.ts 管理
      expect('leftScale' in target).toBe(false);
      expect('rightScale' in target).toBe(false);
    }
  });

  it('不存在 ID 0 / 8 及以上的映射', () => {
    expect(JOINT_ID_TO_URDF[0]).toBeUndefined();
    expect(JOINT_ID_TO_URDF[8]).toBeUndefined();
  });
});
