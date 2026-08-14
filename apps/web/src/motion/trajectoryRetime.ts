/**
 * Trajectory retiming: raw drag recording → processed 100 Hz trajectory.
 *
 * Processing modes:
 *   1. smoothingWindow > 0 → 抗尖峰滤波 + 形状控制点 + 连续 PCHIP 平滑
 *   2. keypointEpsilon > 0 → RDP 顶点提取 + 分段五次最小加加速度插值
 *   3. 其他 → 兼容旧版的全路径统一重定时
 *
 * 新增模式 (retimeWithTimestamps):
 *   retimeWithTimestamps 基于时间戳重采样，保留原始录制节奏。
 */

import type { TimedSample } from '../types';

export interface UrdfJointLimit {
  lower: number;
  upper: number;
}

export interface TrajectoryRetimeInput {
  trails: readonly (readonly number[])[];
  samplingHz: number;
  maxJointVelocity?: readonly number[];
  maxJointVelocities?: readonly number[];
  maxProgressSpeed: number;
  targetSpeed?: number;
  targetProgressSpeed?: number;
  maxAcceleration: number;
  outputFrequency?: number;
  jointLimits?: readonly UrdfJointLimit[];
  urdfJointLimits?: readonly UrdfJointLimit[];
  duplicateTolerance?: number;
  limitMarginRad?: number;
  overallSpeedScale?: number;
  smoothing?: boolean;
  keypointEpsilon?: number;
  /** 原始采样时间（秒）；缺省时按 samplingHz 推算。 */
  sampleTimes?: readonly number[];
  /** 平滑后是否尽量保留示教时各顶点之间的时间。默认 true。 */
  preserveRecordedTiming?: boolean;
  /** 是否自动在动作首尾补全零位。 */
  returnHome?: boolean;
  /** 回零关节位置，默认全部为 0。 */
  homePosition?: readonly number[];
  /** 顶点数量上限；超过时自动提高简化容差。 */
  maxKeypoints?: number;
  /** 连续轨迹抗抖窗口（奇数帧）；设置后优先于顶点模式。 */
  smoothingWindow?: number;
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
  keypointIndices?: number[];
  smoothingTolerance?: number;
  addedHomePoints?: number;
  peakAccelerations?: number[];
  smoothingWindowSamples?: number;
}

