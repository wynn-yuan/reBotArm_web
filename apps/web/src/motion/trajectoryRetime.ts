/**
 * Pure fixed-speed trajectory retiming.
 *
 * The input path is joint-major: trails[joint][sample]. The original path
 * is never modified. Segment time is first assigned from the strictest
 * joint velocity constraint, then a zero-to-zero trapezoidal profile retimes
 * the resulting path coordinate. Progress speed is normalized to one over
 * the whole path; therefore the velocity-constrained path itself has a
 * maximum normalized progress speed of 1 / restrictedPathDuration.
 */

export interface UrdfJointLimit {
  lower: number;
  upper: number;
}

export interface TrajectoryRetimeInput {
  trails: readonly (readonly number[])[];
  samplingHz: number;
  maxJointVelocity?: readonly number[];
  /** Plural alias kept for callers that use the common configuration name. */
  maxJointVelocities?: readonly number[];
  maxProgressSpeed: number;
  /** Normalized whole-path progress speed. */
  targetSpeed?: number;
  /** Explicit alias for targetSpeed. */
  targetProgressSpeed?: number;
  maxAcceleration: number;
  outputFrequency?: number;
  jointLimits?: readonly UrdfJointLimit[];
  /** Explicit alias for jointLimits. */
  urdfJointLimits?: readonly UrdfJointLimit[];
  duplicateTolerance?: number;
  /**
   * Safety margin (rad) applied to every joint limit during retiming. Every
   * sample is clamped into [lower+margin, upper-margin] so the arm can never
   * be commanded to (or past) a mechanical end stop even when the operator
   * recorded the joint at its limit. Defaults to LIMIT_SAFETY_MARGIN_RAD.
   */
  limitMarginRad?: number;
}

export interface TrajectoryRetimeDiagnostics {
  inputJointCount: number;
  inputSampleCount: number;
  retainedPathPoints: number;
  removedDuplicatePoints: number;
  restrictedPathDuration: number;
  segmentDurations: number[];
  requestedTargetProgressSpeed: number;
  effectiveMaxProgressSpeed: number;
  effectiveTargetProgressSpeed: number;
  progressPeakSpeed: number;
  progressPeakAcceleration: number;
  outputFrequency: number;
  warnings: string[];
}

export interface TrajectoryRetimeResult {
  trails: number[][];
  duration: number;
  peakVelocity: number[];
  /** Plural alias for consumers that treat velocity as a per-joint vector. */
  peakVelocities: number[];
  sampleCount: number;
  diagnostics: TrajectoryRetimeDiagnostics;
}

interface Profile {
  duration: number;
  accelerationTime: number;
  cruiseTime: number;
  peakSpeed: number;
  positionAt: (time: number) => number;
}

const DEFAULT_OUTPUT_FREQUENCY = 50;
const EPSILON = 1e-12;

/** Default safety margin (rad) kept from each joint end stop. 0.05 rad ≈ 2.9°. */
const LIMIT_SAFETY_MARGIN_RAD = 0.05;

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function fail(message: string): never {
  throw new RangeError(`Invalid trajectory: ${message}`);
}

function resolveArrayAlias(
  singular: readonly number[] | undefined,
  plural: readonly number[] | undefined,
  name: string,
): readonly number[] {
  if (singular && plural && singular !== plural) {
    fail(`${name} was provided more than once`);
  }
  const result = singular ?? plural;
  if (!result) fail(`${name} is required`);
  return result;
}

function resolveLimitAlias(
  limits: readonly UrdfJointLimit[] | undefined,
  urdfLimits: readonly UrdfJointLimit[] | undefined,
): readonly UrdfJointLimit[] {
  if (limits && urdfLimits && limits !== urdfLimits) {
    fail('joint limits were provided more than once');
  }
  const result = limits ?? urdfLimits;
  if (!result) fail('joint limits are required');
  return result;
}

/**
 * Clamp every sample into [lower+margin, upper-margin] before retiming.
 *
 * The operator may have recorded a joint pressed against a mechanical end
 * stop; without this the generated trajectory would either fail validation or
 * drive the arm to the physical limit. Clamping keeps at least ``margin`` of
 * headroom from every end stop so the arm is never commanded to (or past) it.
 * The original input trails are never mutated.
 */
