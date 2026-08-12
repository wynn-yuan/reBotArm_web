import { describe, expect, it } from 'vitest';
import { sameZeroTorqueStatus } from './AppContext';
import type { ZeroTorqueStatus } from '../types';

const BASE: ZeroTorqueStatus = {
  status: 'inactive',
  frequency_hz: 50,
  channel: 'can1',
  motor_ids: [1, 2, 3, 4, 5, 6, 7],
  started_at: null,
  updated_at: '2026-08-11T00:00:00Z',
  error: null,
};

describe('sameZeroTorqueStatus', () => {
  it('keeps identical polling responses referentially stable', () => {
    expect(sameZeroTorqueStatus(BASE, { ...BASE, motor_ids: [...BASE.motor_ids] })).toBe(true);
  });

  it('detects a real lifecycle change', () => {
    expect(sameZeroTorqueStatus(BASE, { ...BASE, status: 'active' })).toBe(false);
    expect(sameZeroTorqueStatus(BASE, { ...BASE, updated_at: '2026-08-11T00:00:01Z' })).toBe(false);
  });
});