export interface TrajectoryRetimeResult {
  trails: number[][];
  duration: number;
  peakVelocity: number[];
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

const DEFAULT_OUTPUT_FREQUENCY = 100;
const EPSILON = 1e-12;
const LIMIT_SAFETY_MARGIN_RAD = 0.05;
const SG5_KERNEL: readonly number[] = [-3 / 35, 12 / 35, 17 / 35, 12 / 35, -3 / 35];
const MINIMUM_JERK_PEAK_VELOCITY = 1.875;
const MINIMUM_JERK_PEAK_ACCELERATION = 5.773502692;
const DEFAULT_MAX_KEYPOINTS = 48;
const MAX_OUTPUT_SAMPLES = 250_000;

// ── helpers ────────────────────────────────────────────────────────────

function isFiniteNumber(value: number): boolean { return Number.isFinite(value); }

function fail(message: string): never { throw new RangeError(`Invalid trajectory: ${message}`); }

function clampToSafeLimits(
  trails: readonly (readonly number[])[], limits: readonly UrdfJointLimit[], margin: number,
): number[][] {
  return trails.map((trail, joint) => {
    const lo = limits[joint].lower + margin;
    const hi = limits[joint].upper - margin;
    const mid = (limits[joint].lower + limits[joint].upper) / 2;
    const safeLo = Math.min(lo, mid);
    const safeHi = Math.max(hi, mid);
    return trail.map((v) => Math.min(safeHi, Math.max(safeLo, v)));
  });
}

function smoothTrail(trail: readonly number[]): number[] {
  if (trail.length < SG5_KERNEL.length) return [...trail];
  return trail.map((_, index) => {
    let acc = 0;
    for (let j = 0; j < SG5_KERNEL.length; j += 1) {
      const src = index + (j - 2);
      const v = src >= 0 && src < trail.length ? trail[src] : trail[index];
      acc += v * SG5_KERNEL[j];
    }
    return acc;
  });
}

function resolveArrayAlias(
  s: readonly number[] | undefined, p: readonly number[] | undefined, name: string,
): readonly number[] {
  if (s && p && s !== p) fail(`${name} was provided more than once`);
  const r = s ?? p;
  if (!r) fail(`${name} is required`);
  return r;
}

function resolveLimitAlias(
  l: readonly UrdfJointLimit[] | undefined, u: readonly UrdfJointLimit[] | undefined,
): readonly UrdfJointLimit[] {
  if (l && u && l !== u) fail('joint limits were provided more than once');
  const r = l ?? u;
  if (!r) fail('joint limits are required');
  return r;
}

function validateInput(input: TrajectoryRetimeInput) {
  if (!input || !Array.isArray(input.trails)) fail('trails must be an array');
  const jc = input.trails.length;
  if (jc === 0) fail('trails must contain at least one joint');
  const sc = input.trails[0]?.length ?? 0;
  if (sc === 0) fail('trails must contain at least one sample');
  if (!isFiniteNumber(input.samplingHz) || input.samplingHz <= 0) fail('samplingHz');
  if (!isFiniteNumber(input.maxProgressSpeed) || input.maxProgressSpeed <= 0) fail('maxProgressSpeed');
  if (!isFiniteNumber(input.maxAcceleration) || input.maxAcceleration <= 0) fail('maxAcceleration');
  const of = input.outputFrequency ?? DEFAULT_OUTPUT_FREQUENCY;
  if (!isFiniteNumber(of) || of <= 0) fail('outputFrequency');
  const mjv = resolveArrayAlias(input.maxJointVelocity, input.maxJointVelocities, 'maxJointVelocity');
  if (mjv.length !== jc) fail('maxJointVelocity');
  mjv.forEach((v, j) => { if (!isFiniteNumber(v) || v <= 0) fail(`maxJointVelocity[${j}]`); });
  const jl = resolveLimitAlias(input.jointLimits, input.urdfJointLimits);
  if (jl.length !== jc) fail('joint limits');
  jl.forEach((l, j) => { if (!l || !isFiniteNumber(l.lower) || !isFiniteNumber(l.upper) || l.lower > l.upper) fail(`jointLimits[${j}]`); });
  input.trails.forEach((trail, j) => {
    if (!Array.isArray(trail) || trail.length !== sc) fail(`trails[${j}] dimension must match the first trail`);
    trail.forEach((v, s) => { if (!isFiniteNumber(v)) fail(`trails[${j}][${s}] must be finite`); });
  });
  const ts = input.targetProgressSpeed ?? input.targetSpeed ?? input.maxProgressSpeed;
  if (!isFiniteNumber(ts) || ts <= 0) fail('targetSpeed');
  const dup = input.duplicateTolerance ?? EPSILON;
  if (!isFiniteNumber(dup) || dup < 0) fail('duplicateTolerance');
  return { maxJointVelocity: mjv, jointLimits: jl, outputFrequency: of, targetSpeed: ts, duplicateTolerance: dup };
}

function samePoint(a: number[], b: readonly number[], tol: number): boolean {
  for (let j = 0; j < a.length; j += 1) if (Math.abs(a[j] - b[j]) > tol) return false;
  return true;
}

function buildProfile(duration: number, maxSpeed: number, acc: number): Profile {
  if (duration <= 0) return { duration: 0, accelerationTime: 0, cruiseTime: 0, peakSpeed: 0, positionAt: () => 0 };
  const disc = Math.max(0, duration * duration - 4 / acc);
  const at = Math.min(duration / 2, (duration - Math.sqrt(disc)) / 2, maxSpeed / acc);
  const ps = acc * at;
  const ct = Math.max(0, duration - 2 * at);
  const ad = 0.5 * acc * at * at;
  const pos = (time: number) => {
    const t = Math.max(0, Math.min(duration, time));
    if (t <= at) return 0.5 * acc * t * t;
    if (t <= at + ct) return ad + ps * (t - at);
    const r = duration - t;
    return 1 - 0.5 * acc * r * r;
  };
  return { duration, accelerationTime: at, cruiseTime: ct, peakSpeed: ps, positionAt: pos };
}

function samplePath(
  path: number[][], seg: number[], restricted: number, profile: Profile, of: number,
): number[][] {
  const sc = Math.max(2, Math.ceil(profile.duration * of - EPSILON) + 1);
  const dt = 1 / of;
  const out = Array.from({ length: path[0].length }, () => new Array<number>(sc));
  const cum: number[] = [0];
  for (const s of seg) cum.push(cum[cum.length - 1] + s);
  for (let s = 0; s < sc; s += 1) {
    const t = s * dt;
    const pt = profile.positionAt(t) * restricted;
    let segIdx = 0;
    while (segIdx < seg.length - 1 && pt > cum[segIdx + 1]) segIdx += 1;
    const ss = cum[segIdx];
    const sl = seg[segIdx];
    const alpha = sl > 0 ? Math.max(0, Math.min(1, (pt - ss) / sl)) : 0;
    for (let j = 0; j < path[0].length; j += 1) out[j][s] = path[segIdx][j] + (path[segIdx + 1][j] - path[segIdx][j]) * alpha;
  }
  return out;
}

function peakVelocities(trails: number[][], duration: number, sc: number): number[] {
  if (sc < 2 || duration <= 0) return trails.map(() => 0);
  const dt = duration / (sc - 1);
  return trails.map((trail) => {
    let peak = 0;
    for (let s = 1; s < trail.length; s += 1) peak = Math.max(peak, Math.abs(trail[s] - trail[s - 1]) / dt);
    return peak;
  });
}

// ── Vertex extraction + minimum-jerk smoothing ──────────────────────────

interface Keyframe {
  point: number[];
  sourceIndex: number | null;
}

interface VertexSmoothingResult {
  trails: number[][];
  duration: number;
  segmentDurations: number[];
  keypointIndices: number[];
  effectiveTolerance: number;
  addedHomePoints: number;
}

function pointSegmentDistance(point: readonly number[], start: readonly number[], end: readonly number[]): number {
  let lengthSquared = 0;
  let projection = 0;
  for (let joint = 0; joint < point.length; joint += 1) {
    const delta = end[joint] - start[joint];
    lengthSquared += delta * delta;
    projection += (point[joint] - start[joint]) * delta;
  }
  const alpha = lengthSquared > EPSILON ? Math.max(0, Math.min(1, projection / lengthSquared)) : 0;
  let distanceSquared = 0;
  for (let joint = 0; joint < point.length; joint += 1) {
    const delta = point[joint] - (start[joint] + (end[joint] - start[joint]) * alpha);
    distanceSquared += delta * delta;
  }
  return Math.sqrt(distanceSquared);
}

/** Ramer-Douglas-Peucker in joint space. Endpoints are always retained. */
export function extractKeypointIndices(points: readonly (readonly number[])[], epsilon: number): number[] {
  if (!Number.isFinite(epsilon) || epsilon <= 0) fail('keypointEpsilon must be greater than zero');
  if (points.length <= 2) return points.map((_, index) => index);
  const retained = new Set<number>([0, points.length - 1]);
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end <= start + 1) continue;
    let farthest = -1;
    let maximumDistance = epsilon;
    for (let index = start + 1; index < end; index += 1) {
      const distance = pointSegmentDistance(points[index], points[start], points[end]);
      if (distance > maximumDistance) {
        maximumDistance = distance;
        farthest = index;
      }
    }
    if (farthest >= 0) {
      retained.add(farthest);
      stack.push([start, farthest], [farthest, end]);
    }
  }
  return [...retained].sort((a, b) => a - b);
}

function extractBoundedKeypoints(
  points: readonly (readonly number[])[], epsilon: number, maxKeypoints: number,
): { indices: number[]; effectiveTolerance: number } {
  let effectiveTolerance = epsilon;
  let indices = extractKeypointIndices(points, effectiveTolerance);
  for (let attempt = 0; indices.length > maxKeypoints && attempt < 20; attempt += 1) {
    effectiveTolerance *= 1.35;
    indices = extractKeypointIndices(points, effectiveTolerance);
  }
  return { indices, effectiveTolerance };
}

