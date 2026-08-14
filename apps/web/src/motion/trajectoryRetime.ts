/**
 * Trajectory retiming: raw recording → processed 50 Hz trajectory.
 *
 * Two modes:
 *   1. 无 keypointEpsilon → 原始 verhalten(retime by joint velocity limits + trapezoidal profile)
 *   2. 有 keypointEpsilon(>0) → Catmull-Rom spline 平滑(标准拖拽教学管线)
 *
 * 新增模式 (retimeWithTimestamps):
 *   3. 基于时间戳的轨迹重采样：保留原始录制节奏，仅在超速时拉伸时间
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
const SPLINE_CONTROL_SPACING = 10;

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

// ── Catmull-Rom spline smoothing ────────────────────────────────────────

export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function catmullRomResample(
  trails: readonly number[][], spacing: number, of: number, scale: number,
  maxVel: readonly number[], inputHz: number,
): number[][] {
  const jc = trails.length, ic = trails[0].length;
  const ctrl: number[] = [0];
  for (let i = spacing; i < ic - 1; i += spacing) ctrl.push(i);
  ctrl.push(ic - 1);
  const controls = ctrl.map((idx) => trails.map((trail) => trail[idx]));
  const cum: number[] = [0];
  for (let i = 1; i < ctrl.length; i += 1) {
    const rec = (ctrl[i] - ctrl[i - 1]) / inputHz;
    let vt = 0;
    for (let j = 0; j < jc; j += 1) vt = Math.max(vt, Math.abs(controls[i][j] - controls[i - 1][j]) / maxVel[j]);
    // Catmull-Rom overshoot can exceed the linear estimate; 2× guard covers it.
    cum.push(cum[cum.length - 1] + Math.max(rec / scale, vt * 2));
  }
  const td = cum[cum.length - 1];
  const sc = Math.max(2, Math.ceil(td * of) + 1);
  const dt = 1 / of;
  const out = Array.from({ length: jc }, () => new Array<number>(sc));
  for (let s = 0; s < sc; s += 1) {
    const t = s * dt;
    let seg = 0;
    while (seg < ctrl.length - 2 && t > cum[seg + 1]) seg += 1;
    const ss = cum[seg], se = cum[seg + 1];
    const alpha = se > ss ? Math.max(0, Math.min(1, (t - ss) / (se - ss))) : 0;
    for (let j = 0; j < jc; j += 1) {
      const p0 = controls[Math.max(0, seg - 1)][j];
      const p1 = controls[seg][j];
      const p2 = controls[Math.min(ctrl.length - 1, seg + 1)][j];
      const p3 = controls[Math.min(ctrl.length - 1, seg + 2)][j];
      out[j][s] = catmullRom(p0, p1, p2, p3, alpha);
    }
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────

export function retimeTrajectory(input: TrajectoryRetimeInput): TrajectoryRetimeResult {
  const limits = resolveLimitAlias(input.jointLimits, input.urdfJointLimits);
  const margin = input.limitMarginRad ?? LIMIT_SAFETY_MARGIN_RAD;
  let clamped = clampToSafeLimits(input.trails, limits, margin);
  if (input.smoothing !== false) {
    clamped = clamped.map(smoothTrail);
    clamped = clampToSafeLimits(clamped, limits, margin);
  }
  const scale = input.overallSpeedScale ?? 1;
  if (!isFiniteNumber(scale) || scale <= 0) fail('overallSpeedScale must be finite and greater than zero');
  const { maxJointVelocity, jointLimits, outputFrequency, targetSpeed, duplicateTolerance } = validateInput({ ...input, trails: clamped });
  const jc = input.trails.length, sc = input.trails[0].length;

  const keypointEpsilon = input.keypointEpsilon ?? 0;
  if (keypointEpsilon > 0) {
    const output = catmullRomResample(clamped, SPLINE_CONTROL_SPACING, outputFrequency, scale, maxJointVelocity, input.samplingHz);
    const cpCount = Math.ceil((sc - 1) / SPLINE_CONTROL_SPACING) + 1; // actual control points
    const pitch = output[0].length > 1 ? output[0].length - 1 : 0;
    const duration = pitch / outputFrequency;
    const peak = peakVelocities(output, duration, output[0].length);
    const warnings = [`Catmull-Rom spline: ${sc} input → ${cpCount} control points → ${output[0].length} output samples`];
    output.forEach((trail, j) => {
      trail.forEach((v) => { if (v < jointLimits[j].lower - EPSILON || v > jointLimits[j].upper + EPSILON) fail(`generated trail[${j}] exceeds its URDF joint limit`); });
      if (peak[j] > maxJointVelocity[j] + 1e-9) fail(`generated trail[${j}] exceeds its maximum velocity`);
    });
    return {
      trails: output, duration, peakVelocity: peak, peakVelocities: peak, sampleCount: output[0].length,
      diagnostics: { inputJointCount: jc, inputSampleCount: sc, retainedPathPoints: cpCount, removedDuplicatePoints: 0, restrictedPathDuration: duration, segmentDurations: [], requestedTargetProgressSpeed: targetSpeed, effectiveMaxProgressSpeed: 0, effectiveTargetProgressSpeed: 0, progressPeakSpeed: 0, progressPeakAcceleration: 0, outputFrequency, warnings },
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
  const sampleCount = Math.max(2, Math.ceil(totalDuration * outputFrequency) + 1);
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