function clampToSafeLimits(
  trails: readonly (readonly number[])[],
  limits: readonly UrdfJointLimit[],
  margin: number,
): number[][] {
  return trails.map((trail, joint) => {
    const lowerLimit = limits[joint].lower;
    const upperLimit = limits[joint].upper;
    const midpoint = (lowerLimit + upperLimit) / 2;
    // If the limit span is narrower than 2*margin, collapse to the midpoint
    // rather than producing an inverted (lo > hi) clamp window.
    const lo = Math.min(lowerLimit + margin, midpoint);
    const hi = Math.max(upperLimit - margin, midpoint);
    return trail.map((value) => Math.min(hi, Math.max(lo, value)));
  });
}

function validateInput(input: TrajectoryRetimeInput): {
  maxJointVelocity: readonly number[];
  jointLimits: readonly UrdfJointLimit[];
  outputFrequency: number;
  targetSpeed: number;
  duplicateTolerance: number;
} {
  if (!input || !Array.isArray(input.trails)) fail('trails must be an array');
  const jointCount = input.trails.length;
  if (jointCount === 0) fail('trails must contain at least one joint');
  const sampleCount = input.trails[0]?.length ?? 0;
  if (sampleCount === 0) fail('trails must contain at least one sample');

  if (!isFiniteNumber(input.samplingHz) || input.samplingHz <= 0) {
    fail('samplingHz must be finite and greater than zero');
  }
  if (!isFiniteNumber(input.maxProgressSpeed) || input.maxProgressSpeed <= 0) {
    fail('maxProgressSpeed must be finite and greater than zero');
  }
  if (!isFiniteNumber(input.maxAcceleration) || input.maxAcceleration <= 0) {
    fail('maxAcceleration must be finite and greater than zero');
  }

  const outputFrequency = input.outputFrequency ?? DEFAULT_OUTPUT_FREQUENCY;
  if (!isFiniteNumber(outputFrequency) || outputFrequency <= 0) {
    fail('outputFrequency must be finite and greater than zero');
  }

  const maxJointVelocity = resolveArrayAlias(
    input.maxJointVelocity,
    input.maxJointVelocities,
    'maxJointVelocity',
  );
  if (maxJointVelocity.length !== jointCount) {
    fail('maxJointVelocity dimension must match joint count');
  }
  maxJointVelocity.forEach((velocity, joint) => {
    if (!isFiniteNumber(velocity) || velocity <= 0) {
      fail(`maxJointVelocity[${joint}] must be finite and greater than zero`);
    }
  });

  const jointLimits = resolveLimitAlias(input.jointLimits, input.urdfJointLimits);
  if (jointLimits.length !== jointCount) {
    fail('joint limits dimension must match joint count');
  }
  jointLimits.forEach((limit, joint) => {
    if (
      !limit ||
      !isFiniteNumber(limit.lower) ||
      !isFiniteNumber(limit.upper) ||
      limit.lower > limit.upper
    ) {
      fail(`jointLimits[${joint}] must have finite lower <= upper`);
    }
  });

  input.trails.forEach((trail, joint) => {
    if (!Array.isArray(trail) || trail.length !== sampleCount) {
      fail(`trails[${joint}] dimension must match the first trail`);
    }
    trail.forEach((value, sample) => {
      if (!isFiniteNumber(value)) fail(`trails[${joint}][${sample}] must be finite`);
      const limit = jointLimits[joint];
      if (value < limit.lower || value > limit.upper) {
        fail(`trails[${joint}][${sample}] is outside its URDF joint limit`);
      }
    });
  });

  const targetSpeed = input.targetProgressSpeed ?? input.targetSpeed ?? input.maxProgressSpeed;
  if (!isFiniteNumber(targetSpeed) || targetSpeed <= 0) {
    fail('targetSpeed must be finite and greater than zero');
  }
  if (
    input.targetProgressSpeed !== undefined &&
    input.targetSpeed !== undefined &&
    input.targetProgressSpeed !== input.targetSpeed
  ) {
    fail('targetSpeed and targetProgressSpeed disagree');
  }

  const duplicateTolerance = input.duplicateTolerance ?? EPSILON;
  if (!isFiniteNumber(duplicateTolerance) || duplicateTolerance < 0) {
    fail('duplicateTolerance must be finite and non-negative');
  }

  return { maxJointVelocity, jointLimits, outputFrequency, targetSpeed, duplicateTolerance };
}

function samePoint(a: number[], b: readonly number[], tolerance: number): boolean {
  for (let joint = 0; joint < a.length; joint += 1) {
    if (Math.abs(a[joint] - b[joint]) > tolerance) return false;
  }
  return true;
}