function minimumJerk(progress: number): number {
  const u = Math.max(0, Math.min(1, progress));
  return 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5;
}

function jointDistance(a: readonly number[], b: readonly number[]): number {
  let squared = 0;
  for (let joint = 0; joint < a.length; joint += 1) squared += (b[joint] - a[joint]) ** 2;
  return Math.sqrt(squared);
}

function recordedSegmentDuration(
  start: number | null, end: number | null, sampleTimes: readonly number[] | undefined, inputHz: number,
): number {
  if (start === null || end === null || end <= start) return 0;
  if (sampleTimes) return Math.max(0, sampleTimes[end] - sampleTimes[start]);
  return (end - start) / inputHz;
}

function validateSampleTimes(sampleTimes: readonly number[] | undefined, sampleCount: number): void {
  if (!sampleTimes) return;
  if (sampleTimes.length !== sampleCount) fail('sampleTimes dimension must match the trajectory');
  sampleTimes.forEach((time, index) => {
    if (!Number.isFinite(time)) fail(`sampleTimes[${index}] must be finite`);
    if (index > 0 && time < sampleTimes[index - 1]) fail('sampleTimes must be monotonic');
  });
}

function smoothVertices(
  detectionTrails: readonly number[][],
  vertexTrails: readonly number[][],
  input: TrajectoryRetimeInput,
  maxVelocity: readonly number[],
  jointLimits: readonly UrdfJointLimit[],
  outputFrequency: number,
  targetSpeed: number,
  speedScale: number,
): VertexSmoothingResult {
  const sampleCount = detectionTrails[0].length;
  const jointCount = detectionTrails.length;
  const epsilon = input.keypointEpsilon ?? 0;
  const maxKeypoints = input.maxKeypoints ?? DEFAULT_MAX_KEYPOINTS;
  if (!Number.isInteger(maxKeypoints) || maxKeypoints < 2) fail('maxKeypoints must be an integer greater than one');
  validateSampleTimes(input.sampleTimes, sampleCount);

  const detectionPoints = Array.from({ length: sampleCount }, (_, sample) =>
    detectionTrails.map((trail) => trail[sample]));
  const { indices, effectiveTolerance } = extractBoundedKeypoints(detectionPoints, epsilon, maxKeypoints);
  const keyframes: Keyframe[] = indices.map((sourceIndex) => ({
    point: vertexTrails.map((trail) => trail[sourceIndex]),
    sourceIndex,
  }));

  let addedHomePoints = 0;
  if (input.returnHome) {
    const home = input.homePosition ? [...input.homePosition] : Array.from({ length: jointCount }, () => 0);
    if (home.length !== jointCount || home.some((value) => !Number.isFinite(value))) fail('homePosition');
    home.forEach((value, joint) => {
      if (value < jointLimits[joint].lower || value > jointLimits[joint].upper) fail(`homePosition[${joint}] exceeds its URDF joint limit`);
    });
    if (jointDistance(home, keyframes[0].point) > EPSILON) {
      keyframes.unshift({ point: [...home], sourceIndex: null });
      addedHomePoints += 1;
    } else {
      keyframes[0] = { point: [...home], sourceIndex: keyframes[0].sourceIndex };
    }
    if (jointDistance(home, keyframes[keyframes.length - 1].point) > EPSILON) {
      keyframes.push({ point: [...home], sourceIndex: null });
      addedHomePoints += 1;
    } else {
      keyframes[keyframes.length - 1] = { point: [...home], sourceIndex: keyframes[keyframes.length - 1].sourceIndex };
    }
  }

  if (keyframes.length === 1) {
    return {
      trails: keyframes[0].point.map((value) => [value]),
      duration: 0,
      segmentDurations: [],
      keypointIndices: indices,
      effectiveTolerance,
      addedHomePoints,
    };
  }

  const segmentMetrics = keyframes.slice(1).map((frame, index) => {
    let metric = 0;
    for (let joint = 0; joint < jointCount; joint += 1) {
      metric = Math.max(metric, Math.abs(frame.point[joint] - keyframes[index].point[joint]) / maxVelocity[joint]);
    }
    return metric;
  });
  const totalMetric = segmentMetrics.reduce((sum, value) => sum + value, 0);
  const requestedTotalDuration = 1 / (targetSpeed * speedScale);
  const preserveTiming = input.preserveRecordedTiming !== false;
  const segmentDurations = keyframes.slice(1).map((frame, index) => {
    const start = keyframes[index];
    let maxDelta = 0;
    for (let joint = 0; joint < jointCount; joint += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(frame.point[joint] - start.point[joint]));
    }
    const velocityDuration = MINIMUM_JERK_PEAK_VELOCITY * segmentMetrics[index];
    const accelerationDuration = Math.sqrt(MINIMUM_JERK_PEAK_ACCELERATION * maxDelta / input.maxAcceleration);
    const recordedDuration = recordedSegmentDuration(
      start.sourceIndex, frame.sourceIndex, input.sampleTimes, input.samplingHz,
    ) / speedScale;
    const standardizedDuration = totalMetric > EPSILON
      ? requestedTotalDuration * segmentMetrics[index] / totalMetric
      : 0;
    const requestedDuration = preserveTiming && recordedDuration > 0 ? recordedDuration : standardizedDuration;
    const intervals = Math.max(1, Math.ceil(Math.max(
      1 / outputFrequency,
      requestedDuration,
      velocityDuration,
      accelerationDuration,
    ) * outputFrequency - EPSILON));
    return intervals / outputFrequency;
  });

  const outputSampleCount = 1 + segmentDurations.reduce(
    (sum, duration) => sum + Math.round(duration * outputFrequency), 0,
  );
  if (outputSampleCount > MAX_OUTPUT_SAMPLES) fail(`generated trajectory exceeds ${MAX_OUTPUT_SAMPLES} samples`);
  const trails = Array.from({ length: jointCount }, () => new Array<number>(outputSampleCount));
  let outputIndex = 0;
  keyframes[0].point.forEach((value, joint) => { trails[joint][0] = value; });
  segmentDurations.forEach((duration, segment) => {
    const intervals = Math.round(duration * outputFrequency);
    const start = keyframes[segment].point;
    const end = keyframes[segment + 1].point;
    for (let step = 1; step <= intervals; step += 1) {
      const blend = minimumJerk(step / intervals);
      outputIndex += 1;
      for (let joint = 0; joint < jointCount; joint += 1) {
        trails[joint][outputIndex] = start[joint] + (end[joint] - start[joint]) * blend;
      }
    }
  });
  keyframes[keyframes.length - 1].point.forEach((value, joint) => {
    trails[joint][trails[joint].length - 1] = value;
  });
  return {
    trails,
    duration: (outputSampleCount - 1) / outputFrequency,
    segmentDurations,
    keypointIndices: indices,
    effectiveTolerance,
    addedHomePoints,
  };
}

