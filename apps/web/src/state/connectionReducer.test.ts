import { describe, expect, it } from 'vitest';
import { connectionReducer, INITIAL_CONNECTION } from './connectionReducer';
import { SIMULATION_CAPABILITIES } from '../types';
import type { ConnectionState, RobotConnection } from '../types';

const CONNECTED: RobotConnection = {
  status: 'connected',
  channel: 'can0',
  expected_ids: [1, 2, 3, 4, 5, 6, 7],
  found_ids: [1, 2, 3, 4, 5, 6, 7],
  missing_ids: [],
  started_at: '2026-08-08T00:00:00+00:00',
  completed_at: '2026-08-08T00:00:01+00:00',
  source: 'simulation',
  message: 'All motors responded on can0',
};

const PARTIAL: RobotConnection = {
  ...CONNECTED,
  status: 'partial',
  found_ids: [1, 2, 3],
  missing_ids: [4, 5, 6, 7],
  message: 'Found 3/7 motors on can0; missing motor IDs: 4, 5, 6, 7',
};

describe('connectionReducer', () => {
  it('初始状态为 disconnected 且无请求在途', () => {
    expect(INITIAL_CONNECTION.status).toBe('disconnected');
    expect(INITIAL_CONNECTION.scanning).toBe(false);
    expect(INITIAL_CONNECTION.error).toBeNull();
  });

  it('CONNECTION_SCAN_START 置本地扫描标志并清空错误', () => {
    const withError: ConnectionState = { ...INITIAL_CONNECTION, error: '旧错误' };
    const next = connectionReducer(withError, { type: 'CONNECTION_SCAN_START' });
    expect(next.scanning).toBe(true);
    expect(next.error).toBeNull();
    // 扫描期间不伪造后端 status
    expect(next.status).toBe('disconnected');
  });

  it('CONNECTION_SET 完全采用后端返回字段并清除请求/错误标志', () => {
    const prev: ConnectionState = { ...INITIAL_CONNECTION, scanning: true, error: 'x' };
    const next = connectionReducer(prev, { type: 'CONNECTION_SET', payload: PARTIAL });
    expect(next.status).toBe('partial');
    expect(next.found_ids).toEqual([1, 2, 3]);
    expect(next.missing_ids).toEqual([4, 5, 6, 7]);
    expect(next.channel).toBe('can0');
    expect(next.expected_ids).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(next.source).toBe('simulation');
    expect(next.message).toContain('missing');
    expect(next.started_at).toBe('2026-08-08T00:00:00+00:00');
    expect(next.completed_at).toBe('2026-08-08T00:00:01+00:00');
    expect(next.scanning).toBe(false);
    expect(next.error).toBeNull();
    expect(typeof next.syncedAt).toBe('number');
  });

  it('CONNECTION_ERROR 清除在途标志并记录错误（不改变后端 status）', () => {
    const prev: ConnectionState = { ...CONNECTED, scanning: true, error: null, syncedAt: 0, capabilities: SIMULATION_CAPABILITIES };
    const next = connectionReducer(prev, { type: 'CONNECTION_ERROR', payload: { error: '网络错误：无法连接后端' } });
    expect(next.scanning).toBe(false);
    expect(next.error).toContain('网络错误');
    // 错误不把 connected 伪装成别的，也不把 partial/error 伪装成 connected
    expect(next.status).toBe('connected');
  });

  it('partial 永不显示为 connected', () => {
    const next = connectionReducer(INITIAL_CONNECTION, { type: 'CONNECTION_SET', payload: PARTIAL });
    expect(next.status).toBe('partial');
    expect(next.status === 'connected').toBe(false);
  });

  it('motorbridge 连接：后端返回 capabilities 时直接采用（遥测门禁由此打开）', () => {
    // Phase 7H 回归：此前 /api/robot/connection 不返回 capabilities，
    // motorbridge 一律按 source 派生 fail-closed（telemetry=false），
    // 导致 HDMI 页面永远不打开遥测 WebSocket。
    const backendCaps = {
      scan: true,
      telemetry: true,
      control: false,
      homing: false,
      disable: false,
      parameter_write: false,
      persistent_gain_write: false,
      mit_gain_write: false,
      set_zero: false,
      zero_torque: false,
      enable: true,
      active_report_write: true,
    };
    const next = connectionReducer(INITIAL_CONNECTION, {
      type: 'CONNECTION_SET',
      payload: { ...CONNECTED, source: 'motorbridge', capabilities: backendCaps },
    });
    expect(next.status).toBe('connected');
    expect(next.source).toBe('motorbridge');
    expect(next.capabilities.telemetry).toBe(true);
    expect(next.capabilities.control).toBe(false);
  });

  it('motorbridge 连接：后端未返回 capabilities → fail closed（telemetry=false）', () => {
    const next = connectionReducer(INITIAL_CONNECTION, {
      type: 'CONNECTION_SET',
      payload: { ...CONNECTED, source: 'motorbridge' },
    });
    expect(next.capabilities.telemetry).toBe(false);
    expect(next.capabilities.control).toBe(false);
    expect(next.capabilities.scan).toBe(true);
  });
});