function buildProfile(duration: number, maxSpeed: number, acceleration: number): Profile {
  if (duration <= 0) {
    return {
      duration: 0,
      accelerationTime: 0,
      cruiseTime: 0,
      peakSpeed: 0,
      positionAt: () => 0,
    };
  }

  // For a symmetric zero-to-zero profile, distance is
  // a * ta * (duration - ta). The smaller root preserves the longest
  // possible cruise phase while respecting the acceleration limit.
  const discriminant = Math.max(0, duration * duration - 4 / acceleration);
  const accelerationTime = Math.min(
    duration / 2,
    (duration - Math.sqrt(discriminant)) / 2,
    maxSpeed / acceleration,
  );
  const peakSpeed = acceleration * accelerationTime;
  const cruiseTime = Math.max(0, duration - 2 * accelerationTime);
  const accelerationDistance = 0.5 * acceleration * accelerationTime ** 2;

  const positionAt = (time: number): number => {
    const t = Math.max(0, Math.min(duration, time));
    let position: number;
    if (t <= accelerationTime) {
      position = 0.5 * acceleration * t ** 2;
    } else if (t <= accelerationTime + cruiseTime) {
      position = accelerationDistance + peakSpeed * (t - accelerationTime);
    } else {
      const remaining = duration - t;
      position = 1 - 0.5 * acceleration * remaining ** 2;
    }
    return Math.max(0, Math.min(1, position));
  };

  return { duration, accelerationTime, cruiseTime, peakSpeed, positionAt };
}

function samplePath(
  path: number[][],
  segmentDurations: number[],
  restrictedDuration: number,
  profile: Profile,
  outputFrequency: number,
): number[][] {
  const sampleCount = Math.max(2, Math.ceil(profile.duration * outputFrequency - EPSILON) + 1);
  const dt = 1 / outputFrequency;
  const output = Array.from(
    { length: path[0].length },
    () => new Array<number>(sampleCount),
  );
  const cumulative: number[] = [0];
  for (const segmentDuration of segmentDurations) {
    cumulative.push(cumulative[cumulative.length - 1] + segmentDuration);
  }

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const time = sample * dt;
    const progress = profile.positionAt(time);
    const pathTime = progress * restrictedDuration;
    let segment = 0;
    while (segment < segmentDurations.length - 1 && pathTime > cumulative[segment + 1]) {
      segment += 1;
    }
    const segmentStart = cumulative[segment];
    const segmentLength = segmentDurations[segment];
    const alpha = Math.max(0, Math.min(1, (pathTime - segmentStart) / segmentLength));
    for (let joint = 0; joint < path[0].length; joint += 1) {
      output[joint][sample] = path[segment][joint] +
        (path[segment + 1][joint] - path[segment][joint]) * alpha;
    }
  }
  return output;
}

function peakVelocities(trails: number[][], duration: number, sampleCount: number): number[] {
  if (sampleCount < 2 || duration <= 0) return trails.map(() => 0);
  const dt = duration / (sampleCount - 1);
  return trails.map((trail) => {
    let peak = 0;
    for (let sample = 1; sample < trail.length; sample += 1) {
      peak = Math.max(peak, Math.abs(trail[sample] - trail[sample - 1]) / dt);
    }
    return peak;
  });
}