interface ContinuousSmoothingResult {
  trails: number[][];
  duration: number;
  addedHomePoints: number;
  peakVelocities: number[];
  peakAccelerations: number[];
  smoothingWindow: number;
  controlPointCount: number;
  effectiveTolerance: number;
}

function normalizeSmoothingWindow(value: number, sampleCount: number): number {
  if (!Number.isInteger(value) || value < 3) fail('smoothingWindow must be an integer greater than or equal to 3');
  let window = value % 2 === 0 ? value + 1 : value;
  const largestOdd = sampleCount % 2 === 0 ? sampleCount - 1 : sampleCount;
  window = Math.min(window, Math.max(1, largestOdd));
  return window;
}

function medianFilterTrail(trail: readonly number[], radius: number): number[] {
  if (radius <= 0 || trail.length < 3) return [...trail];
  return trail.map((_, index) => {
    const values: number[] = [];
    for (let offset = -radius; offset <= radius; offset += 1) {
      values.push(trail[Math.max(0, Math.min(trail.length - 1, index + offset))]);
    }
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  });
}

function gaussianSmoothTrail(trail: readonly number[], window: number): number[] {
  if (window < 3 || trail.length < 3) return [...trail];
  const radius = Math.floor(window / 2);
  const sigma = Math.max(1, window / 4);
  const weights = Array.from({ length: window }, (_, index) => {
    const offset = index - radius;
    return Math.exp(-(offset * offset) / (2 * sigma * sigma));
  });
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  const result = trail.map((_, index) => {
    let value = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const source = Math.max(0, Math.min(trail.length - 1, index + offset));
      value += trail[source] * weights[offset + radius];
    }
    return value / weightSum;
  });
  // The operator intentionally sets the initial and final poses. Keep them exact.
  result[0] = trail[0];
  result[result.length - 1] = trail[trail.length - 1];
  return result;
}

function robustSmoothTrails(trails: readonly number[][], window: number): number[][] {
  const medianRadius = Math.max(1, Math.floor(window / 6));
  return trails.map((trail) => gaussianSmoothTrail(medianFilterTrail(trail, medianRadius), window));
}

function sourceTimeline(
  sampleTimes: readonly number[] | undefined, sampleCount: number, samplingHz: number,
): number[] {
  validateSampleTimes(sampleTimes, sampleCount);
  if (!sampleTimes) return Array.from({ length: sampleCount }, (_, index) => index / samplingHz);
  const start = sampleTimes[0];
  const normalized = sampleTimes.map((time) => time - start);
  if (normalized[normalized.length - 1] <= 0) {
    return Array.from({ length: sampleCount }, (_, index) => index / samplingHz);
  }
  return normalized;
}

function pchipTangents(times: readonly number[], values: readonly number[]): number[] {
  const count = values.length;
  if (count <= 1) return [0];
  const intervals = Array.from({ length: count - 1 }, (_, index) => times[index + 1] - times[index]);
  if (intervals.some((value) => value <= 0)) fail('sampleTimes must be strictly increasing');
  const slopes = intervals.map((duration, index) => (values[index + 1] - values[index]) / duration);
  if (count === 2) return [0, 0];
  const tangents = new Array<number>(count).fill(0);
  for (let index = 1; index < count - 1; index += 1) {
    const previous = slopes[index - 1];
    const next = slopes[index];
    if (previous === 0 || next === 0 || Math.sign(previous) !== Math.sign(next)) {
      tangents[index] = 0;
      continue;
    }
    const previousDuration = intervals[index - 1];
    const nextDuration = intervals[index];
    const weight1 = 2 * nextDuration + previousDuration;
    const weight2 = nextDuration + 2 * previousDuration;
    tangents[index] = (weight1 + weight2) / (weight1 / previous + weight2 / next);
  }
  // Recorded gestures normally begin and end at rest. Explicitly force zero
  // endpoint velocity so home transitions remain C1-continuous.
  tangents[0] = 0;
  tangents[count - 1] = 0;
  return tangents;
}

function resampleTimedTrails(
  trails: readonly number[][], sourceTimes: readonly number[], duration: number, outputFrequency: number,
): number[][] {
  const sourceDuration = sourceTimes[sourceTimes.length - 1];
  if (sourceDuration <= 0 || trails[0].length === 1) return trails.map((trail) => [trail[0]]);
  const intervals = Math.max(1, Math.ceil(duration * outputFrequency - EPSILON));
  const output = Array.from({ length: trails.length }, () => new Array<number>(intervals + 1));
  const tangents = trails.map((trail) => pchipTangents(sourceTimes, trail));
  let sourceIndex = 0;
  for (let sample = 0; sample <= intervals; sample += 1) {
    const sourceTime = sourceDuration * (sample / intervals);
    while (sourceIndex < sourceTimes.length - 2 && sourceTime > sourceTimes[sourceIndex + 1]) sourceIndex += 1;
    const startTime = sourceTimes[sourceIndex];
    const endTime = sourceTimes[sourceIndex + 1];
    const alpha = endTime > startTime ? Math.max(0, Math.min(1, (sourceTime - startTime) / (endTime - startTime))) : 0;
    const alpha2 = alpha * alpha;
    const alpha3 = alpha2 * alpha;
    const h00 = 2 * alpha3 - 3 * alpha2 + 1;
    const h10 = alpha3 - 2 * alpha2 + alpha;
    const h01 = -2 * alpha3 + 3 * alpha2;
    const h11 = alpha3 - alpha2;
    const sourceInterval = endTime - startTime;
    for (let joint = 0; joint < trails.length; joint += 1) {
      output[joint][sample] = h00 * trails[joint][sourceIndex]
        + h10 * sourceInterval * tangents[joint][sourceIndex]
        + h01 * trails[joint][sourceIndex + 1]
        + h11 * sourceInterval * tangents[joint][sourceIndex + 1];
    }
  }
  // Preserve exact filtered endpoints and an exact duration on the output grid.
  output.forEach((trail, joint) => {
    trail[0] = trails[joint][0];
    trail[trail.length - 1] = trails[joint][trails[joint].length - 1];
  });
  return output;
}

