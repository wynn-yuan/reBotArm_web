import { describe, expect, it } from 'vitest';
import { retimeTrajectory } from './trajectoryRetime';

const limit = (lower = -10, upper = 10) => ({ lower, upper });

function options(overrides: Record<string, unknown> = {}) {
  return {
    samplingHz: 10,
    maxJointVelocity: [1],
    maxProgressSpeed: 10,
    targetSpeed: 10,
    maxAcceleration: 2,
    outputFrequency: 50,
    jointLimits: [limit()],
    ...overrides,
  };
}

describe('fixed-speed trajectory retiming', () => {
  it('returns one stationary sample for a static path', () => {
    const input = [[0, 0, 0], [1, 1, 1]];
    const result = retimeTrajectory({
      trails: input,
      ...options({ maxJointVelocity: [1, 1], jointLimits: [limit(), limit()] }),
    });

    expect(result.trails).toEqual([[0], [1]]);
    expect(result.duration).toBe(0);
    expect(result.sampleCount).toBe(1);
    expect(result.peakVelocity).toEqual([0, 0]);
    expect(result.diagnostics.removedDuplicatePoints).toBe(2);
  });

  it('retimes a single joint with zero endpoint speed', () => {
    const result = retimeTrajectory({
      trails: [[0, 1]],
      ...options({ maxJointVelocity: [1], maxProgressSpeed: 1, targetSpeed: 1, maxAcceleration: 10 }),
    });

    expect(result.trails[0][0]).toBe(0);
    expect(result.trails[0].at(-1)).toBe(1);
    expect(result.diagnostics.effectiveTargetProgressSpeed).toBeCloseTo(1);
    expect(result.duration).toBeGreaterThanOrEqual(1);
    expect(result.trails[0][1] - result.trails[0][0]).toBeLessThan(
      result.trails[0][2] - result.trails[0][1] || Infinity,
    );
  });

  it('synchronizes multiple joints using the strictest segment ratio', () => {
    const result = retimeTrajectory({
      trails: [[0, 1, 2], [0, 0.5, 1]],
      ...options({
        maxJointVelocity: [1, 0.5],
        maxProgressSpeed: 100,
        targetSpeed: 100,
        maxAcceleration: 10,
        jointLimits: [limit(), limit()],
      }),
    });

    expect(result.diagnostics.segmentDurations).toEqual([1, 1]);
    expect(result.diagnostics.restrictedPathDuration).toBe(2);
    expect(result.diagnostics.effectiveMaxProgressSpeed).toBeCloseTo(0.5);
    expect(result.trails[0].at(-1)).toBe(2);
    expect(result.trails[1].at(-1)).toBe(1);
  });

  it('never exceeds any per-joint velocity limit', () => {
    const result = retimeTrajectory({
      trails: [[0, 2, -1], [0, 0.2, 0.5]],
      ...options({
        maxJointVelocity: [1.5, 0.25],
        maxProgressSpeed: 50,
        targetSpeed: 50,
        maxAcceleration: 3,
        jointLimits: [limit(-2, 2), limit(-1, 1)],
      }),
    });

    expect(result.peakVelocity[0]).toBeLessThanOrEqual(1.5 + 1e-9);
    expect(result.peakVelocity[1]).toBeLessThanOrEqual(0.25 + 1e-9);
    expect(result.peakVelocity).toEqual(result.peakVelocities);
  });

  it('uses a smooth zero-to-zero trapezoidal progress profile', () => {
    const result = retimeTrajectory({
      trails: [[0, 1]],
      ...options({ maxProgressSpeed: 1, targetSpeed: 1, maxAcceleration: 2 }),
    });

    const dt = 1 / 50;
    const velocities = result.trails[0].slice(1).map((value, i) =>
      (value - result.trails[0][i]) / dt,
    );
    expect(velocities[0]).toBeCloseTo(0, 1);
    expect(velocities.at(-1)).toBeCloseTo(0, 1);
    const accelerations = velocities.slice(1).map((value, i) =>
      (value - velocities[i]) / dt,
    );
    expect(Math.max(...accelerations.map(Math.abs))).toBeLessThanOrEqual(2 + 1e-8);
  });

  it('emits fixed 50 Hz samples by default', () => {
    const result = retimeTrajectory({
      trails: [[0, 0.1]],
      ...options({ maxProgressSpeed: 1, targetSpeed: 1, maxAcceleration: 1, outputFrequency: undefined }),
    });

    expect(result.sampleCount).toBe(Math.round(result.duration * 50) + 1);
    expect(result.trails[0]).toHaveLength(result.sampleCount);
  });

  it('removes repeated points without changing the input', () => {
    const input = [[0, 0, 1, 1, 2]];
    const snapshot = structuredClone(input);
    const result = retimeTrajectory({ trails: input, ...options({ maxProgressSpeed: 1, targetSpeed: 1 }) });

    expect(result.diagnostics.removedDuplicatePoints).toBe(2);
    expect(result.diagnostics.retainedPathPoints).toBe(3);
    expect(input).toEqual(snapshot);
  });

  it('clamps out-of-limit samples into the safe band instead of rejecting', () => {
    // 2 exceeds the upper limit 1; the retime must clamp it to <= upper - margin.
    const result = retimeTrajectory({
      trails: [[0, 2]],
      ...options({ jointLimits: [limit(-1, 1)] }),
    });
    const safeLower = -1 + 0.05;
    const safeUpper = 1 - 0.05;
    for (const value of result.trails[0]) {
      expect(value).toBeGreaterThanOrEqual(safeLower - 1e-9);
      expect(value).toBeLessThanOrEqual(safeUpper + 1e-9);
    }
  });

  it('honors a custom limit margin', () => {
    const result = retimeTrajectory({
      trails: [[0, 2]],
      ...options({ jointLimits: [limit(-1, 1)], limitMarginRad: 0.2 }),
    });
    const safeUpper = 1 - 0.2;
    for (const value of result.trails[0]) {
      expect(value).toBeLessThanOrEqual(safeUpper + 1e-9);
    }
  });

  it('rejects NaN and dimension errors explicitly', () => {
    expect(() => retimeTrajectory({
      trails: [[0, Number.NaN]],
      ...options(),
    })).toThrow(/must be finite/);
    expect(() => retimeTrajectory({
      trails: [[0, 1], [0]],
      ...options({ maxJointVelocity: [1, 1], jointLimits: [limit(), limit()] }),
    })).toThrow(/dimension/);
  });

  it('rejects invalid numeric configuration', () => {
    expect(() => retimeTrajectory({ trails: [[0, 1]], ...options({ samplingHz: 0 }) })).toThrow(/samplingHz/);
    expect(() => retimeTrajectory({ trails: [[0, 1]], ...options({ maxAcceleration: NaN }) })).toThrow(/maxAcceleration/);
    expect(() => retimeTrajectory({ trails: [[0, 1]], ...options({ maxJointVelocity: [0] }) })).toThrow(/maxJointVelocity/);
  });
});