export function retimeTrajectory(input: TrajectoryRetimeInput): TrajectoryRetimeResult {
  // Clamp every recorded sample into the per-joint safe band before any
  // validation or path building, so a recording that reached a mechanical end
  // stop is corrected instead of rejected.
  const limits = resolveLimitAlias(input.jointLimits, input.urdfJointLimits);
  const margin = input.limitMarginRad ?? LIMIT_SAFETY_MARGIN_RAD;
  const clamped = clampToSafeLimits(input.trails, limits, margin);
  const { maxJointVelocity, jointLimits, outputFrequency, targetSpeed, duplicateTolerance } =
    validateInput({ ...input, trails: clamped });
  const inputJointCount = input.trails.length;
  const inputSampleCount = input.trails[0].length;
  const path: number[][] = [clamped.map((trail) => trail[0])];
  let removedDuplicatePoints = 0;

  for (let sample = 1; sample < inputSampleCount; sample += 1) {
    const point = clamped.map((trail) => trail[sample]);
    if (samePoint(path[path.length - 1], point, duplicateTolerance)) {
      removedDuplicatePoints += 1;
    } else {
      path.push(point);
    }
  }

  const warnings: string[] = [];
  if (removedDuplicatePoints > 0) {
    warnings.push(`removed ${removedDuplicatePoints} duplicate path point(s)`);
  }

  if (path.length === 1) {
    const stationary = path[0].map((value) => [value]);
    const diagnostics: TrajectoryRetimeDiagnostics = {
      inputJointCount,
      inputSampleCount,
      retainedPathPoints: 1,
      removedDuplicatePoints,
      restrictedPathDuration: 0,
      segmentDurations: [],
      requestedTargetProgressSpeed: targetSpeed,
      effectiveMaxProgressSpeed: 0,
      effectiveTargetProgressSpeed: 0,
      progressPeakSpeed: 0,
      progressPeakAcceleration: 0,
      outputFrequency,
      warnings,
    };
    return {
      trails: stationary,
      duration: 0,
      peakVelocity: input.trails.map(() => 0),
      peakVelocities: input.trails.map(() => 0),
      sampleCount: 1,
      diagnostics,
    };
  }

  const segmentDurations = path.slice(1).map((point, segment) => {
    let duration = 0;
    for (let joint = 0; joint < inputJointCount; joint += 1) {
      duration = Math.max(
        duration,
        Math.abs(point[joint] - path[segment][joint]) / maxJointVelocity[joint],
      );
    }
    if (!(duration > 0)) fail('path contains a zero-length segment after duplicate removal');
    return duration;
  });
  const restrictedPathDuration = segmentDurations.reduce((sum, duration) => sum + duration, 0);
  const pathProgressSpeedLimit = 1 / restrictedPathDuration;
  const effectiveMaxProgressSpeed = Math.min(input.maxProgressSpeed, pathProgressSpeedLimit);
  const effectiveTargetProgressSpeed = Math.min(targetSpeed, effectiveMaxProgressSpeed);
  if (input.maxProgressSpeed > pathProgressSpeedLimit + EPSILON) {
    warnings.push('overall progress speed was capped by the joint velocity limits');
  }
  if (targetSpeed > input.maxProgressSpeed + EPSILON) {
    warnings.push('target progress speed was capped by maxProgressSpeed');
  }

  const acceleration = input.maxAcceleration;
  const minimumDuration = effectiveTargetProgressSpeed ** 2 / acceleration >= 1
    ? 2 / Math.sqrt(acceleration)
    : 1 / effectiveTargetProgressSpeed + effectiveTargetProgressSpeed / acceleration;
  const sampleCount = Math.max(2, Math.ceil(minimumDuration * outputFrequency - EPSILON) + 1);
  const duration = (sampleCount - 1) / outputFrequency;
  const profile = buildProfile(duration, effectiveTargetProgressSpeed, acceleration);
  const trails = samplePath(
    path,
    segmentDurations,
    restrictedPathDuration,
    profile,
    outputFrequency,
  );
  const peakVelocity = peakVelocities(trails, duration, sampleCount);

  // Validate the generated path too. This catches both implementation errors
  // and accidental future changes to the interpolation logic.
  trails.forEach((trail, joint) => {
    trail.forEach((value) => {
      if (value < jointLimits[joint].lower - EPSILON || value > jointLimits[joint].upper + EPSILON) {
        fail(`generated trail[${joint}] exceeds its URDF joint limit`);
      }
    });
    if (peakVelocity[joint] > maxJointVelocity[joint] + 1e-9) {
      fail(`generated trail[${joint}] exceeds its maximum velocity`);
    }
  });

  const diagnostics: TrajectoryRetimeDiagnostics = {
    inputJointCount,
    inputSampleCount,
    retainedPathPoints: path.length,
    removedDuplicatePoints,
    restrictedPathDuration,
    segmentDurations,
    requestedTargetProgressSpeed: targetSpeed,
    effectiveMaxProgressSpeed,
    effectiveTargetProgressSpeed,
    progressPeakSpeed: profile.peakSpeed,
    progressPeakAcceleration: acceleration,
    outputFrequency,
    warnings,
  };
  return {
    trails,
    duration,
    peakVelocity,
    peakVelocities: peakVelocity,
    sampleCount,
    diagnostics,
  };
}

/** Descriptive alias for callers that want to make the fixed-speed contract explicit. */
export const retimeFixedSpeedTrajectory = retimeTrajectory;