function minimumJerkSegment(
  start: readonly number[], end: readonly number[], duration: number, outputFrequency: number,
): number[][] {
  const intervals = Math.max(1, Math.ceil(duration * outputFrequency - EPSILON));
  return start.map((value, joint) => Array.from({ length: intervals + 1 }, (_, sample) => {
    const blend = minimumJerk(sample / intervals);
    return value + (end[joint] - value) * blend;
  }));
}

function concatenateTrails(parts: readonly number[][][]): number[][] {
  const jointCount = parts[0].length;
  const output = Array.from({ length: jointCount }, () => [] as number[]);
  parts.forEach((part, partIndex) => {
    for (let joint = 0; joint < jointCount; joint += 1) {
      output[joint].push(...(partIndex === 0 ? part[joint] : part[joint].slice(1)));
    }
  });
  return output;
}

function peakAccelerations(trails: readonly number[][], outputFrequency: number): number[] {
  return trails.map((trail) => {
    let peak = 0;
    for (let sample = 2; sample < trail.length; sample += 1) {
      peak = Math.max(peak, Math.abs(trail[sample] - 2 * trail[sample - 1] + trail[sample - 2]) * outputFrequency ** 2);
    }
    return peak;
  });
}

function continuousSmoothRecording(
  safeRaw: readonly number[][],
  input: TrajectoryRetimeInput,
  maxVelocity: readonly number[],
  jointLimits: readonly UrdfJointLimit[],
  outputFrequency: number,
  targetSpeed: number,
  speedScale: number,
): ContinuousSmoothingResult {
  const sampleCount = safeRaw[0].length;
  const jointCount = safeRaw.length;
  const window = normalizeSmoothingWindow(input.smoothingWindow ?? 0, sampleCount);
  const filtered = robustSmoothTrails(safeRaw as number[][], window);
  const timeline = sourceTimeline(input.sampleTimes, sampleCount, input.samplingHz);
  const filteredPoints = Array.from({ length: sampleCount }, (_, sample) =>
    filtered.map((trail) => trail[sample]));
  const requestedTolerance = input.keypointEpsilon ?? 0.04;
  const { indices: controlIndices, effectiveTolerance } = extractBoundedKeypoints(
    filteredPoints,
    requestedTolerance,
    input.maxKeypoints ?? DEFAULT_MAX_KEYPOINTS,
  );
  const controlTrails = filtered.map((trail) => controlIndices.map((index) => trail[index]));
  const controlTimeline = controlIndices.map((index) => timeline[index]);
  const recordedDuration = timeline[timeline.length - 1];
  const centralBaseDuration = Math.max(1 / outputFrequency, input.preserveRecordedTiming !== false
    ? recordedDuration / speedScale
    : 1 / (targetSpeed * speedScale));

  const first = filtered.map((trail) => trail[0]);
  const last = filtered.map((trail) => trail[trail.length - 1]);
  let home: number[] | null = null;
  let approachBaseDuration = 0;
  let returnBaseDuration = 0;
  let addedHomePoints = 0;
  if (input.returnHome) {
    home = input.homePosition ? [...input.homePosition] : Array.from({ length: jointCount }, () => 0);
    if (home.length !== jointCount || home.some((value) => !Number.isFinite(value))) fail('homePosition');
    home.forEach((value, joint) => {
      if (value < jointLimits[joint].lower || value > jointLimits[joint].upper) fail(`homePosition[${joint}] exceeds its URDF joint limit`);
    });
    if (jointDistance(home, first) > EPSILON) {
      let metric = 0;
      let maxDelta = 0;
      for (let joint = 0; joint < jointCount; joint += 1) {
        const delta = Math.abs(first[joint] - home[joint]);
        metric = Math.max(metric, delta / maxVelocity[joint]);
        maxDelta = Math.max(maxDelta, delta);
      }
      approachBaseDuration = Math.max(
        1 / outputFrequency,
        MINIMUM_JERK_PEAK_VELOCITY * metric,
        Math.sqrt(MINIMUM_JERK_PEAK_ACCELERATION * maxDelta / input.maxAcceleration),
      );
      addedHomePoints += 1;
    }
    if (jointDistance(last, home) > EPSILON) {
      let metric = 0;
      let maxDelta = 0;
      for (let joint = 0; joint < jointCount; joint += 1) {
        const delta = Math.abs(home[joint] - last[joint]);
        metric = Math.max(metric, delta / maxVelocity[joint]);
        maxDelta = Math.max(maxDelta, delta);
      }
      returnBaseDuration = Math.max(
        1 / outputFrequency,
        MINIMUM_JERK_PEAK_VELOCITY * metric,
        Math.sqrt(MINIMUM_JERK_PEAK_ACCELERATION * maxDelta / input.maxAcceleration),
      );
      addedHomePoints += 1;
    }
  }

  let centralTimeScale = 1;
  let central = resampleTimedTrails(
    controlTrails,
    controlTimeline,
    centralBaseDuration,
    outputFrequency,
  );
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const duration = (central[0].length - 1) / outputFrequency;
    const velocityPeaks = peakVelocities(central, duration, central[0].length);
    const accelerationPeaks = peakAccelerations(central, outputFrequency);
    let stretch = 1;
    for (let joint = 0; joint < jointCount; joint += 1) {
      stretch = Math.max(
        stretch,
        velocityPeaks[joint] / maxVelocity[joint],
        input.preserveRecordedTiming === false
          ? Math.sqrt(accelerationPeaks[joint] / input.maxAcceleration)
          : 1,
      );
    }
    if (stretch <= 1.001) break;
    centralTimeScale *= stretch * 1.01;
    central = resampleTimedTrails(
      controlTrails,
      controlTimeline,
      centralBaseDuration * centralTimeScale,
      outputFrequency,
    );
  }

  const parts: number[][][] = [];
  if (home && approachBaseDuration > 0) {
    parts.push(minimumJerkSegment(home, first, approachBaseDuration * 1.02, outputFrequency));
  }
  parts.push(central);
  if (home && returnBaseDuration > 0) {
    parts.push(minimumJerkSegment(last, home, returnBaseDuration * 1.02, outputFrequency));
  }
  const trails = concatenateTrails(parts);
  if (trails[0].length > MAX_OUTPUT_SAMPLES) fail(`generated trajectory exceeds ${MAX_OUTPUT_SAMPLES} samples`);
  const duration = (trails[0].length - 1) / outputFrequency;
  return {
    trails,
    duration,
    addedHomePoints,
    peakVelocities: peakVelocities(trails, duration, trails[0].length),
    peakAccelerations: peakAccelerations(trails, outputFrequency),
    smoothingWindow: window,
    controlPointCount: controlIndices.length,
    effectiveTolerance,
  };
}

