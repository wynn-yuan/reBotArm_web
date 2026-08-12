import { describe, expect, it } from 'vitest';
import { allWritesDisabled, can, capabilitiesForSource, isReadOnly } from './readOnly';
import { FAIL_CLOSED_CAPABILITIES, SIMULATION_CAPABILITIES } from '../types';
import { capabilitiesFor } from './connectionReducer';
import type { RobotConnection } from '../types';

const BASE: RobotConnection = {
  status: 'connected',
  channel: 'can0',
  expected_ids: [1, 2, 3, 4, 5, 6, 7],
  found_ids: [1, 2, 3, 4, 5, 6, 7],
  missing_ids: [],
  started_at: null,
  completed_at: null,
  source: 'motorbridge',
  message: null,
};

describe('capabilitiesForSource / capabilitiesFor —— fail closed', () => {
  it('motorbridge + 无 capabilities → 所有写操作禁用（fail closed）', () => {
    const caps = capabilitiesForSource('motorbridge');
    expect(caps.control).toBe(false);
    expect(caps.homing).toBe(false);
    expect(caps.disable).toBe(false);
    expect(caps.parameter_write).toBe(false);
    expect(caps.telemetry).toBe(false);
    // scan 仍可用
    expect(caps.scan).toBe(true);
    // 真机只读
    expect(isReadOnly(caps)).toBe(true);
    expect(allWritesDisabled(caps)).toBe(true);
  });

  it('simulation → 模拟功能仍可使用（capabilities 全开、非只读）', () => {
    const caps = capabilitiesForSource('simulation');
    expect(SIMULATION_CAPABILITIES.control).toBe(true);
    expect(caps.control).toBe(true);
    expect(caps.homing).toBe(true);
    expect(caps.disable).toBe(true);
    expect(caps.parameter_write).toBe(true);
    expect(isReadOnly(caps)).toBe(false);
    expect(allWritesDisabled(caps)).toBe(false);
  });

  it('capability 缺失（source 未返回 / null）默认拒绝', () => {
    expect(capabilitiesForSource(null)).toEqual(FAIL_CLOSED_CAPABILITIES);
    expect(capabilitiesForSource(undefined)).toEqual(FAIL_CLOSED_CAPABILITIES);
    expect(allWritesDisabled(FAIL_CLOSED_CAPABILITIES)).toBe(true);
    expect(isReadOnly(FAIL_CLOSED_CAPABILITIES)).toBe(true);
  });

  it('connectionReducer.capabilitiesFor 按 source 派生，且显式 capabilities 优先', () => {
    // motorbridge → fail closed
    expect(capabilitiesFor({ ...BASE, source: 'motorbridge' }).control).toBe(false);
    // simulation → 全开
    expect(capabilitiesFor({ ...BASE, source: 'simulation' }).control).toBe(true);
    // 后端随连接响应显式返回 capabilities 时直接采用（含 active_report_write）
    const explicit = { control: true, homing: true, disable: true, enable: true, parameter_write: true, persistent_gain_write: true, mit_gain_write: false, set_zero: false, zero_torque: false, telemetry: true, scan: true, active_report_write: true };
    expect(capabilitiesFor({ ...BASE, source: 'motorbridge', capabilities: explicit })).toEqual(explicit);
  });
});

describe('真机模式不会用模拟遥测推进安全状态', () => {
  it('motorbridge 只读能力下 homing / disable 均为 false，无法发起模拟回零/失能', () => {
    const caps = capabilitiesForSource('motorbridge');
    expect(can(caps, 'homing')).toBe(false);
    expect(can(caps, 'disable')).toBe(false);
    // 安全机的回零/失能推进依赖 homing/disable 能力，能力缺失即不会推进
    expect(can(caps, 'homing') && can(caps, 'disable')).toBe(false);
  });

  it('真机只读空闲可安全清理连接：无需 homing/disable（直接走只读断开）', () => {
    const caps = capabilitiesForSource('motorbridge');
    // 空闲清理不依赖任何控制能力即可执行
    expect(allWritesDisabled(caps)).toBe(true);
    expect(caps.control).toBe(false);
    // 断言：只读断开不走模拟回零/失能（homing/disable 均不可用）
    expect(can(caps, 'homing')).toBe(false);
  });
});

describe('can() 能力查询', () => {
  it('按 key 查询', () => {
    expect(can(SIMULATION_CAPABILITIES, 'control')).toBe(true);
    expect(can(FAIL_CLOSED_CAPABILITIES, 'scan')).toBe(true);
    expect(can(FAIL_CLOSED_CAPABILITIES, 'parameter_write')).toBe(false);
  });
});
