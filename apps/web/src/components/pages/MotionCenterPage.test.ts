import { describe, expect, it } from 'vitest';
import {
  ACTION_JOINT_LIMITS,
  canStartOfflineRecording,
  collectTelemetryPositions,
  createProcessedAction,
  diagnoseJointLimits,
} from './MotionCenterPage';
import type { LiveJoint, RecordedAction } from '../../types';

function liveJoints(positions: Array<number | null>): LiveJoint[] {
  return positions.map((position, index) => ({
    id: index + 1,
    position,
    velocity: 0,
    torque: 0,
    tempMos: 25,
    tempRotor: 25,
    statusCode: 0,
    freshness: 'fresh',
  }));
}

const validPositions = [0, 0.2, 0.3, 0, 0, 0, 1];

describe('MotionCenter offline recording gates', () => {
  it('requires connection, active zero torque, a fresh seven-joint frame, and operator confirmation', () => {
    expect(collectTelemetryPositions(liveJoints(validPositions))).toEqual(validPositions);
    expect(collectTelemetryPositions(liveJoints([...validPositions.slice(0, 6), null]))).toBeNull();

    const base = {
      connected: true,
      zeroTorqueActive: true,
      emergency: false,
      safetyActive: false,
      mode: 'idle' as const,
      actionName: '抓取',
      positions: validPositions,
      operatorConfirmed: true,
    };
    expect(canStartOfflineRecording(base)).toBe(true);
    expect(canStartOfflineRecording({ ...base, zeroTorqueActive: false })).toBe(false);
    expect(canStartOfflineRecording({ ...base, positions: null })).toBe(false);
    expect(canStartOfflineRecording({ ...base, operatorConfirmed: false })).toBe(false);
  });
});

describe('MotionCenter offline action versions', () => {
  it('reports limit diagnostics without mutating the raw trails', () => {
    const rawTrails = validPositions.map((position) => [position, position + 0.01]);
    const before = rawTrails.map((trail) => [...trail]);
    const diagnostics = diagnoseJointLimits(rawTrails);
    expect(diagnostics).toHaveLength(7);
    expect(diagnostics.every((item) => item.inLimit)).toBe(true);
    expect(rawTrails).toEqual(before);
    expect(ACTION_JOINT_LIMITS[6]).toEqual({ lower: 0, upper: 3 });
  });

  it('creates a separately identified processed version linked to raw', () => {
    const raw: RecordedAction = {
      id: 'raw-1',
      name: '抓取',
      createdAt: 1,
      durationMs: 1000,
      sampleCount: 2,
      samplingHz: 50,
      jointCount: 7,
      trails: validPositions.map((position) => [position, position]),
      version: 'raw',
    };
    const processed = createProcessedAction(raw, {
      trails: raw.trails.map((trail) => [...trail]),
      duration: 0.5,
      peakVelocity: [0, 0, 0, 0, 0, 0, 0],
      peakVelocities: [0, 0, 0, 0, 0, 0, 0],
      sampleCount: 2,
      diagnostics: {
        inputJointCount: 7,
        inputSampleCount: 2,
        retainedPathPoints: 1,
        removedDuplicatePoints: 1,
        restrictedPathDuration: 0,
        segmentDurations: [],
        requestedTargetProgressSpeed: 1,
        effectiveMaxProgressSpeed: 0,
        effectiveTargetProgressSpeed: 0,
        progressPeakSpeed: 0,
        progressPeakAcceleration: 0,
        outputFrequency: 50,
        warnings: [],
      },
    }, { maxJointVelocity: [1, 1, 1, 1, 1, 1, 1], maxProgressSpeed: 1, maxAcceleration: 1 }, 10);

    expect(processed.version).toBe('processed');
    expect(processed.rawActionId).toBe(raw.id);
    expect(processed.id).not.toBe(raw.id);
    expect(raw.trails).toEqual(validPositions.map((position) => [position, position]));
  });
});