// ── main ─────────────────────────────────────────────────────────────────

export function retimeTrajectory(input: TrajectoryRetimeInput): TrajectoryRetimeResult {
  const limits = resolveLimitAlias(input.jointLimits, input.urdfJointLimits);
  const margin = input.limitMarginRad ?? LIMIT_SAFETY_MARGIN_RAD;
  const safeRaw = clampToSafeLimits(input.trails, limits, margin);
  let clamped = safeRaw.map((trail) => [...trail]);
  if (input.smoothing !== false) {
    clamped = clamped.map(smoothTrail);
    clamped = clampToSafeLimits(clamped, limits, margin);
  }
  const scale = input.overallSpeedScale ?? 1;
  if (!isFiniteNumber(scale) || scale <= 0) fail('overallSpeedScale must be finite and greater than zero');
  const { maxJointVelocity, jointLimits, outputFrequency, targetSpeed, duplicateTolerance } = validateInput({ ...input, trails: clamped });
  const jc = input.trails.length, sc = input.trails[0].length;

  const smoothingWindow = input.smoothingWindow ?? 0;
  if (smoothingWindow > 0) {
    const smoothed = continuousSmoothRecording(
      safeRaw, input, maxJointVelocity, jointLimits, outputFrequency, targetSpeed, scale,
    );
    const warnings = [
      `连续抗抖平滑：${sc} 帧录制 → ${smoothed.controlPointCount} 个形状控制点 → ${smoothed.trails[0].length} 帧输出`,
    ];
    if (smoothed.effectiveTolerance > (input.keypointEpsilon ?? 0.04) + EPSILON) {
      warnings.push(`控制点过多，路径容差已自动调整为 ${smoothed.effectiveTolerance.toFixed(3)} rad`);
    }
    if (smoothed.addedHomePoints > 0) warnings.push('已自动补全首尾回零段');
    if (
      input.preserveRecordedTiming !== false
      && smoothed.peakAccelerations.some((value) => value > input.maxAcceleration * 1.02)
    ) {
      warnings.push('保留示教节奏时加速度为软约束；如需严格限加速度，请关闭“保留示教节奏”');
    }
    smoothed.trails.forEach((trail, joint) => {
      trail.forEach((value) => {
        if (value < jointLimits[joint].lower - EPSILON || value > jointLimits[joint].upper + EPSILON) {
          fail(`generated trail[${joint}] exceeds its URDF joint limit`);
        }
      });
      if (smoothed.peakVelocities[joint] > maxJointVelocity[joint] * 1.01 + 1e-9) {
        fail(`generated trail[${joint}] exceeds its maximum velocity`);
      }
      if (
        input.preserveRecordedTiming === false
        && smoothed.peakAccelerations[joint] > input.maxAcceleration * 1.02 + 1e-9
      ) {
        fail(`generated trail[${joint}] exceeds its maximum acceleration`);
      }
    });
    return {
      trails: smoothed.trails,
      duration: smoothed.duration,
      peakVelocity: smoothed.peakVelocities,
      peakVelocities: smoothed.peakVelocities,
      sampleCount: smoothed.trails[0].length,
      diagnostics: {
        inputJointCount: jc,
        inputSampleCount: sc,
        retainedPathPoints: smoothed.controlPointCount,
        removedDuplicatePoints: sc - smoothed.controlPointCount,
        restrictedPathDuration: smoothed.duration,
        segmentDurations: [],
        requestedTargetProgressSpeed: targetSpeed,
        effectiveMaxProgressSpeed: 0,
        effectiveTargetProgressSpeed: input.preserveRecordedTiming !== false ? 0 : targetSpeed * scale,
        progressPeakSpeed: 0,
        progressPeakAcceleration: input.maxAcceleration,
        outputFrequency,
        warnings,
        addedHomePoints: smoothed.addedHomePoints,
        peakAccelerations: smoothed.peakAccelerations,
        smoothingWindowSamples: smoothed.smoothingWindow,
        smoothingTolerance: smoothed.effectiveTolerance,
      },
    };
  }

  const keypointEpsilon = input.keypointEpsilon ?? 0;
  if (keypointEpsilon > 0) {
    const smoothed = smoothVertices(
      clamped, safeRaw, input, maxJointVelocity, jointLimits, outputFrequency, targetSpeed, scale,
    );
    const peak = peakVelocities(smoothed.trails, smoothed.duration, smoothed.trails[0].length);
    const peakAccelerations = smoothed.trails.map((trail) => {
      let peakAcceleration = 0;
      for (let sample = 2; sample < trail.length; sample += 1) {
        peakAcceleration = Math.max(peakAcceleration, Math.abs(
          trail[sample] - 2 * trail[sample - 1] + trail[sample - 2],
        ) * outputFrequency ** 2);
      }
      return peakAcceleration;
    });
    const warnings = [
      `顶点平滑：${sc} 帧 → ${smoothed.keypointIndices.length} 个关键顶点 → ${smoothed.trails[0].length} 帧`,
    ];
    if (smoothed.effectiveTolerance > keypointEpsilon + EPSILON) {
      warnings.push(`关键顶点过多，容差已自动调整为 ${smoothed.effectiveTolerance.toFixed(3)} rad`);
    }
    if (smoothed.addedHomePoints > 0) warnings.push('已自动补全首尾回零段');
    smoothed.trails.forEach((trail, j) => {
      trail.forEach((v) => { if (v < jointLimits[j].lower - EPSILON || v > jointLimits[j].upper + EPSILON) fail(`generated trail[${j}] exceeds its URDF joint limit`); });
      if (peak[j] > maxJointVelocity[j] + 1e-9) fail(`generated trail[${j}] exceeds its maximum velocity`);
      if (peakAccelerations[j] > input.maxAcceleration * 1.02 + 1e-9) fail(`generated trail[${j}] exceeds its maximum acceleration`);
    });
    return {
      trails: smoothed.trails,
      duration: smoothed.duration,
      peakVelocity: peak,
      peakVelocities: peak,
      sampleCount: smoothed.trails[0].length,
      diagnostics: {
        inputJointCount: jc,
        inputSampleCount: sc,
        retainedPathPoints: smoothed.keypointIndices.length,
        removedDuplicatePoints: sc - smoothed.keypointIndices.length,
        restrictedPathDuration: smoothed.duration,
        segmentDurations: smoothed.segmentDurations,
        requestedTargetProgressSpeed: targetSpeed,
        effectiveMaxProgressSpeed: 0,
        effectiveTargetProgressSpeed: input.preserveRecordedTiming !== false ? 0 : targetSpeed * scale,
        progressPeakSpeed: 0,
        progressPeakAcceleration: input.maxAcceleration,
        outputFrequency,
        warnings,
        keypointIndices: smoothed.keypointIndices,
        smoothingTolerance: smoothed.effectiveTolerance,
        addedHomePoints: smoothed.addedHomePoints,
        peakAccelerations,
      },
    };
  }

  // ── Non‑keypoint mode ──────────────────────────────────────────────────
  let path: number[][] = [clamped.map((trail) => trail[0])];
  let rdp = 0;
  for (let s = 1; s < sc; s += 1) {
    const p = clamped.map((trail) => trail[s]);
    if (samePoint(path[path.length - 1], p, duplicateTolerance)) { rdp += 1; } else { path.push(p); }
  }
  const warnings: string[] = rdp > 0 ? [`removed ${rdp} duplicate path point(s)`] : [];
  if (path.length === 1) {
    const stationary = path[0].map((v) => [v]);
    return { trails: stationary, duration: 0, peakVelocity: input.trails.map(() => 0), peakVelocities: input.trails.map(() => 0), sampleCount: 1, diagnostics: { inputJointCount: jc, inputSampleCount: sc, retainedPathPoints: 1, removedDuplicatePoints: rdp, restrictedPathDuration: 0, segmentDurations: [], requestedTargetProgressSpeed: targetSpeed, effectiveMaxProgressSpeed: 0, effectiveTargetProgressSpeed: 0, progressPeakSpeed: 0, progressPeakAcceleration: 0, outputFrequency, warnings } };
  }
  const seg = path.slice(1).map((p, i) => {
    let d = 0;
    for (let j = 0; j < jc; j += 1) d = Math.max(d, Math.abs(p[j] - path[i][j]) / maxJointVelocity[j]);
    if (!(d > 0)) fail('path contains a zero-length segment');
    return d;
  });
  const restricted = seg.reduce((a, b) => a + b, 0);
  const psl = 1 / restricted;
  const emax = Math.min(input.maxProgressSpeed, psl);
  const etgt = Math.min(targetSpeed * scale, emax);
  if (input.maxProgressSpeed > psl + EPSILON) warnings.push('progress speed capped by joint velocity');
  if (targetSpeed > input.maxProgressSpeed + EPSILON) warnings.push('target speed capped by maxProgressSpeed');
  const acc = input.maxAcceleration;
  const minDur = etgt ** 2 / acc >= 1 ? 2 / Math.sqrt(acc) : 1 / etgt + etgt / acc;
  const sampleCount = Math.max(2, Math.ceil(minDur * outputFrequency - EPSILON) + 1);
  const duration = (sampleCount - 1) / outputFrequency;
  const profile = buildProfile(duration, etgt, acc);
  const trails = samplePath(path, seg, restricted, profile, outputFrequency);
  const peak = peakVelocities(trails, duration, sampleCount);
  trails.forEach((t, j) => {
    t.forEach((v) => { if (v < jointLimits[j].lower - EPSILON || v > jointLimits[j].upper + EPSILON) fail(`generated trail[${j}] exceeds its URDF joint limit`); });
    if (peak[j] > maxJointVelocity[j] + 1e-9) fail(`generated trail[${j}] exceeds its maximum velocity`);
  });
  return {
    trails, duration, peakVelocity: peak, peakVelocities: peak, sampleCount,
    diagnostics: { inputJointCount: jc, inputSampleCount: sc, retainedPathPoints: path.length, removedDuplicatePoints: rdp, restrictedPathDuration: restricted, segmentDurations: seg, requestedTargetProgressSpeed: targetSpeed, effectiveMaxProgressSpeed: emax, effectiveTargetProgressSpeed: etgt, progressPeakSpeed: profile.peakSpeed, progressPeakAcceleration: acc, outputFrequency, warnings },
  };
}

