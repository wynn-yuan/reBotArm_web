/**
 * 真机只读能力判定（纯逻辑，与 React 解耦，便于单元测试）。
 *
 * 语义：
 * - source === 'simulation' → 原型演示模式，允许完整模拟控制流程。
 * - 其余（motorbridge / 未返回 / 未知）→ fail closed：仅 scan 可用，
 *   telemetry/control/homing/disable/parameter_write 一律视为 false。
 * - 真机只读 = 不具 control 能力。
 */
import type { RobotCapabilities } from '../types';
import { FAIL_CLOSED_CAPABILITIES, SIMULATION_CAPABILITIES } from '../types';

/** 按适配器 source 派生能力（fail closed）。 */
export function capabilitiesForSource(source: string | null | undefined): RobotCapabilities {
  return source === 'simulation' ? SIMULATION_CAPABILITIES : FAIL_CLOSED_CAPABILITIES;
}

/** 真机只读 = 不具控制能力。 */
export function isReadOnly(caps: RobotCapabilities): boolean {
  return !caps.control;
}

/** 某项能力是否可用。 */
export function can(caps: RobotCapabilities, key: keyof RobotCapabilities): boolean {
  return !!caps[key];
}

/** 真机只读：所有写操作（控制/回零/失能/参数写入）是否都被禁用。 */
export function allWritesDisabled(caps: RobotCapabilities): boolean {
  return !caps.control && !caps.homing && !caps.disable && !caps.parameter_write;
}