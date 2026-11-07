import { describe, expect, it } from 'vitest';
import { convertAction, convertTrails, jointFlips, parseJointAxes } from './armConversion';

const URDF = (ax: number) => `
<robot name="t">
  <joint name="joint1" type="revolute">
    <origin xyz="0 0 0" rpy="0 0 0" />
    <axis xyz="0 0 ${ax}" />
    <limit lower="-2.8" upper="2.8" />
  </joint>
  <joint name="joint2" type="revolute">
    <origin xyz="0 0 0" rpy="-1.5708 0 0" />
    <axis xyz="0 0 ${ax}" />
    <limit lower="-3.14" upper="0" />
  </joint>
  <joint name="end" type="fixed" />
</robot>`;

describe('parseJointAxes', () => {
  it('reads ±z axes and rotates them by origin rpy', () => {
    const rs = parseJointAxes(URDF(1));
    const dm = parseJointAxes(URDF(-1));
    expect(rs.size).toBe(2);
    // rpy = -90° about x 把 z 轴转到 +y / -y（-1.5708 不是精确 π/2，留浮点余量）
    const rsJ2 = rs.get('joint2')!;
    const dmJ2 = dm.get('joint2')!;
    expect(rsJ2.x).toBeCloseTo(0, 3);
    expect(rsJ2.y).toBeCloseTo(1, 3);
    expect(rsJ2.z).toBeCloseTo(0, 3);
    expect(dmJ2.y).toBeCloseTo(-1, 3);
  });
});

describe('jointFlips', () => {
  it('flips joints whose axes point opposite', () => {
    expect(jointFlips([{ x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }],
      [{ x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }])).toEqual([true, false]);
  });

  it('rejects non-collinear axes', () => {
    expect(() => jointFlips([{ x: 1, y: 0, z: 0 }], [{ x: 0, y: 1, z: 0 }])).toThrow(/不共线/);
  });
});

describe('convertTrails', () => {
  const trails = [[0, 0.2, 0.4], [0, 0.3, 0.6]];

  it('negates flipped joints and drops extra gripper trail', () => {
    const { trails: out, violations } = convertTrails([...trails, [0, 1, 2]], [true, true], {
      targetHasGripper: false,
    });
    expect(out).toEqual([[ -0, -0.2, -0.4], [ -0, -0.3, -0.6]]);
    expect(violations).toEqual([]);
  });

  it('reports limit violations instead of throwing', () => {
    const { violations } = convertTrails(trails, [false, false], {
      targetHasGripper: false,
      limits: [[-0.1, 0.1], null],
    });
    expect(violations).toEqual([{ joint: 0, min: 0, max: 0.4, lower: -0.1, upper: 0.1 }]);
  });

  it('refuses to invent a gripper trail', () => {
    expect(() => convertTrails(trails, [true, true], { targetHasGripper: true })).toThrow(/夹爪/);
  });

  it('copies the gripper trail when both sides have one', () => {
    const { trails: out } = convertTrails([...trails, [0, 1, 2]], [true, false], { targetHasGripper: true });
    expect(out[2]).toEqual([0, 1, 2]);
  });
});

describe('convertAction', () => {
  const action = {
    id: 'a1', name: 'wave', createdAt: 1, durationMs: 30, sampleCount: 3, samplingHz: 100,
    jointCount: 2, trails: [[0, 0.2, 0.4], [0, 0.3, 0.6]], version: 'raw' as const,
    timedSamples: [{ t: 0, positions: [0, 0] }, { t: 0.01, positions: [0.2, 0.3] }],
  };

  it('tags the result with the target arm and negates samples', () => {
    const out = convertAction(action, { armId: 'dm', armName: 'DM', flips: [true, true], targetHasGripper: false });
    expect(out.armId).toBe('dm');
    expect(out.name).toContain('DM');
    expect(out.id).not.toBe('a1');
    expect(out.trails[0][1]).toBeCloseTo(-0.2);
    expect(out.timedSamples?.[1].positions).toEqual([-0.2, -0.3]);
  });
});