export const retimeFixedSpeedTrajectory = retimeTrajectory;

// ── Timestamp-preserving retime ──────────────────────────────────────────

export interface TimedRetimeInput {
  /** 带时间戳的原始采样（相对于录制开始，秒） */
  timedSamples: TimedSample[];
  /** 各关节速度上限 (rad/s) */
  maxJointVelocity: readonly number[];
  /** 输出频率 (Hz)，默认 100 */
  outputFrequency?: number;
  /** 整体速度比例 (0.1 ~ 2.0)，默认 1.0 */
  overallSpeedScale?: number;
  /** 关节限位 */
  jointLimits?: readonly UrdfJointLimit[];
  urdfJointLimits?: readonly UrdfJointLimit[];
  /** 限位安全余量 (rad)，默认 0.05 */
  limitMarginRad?: number;
}

export interface TimedRetimeResult {
  /** [joint][sample] — 均匀采样 */
  trails: number[][];
  /** 处理后总时长（秒） */
  duration: number;
  /** 样本数 */
  sampleCount: number;
  /** 各关节峰值速度 (rad/s) */
  peakVelocities: number[];
  /** 警告信息 */
  warnings: string[];
  /** 原始录制时长（秒） */
  originalDuration: number;
  /** 被拉伸的片段数 */
  stretchedSegments: number;
  /** 输出频率 (Hz) */
  outputFrequency: number;
}

