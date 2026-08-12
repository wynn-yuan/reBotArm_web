import { describe, expect, it } from 'vitest';
import {
  createAgingCycleState,
  reduceAgingCycle,
  type AgingCycleConfig,
  type AgingCycleEffect,
  type AgingCycleState,
} from './agingCycle';

const twoRounds: AgingCycleConfig = {
  loopMode: 'count',
  count: 2,
  intervalMs: 500,
  trajectoryId: 'process-action',
};

function step(state: AgingCycleState, event: Parameters<typeof reduceAgingCycle>[1]): AgingCycleState {
  const result = reduceAgingCycle(state, event);
  expect(result.accepted, result.error).toBe(true);
  return result.state;
}

function effectTypes(effects: readonly AgingCycleEffect[]): string[] {
  return effects.map((effect) => effect.type);
}

function start(config: AgingCycleConfig = twoRounds): AgingCycleState {
  const result = reduceAgingCycle(createAgingCycleState(), { type: 'START', config, atMs: 100 });
  expect(result.accepted).toBe(true);
  expect(result.state.phase).toBe('initial_homing');
  expect(effectTypes(result.effects)).toEqual(['WRITE_EVENT', 'REQUEST_HOME']);
  return result.state;
}

describe('agingCycle pure state machine', () => {
  it('runs two complete rounds and only homes before the first and after each trajectory', () => {
    let state = start();

    let result = reduceAgingCycle(state, { type: 'HOME_OK' });
    expect(result.state.phase).toBe('running_trajectory');
    expect(result.state.round).toBe(1);
    expect(effectTypes(result.effects)).toContain('PLAY_TRAJECTORY');
    state = result.state;

    state = step(state, { type: 'TRAJECTORY_COMPLETE' });
    expect(state.phase).toBe('returning_home');
    state = step(state, { type: 'HOME_OK' });
    expect(state.phase).toBe('verifying_home');
    state = step(state, { type: 'HOME_VERIFIED' });
    expect(state.phase).toBe('interval_wait');
    state = step(state, { type: 'INTERVAL_ELAPSED' });
    state = step(state, { type: 'HOME_VERIFIED' });
    expect(state.phase).toBe('running_trajectory');
    expect(state.round).toBe(2);
    state = step(state, { type: 'TRAJECTORY_COMPLETE' });
    state = step(state, { type: 'HOME_OK' });
    const final = reduceAgingCycle(state, { type: 'HOME_VERIFIED' });
    expect(final.state.phase).toBe('completed');
    expect(effectTypes(final.effects)).toEqual(['WRITE_EVENT', 'COMPLETE_SESSION']);
    expect(final.state.round).toBe(2);
  });

  it('increments the next round without issuing a second home request', () => {
    let state = start({ ...twoRounds, count: 3 });
    state = step(state, { type: 'HOME_OK' });
    state = step(state, { type: 'TRAJECTORY_COMPLETE' });
    state = step(state, { type: 'HOME_OK' });
    state = step(state, { type: 'HOME_VERIFIED' });
    state = step(state, { type: 'INTERVAL_ELAPSED' });
    const next = reduceAgingCycle(state, { type: 'HOME_VERIFIED' });
    expect(next.state.phase).toBe('running_trajectory');
    expect(next.state.round).toBe(2);
    expect(effectTypes(next.effects)).toContain('PLAY_TRAJECTORY');
    expect(effectTypes(next.effects)).not.toContain('REQUEST_HOME');
  });

  it('supports count, duration, and infinite termination policies', () => {
    let countState = start({ ...twoRounds, count: 1 });
    countState = step(countState, { type: 'HOME_OK' });
    countState = step(countState, { type: 'TRAJECTORY_COMPLETE' });
    countState = step(countState, { type: 'HOME_OK' });
    expect(step(countState, { type: 'HOME_VERIFIED' }).phase).toBe('completed');

    let durationState = start({ loopMode: 'duration', durationMs: 1000, intervalMs: 50 });
    durationState = step(durationState, { type: 'HOME_OK' });
    const durationEnd = reduceAgingCycle(durationState, { type: 'TIME_ELAPSED', elapsedMs: 1000 });
    expect(durationEnd.state.phase).toBe('returning_home');
    durationState = step(durationEnd.state, { type: 'HOME_OK' });
    expect(step(durationState, { type: 'HOME_VERIFIED' }).phase).toBe('completed');

    let infiniteState = start({ loopMode: 'infinite', intervalMs: 0 });
    infiniteState = step(infiniteState, { type: 'HOME_OK' });
    infiniteState = step(infiniteState, { type: 'TRAJECTORY_COMPLETE' });
    infiniteState = step(infiniteState, { type: 'HOME_OK' });
    infiniteState = step(infiniteState, { type: 'HOME_VERIFIED' });
    expect(infiniteState.phase).toBe('interval_wait');
    expect(step(infiniteState, { type: 'INTERVAL_ELAPSED' }).phase).toBe('verifying_home');
  });

  it('rejects out-of-order events without changing state or emitting effects', () => {
    const state = start();
    const illegal = reduceAgingCycle(state, { type: 'TRAJECTORY_COMPLETE' });
    expect(illegal.accepted).toBe(false);
    expect(illegal.effects).toEqual([]);
    expect(illegal.state).toBe(state);
  });

  it('routes status and follow-error faults to failed, and home faults to failed', () => {
    const statusState = step(start(), { type: 'HOME_OK' });
    const status = reduceAgingCycle(statusState, { type: 'STATUS_CODE', code: 17 });
    expect(status.state.phase).toBe('failed');
    expect(status.effects.map((effect) => effect.type)).toContain('WRITE_EVENT');

    const followState = step(start(), { type: 'HOME_OK' });
    const follow = reduceAgingCycle(followState, { type: 'FOLLOW_ERROR', error: 0.42 });
    expect(follow.state.phase).toBe('failed');

    const timeoutState = start();
    const timeout = reduceAgingCycle(timeoutState, { type: 'HOME_TIMEOUT' });
    expect(timeout.state.phase).toBe('failed');

    let verifyState = step(start(), { type: 'HOME_OK' });
    verifyState = step(verifyState, { type: 'TRAJECTORY_COMPLETE' });
    verifyState = step(verifyState, { type: 'HOME_OK' });
    const verifyFail = reduceAgingCycle(verifyState, { type: 'HOME_VERIFY_FAIL', detail: 'zero offset' });
    expect(verifyFail.state.phase).toBe('failed');
  });

  it('holds on communication loss and never accepts a fake home confirmation', () => {
    const state = step(start(), { type: 'HOME_OK' });
    const lost = reduceAgingCycle(state, { type: 'COMMUNICATION_LOST' });
    expect(lost.state.phase).toBe('held');
    expect(effectTypes(lost.effects)).not.toContain('REQUEST_HOME');
    const fakeHome = reduceAgingCycle(lost.state, { type: 'HOME_OK' });
    expect(fakeHome.accepted).toBe(false);
    expect(fakeHome.state.phase).toBe('held');

    const restored = reduceAgingCycle(lost.state, { type: 'COMMUNICATION_RESTORED' });
    expect(restored.state.phase).toBe('held');
    const recovered = reduceAgingCycle(restored.state, { type: 'RECOVER' });
    expect(recovered.state.phase).toBe('initial_homing');
    expect(effectTypes(recovered.effects)).toContain('REQUEST_HOME');
  });

  it('stops through controlled homing when connected, but holds when disconnected', () => {
    let state = step(start(), { type: 'HOME_OK' });
    const stop = reduceAgingCycle(state, { type: 'STOP', reason: 'operator stop' });
    expect(stop.state.phase).toBe('stopping');
    expect(effectTypes(stop.effects)).toContain('REQUEST_HOME');
    const stopped = reduceAgingCycle(stop.state, { type: 'HOME_OK' });
    expect(stopped.state.phase).toBe('completed');
    expect(effectTypes(stopped.effects)).toContain('COMPLETE_SESSION');

    state = step(start(), { type: 'HOME_OK' });
    const lostStop = reduceAgingCycle(state, { type: 'STOP', communicationAvailable: false });
    expect(lostStop.state.phase).toBe('held');
    expect(effectTypes(lostStop.effects)).not.toContain('REQUEST_HOME');
  });

  it('handles home and verification timeout/failure after a communication loss as held', () => {
    let state = start();
    state = reduceAgingCycle(state, { type: 'COMMUNICATION_LOST' }).state;
    const timeout = reduceAgingCycle(state, { type: 'HOME_TIMEOUT' });
    expect(timeout.accepted).toBe(false);
    expect(timeout.state.phase).toBe('held');

    state = step(start(), { type: 'HOME_OK' });
    state = step(state, { type: 'TRAJECTORY_COMPLETE' });
    state = step(state, { type: 'HOME_OK' });
    state = reduceAgingCycle(state, { type: 'COMMUNICATION_LOST' }).state;
    const verifyFail = reduceAgingCycle(state, { type: 'HOME_VERIFY_FAIL' });
    expect(verifyFail.accepted).toBe(false);
    expect(verifyFail.state.phase).toBe('held');
  });

  it('records torque without using it as a stopping threshold', () => {
    const state = step(start(), { type: 'HOME_OK' });
    const result = reduceAgingCycle(state, { type: 'TORQUE_SAMPLE', jointId: 'j1', torqueNm: 999 });
    expect(result.accepted).toBe(true);
    expect(result.state.phase).toBe('running_trajectory');
    expect(result.effects[0]).toMatchObject({ type: 'WRITE_EVENT', name: 'torque_sample' });
  });
});