/**
 * 基于时间戳的轨迹重采样。
 *
 * 保留原始录制的运动节奏，只在关节速度超过 `maxJointVelocity` 时拉伸对应片段的时间。
 * 输出为 `outputFrequency` Hz 的均匀采样，使用线性插值。
 *
 * 与 Catmull-Rom 模式不同，本函数不会删除帧、不会改变原始运动节奏，
 * 也不会引入样条过冲。
 */
export function retimeWithTimestamps(input: TimedRetimeInput): TimedRetimeResult {
  const { timedSamples, maxJointVelocity, jointLimits, urdfJointLimits } = input;
  const outputFrequency = input.outputFrequency ?? DEFAULT_OUTPUT_FREQUENCY;
  const scale = input.overallSpeedScale ?? 1;
  const margin = input.limitMarginRad ?? LIMIT_SAFETY_MARGIN_RAD;
  const limits = resolveLimitAlias(jointLimits, urdfJointLimits);
  const jc = 7;

  if (timedSamples.length < 2) fail('timedSamples must contain at least 2 samples');
  if (maxJointVelocity.length !== jc) fail('maxJointVelocity must have 7 values');
  if (maxJointVelocity.some((v) => !isFiniteNumber(v) || v <= 0)) fail('maxJointVelocity must be positive finite');
  if (!isFiniteNumber(outputFrequency) || outputFrequency <= 0) fail('outputFrequency');
  if (!isFiniteNumber(scale) || scale <= 0) fail('overallSpeedScale must be positive');

  const originalDuration = timedSamples[timedSamples.length - 1].t - timedSamples[0].t;
  if (originalDuration <= 0) fail('timedSamples must span a positive duration');

  // 防止意外的大数组分配（最多 600 秒 @ 100Hz = 60,000 样本）
  const MAX_SAMPLES = 60_000;

  // 1. 计算每个原始片段的时间拉伸因子
  const segments: { dt: number; p0: number[]; p1: number[]; scale: number }[] = [];
  let stretchedSegments = 0;

  for (let i = 1; i < timedSamples.length; i++) {
    const rawDt = (timedSamples[i].t - timedSamples[i - 1].t) / scale;
    if (rawDt <= 0) continue;
    const p0 = timedSamples[i - 1].positions;
    const p1 = timedSamples[i].positions;

    let maxSpeedRatio = 0;
    for (let j = 0; j < jc; j++) {
      const vel = Math.abs(p1[j] - p0[j]) / rawDt;
      const ratio = vel / maxJointVelocity[j];
      if (ratio > maxSpeedRatio) maxSpeedRatio = ratio;
    }

    // 如果超速，拉伸时间；否则保持原速
    const segScale = Math.max(1, maxSpeedRatio);
    if (segScale > 1) stretchedSegments++;
    segments.push({ dt: rawDt, p0: [...p0], p1: [...p1], scale: segScale });
  }

  // 2. 构建累计时间轴
  const cumTime: number[] = [0];
  for (const seg of segments) {
    cumTime.push(cumTime[cumTime.length - 1] + seg.dt * seg.scale);
  }
  const totalDuration = cumTime[cumTime.length - 1];

  // 3. 按输出频率采样
  const sampleCount = Math.max(2, Math.min(MAX_SAMPLES, Math.ceil(totalDuration * outputFrequency) + 1));
  const dt = 1 / outputFrequency;
  const trails = Array.from({ length: jc }, () => new Array<number>(sampleCount).fill(0));

  for (let s = 0; s < sampleCount; s++) {
    const t = s * dt;
    // 找到对应的片段
    let segIdx = 0;
    while (segIdx < segments.length - 1 && t > cumTime[segIdx + 1]) segIdx++;
    const seg = segments[segIdx];
    const segDuration = seg.dt * seg.scale;
    const alpha = segDuration > 0 ? Math.max(0, Math.min(1, (t - cumTime[segIdx]) / segDuration)) : 0;

    for (let j = 0; j < jc; j++) {
      trails[j][s] = seg.p0[j] + (seg.p1[j] - seg.p0[j]) * alpha;
    }
  }

  // 4. 钳制到限位内
  if (limits) {
    for (let j = 0; j < jc; j++) {
      const lo = limits[j].lower + margin;
      const hi = limits[j].upper - margin;
      for (let s = 0; s < sampleCount; s++) {
        trails[j][s] = Math.min(hi, Math.max(lo, trails[j][s]));
      }
    }
  }

  // 5. 计算峰值速度
  const duration = totalDuration;
  const peakVelocities = peakVelocities2(trails, duration, sampleCount);

  // 6. 警告
  const warnings: string[] = [];
  if (stretchedSegments > 0) {
    warnings.push(`${stretchedSegments}/${segments.length} 个片段因超速被拉伸`);
  }
  if (scale !== 1) {
    warnings.push(`速度比例 ${scale}×`);
  }

  return {
    trails,
    duration,
    sampleCount,
    peakVelocities,
    warnings,
    originalDuration,
    stretchedSegments,
    outputFrequency,
  };
}

function peakVelocities2(trails: number[][], duration: number, sc: number): number[] {
  if (sc < 2 || duration <= 0) return trails.map(() => 0);
  const dt = duration / (sc - 1);
  return trails.map((trail) => {
    let peak = 0;
    for (let s = 1; s < trail.length; s++) {
      peak = Math.max(peak, Math.abs(trail[s] - trail[s - 1]) / dt);
    }
    return peak;
  });
}
