/**
 * Pure aging-cycle state machine.
 *
 * This module deliberately has no React, clock, timer, telemetry, or API
 * dependency. A caller owns those concerns and feeds observations/events into
 * transitionAgingCycle().
 */

export type AgingCyclePhase =
  | 'preflight'
  | 'initial_homing'
  | 'running_trajectory'
  | 'returning_home'
  | 'verifying_home'
  | 'interval_wait'
  | 'completed'
  | 'held'
  | 'failed'
  | 'stopping';

export type AgingLoopMode = 'count' | 'duration' | 'infinite';
export type CommunicationState = 'connected' | 'lost';

export interface AgingCycleConfig {
  loopMode: AgingLoopMode;
  count?: number;
  durationMs?: number;
  intervalMs: number;
  trajectoryId?: string;
}

export interface AgingCycleState {
  phase: AgingCyclePhase;
  config: AgingCycleConfig | null;
  /** The round currently being or most recently played; zero before start. */
  round: number;
  communication: CommunicationState;
  startedAtMs: number | null;
  verificationReason: 'after_home' | 'next_round' | null;
  completionRequested: boolean;
  holdReason: string | null;
  failureReason: string | null;
  stopReason: string | null;
}

export type AgingCycleEvent =
  | { type: 'START'; config: AgingCycleConfig; atMs?: number }
  | { type: 'HOME_OK'; communicationAvailable?: boolean }
  | { type: 'HOME_TIMEOUT'; communicationAvailable?: boolean; detail?: string }
  | { type: 'TRAJECTORY_COMPLETE' }
  | { type: 'HOME_VERIFIED'; communicationAvailable?: boolean }
  | { type: 'HOME_VERIFY_FAIL'; communicationAvailable?: boolean; detail?: string }
  | { type: 'INTERVAL_ELAPSED' }
  | { type: 'TIME_ELAPSED'; elapsedMs: number }
  | { type: 'STATUS_CODE'; code: number; communicationAvailable?: boolean }
  | { type: 'FOLLOW_ERROR'; error: number; communicationAvailable?: boolean }
  | { type: 'TORQUE_SAMPLE'; jointId?: string; torqueNm: number }
  | { type: 'STOP'; communicationAvailable?: boolean; reason?: string }
  | { type: 'COMMUNICATION_LOST'; detail?: string }
  | { type: 'COMMUNICATION_RESTORED' }
  | { type: 'RECOVER' }
  | { type: 'RESET' };

export type AgingCycleEffect =
  | {
      type: 'REQUEST_HOME';
      reason: 'initial' | 'cycle-complete' | 'stop' | 'recovery';
      round: number;
    }
  | { type: 'PLAY_TRAJECTORY'; round: number; trajectoryId?: string }
  | { type: 'VERIFY_HOME'; reason: 'after-home' | 'next-round' }
  | { type: 'START_INTERVAL'; intervalMs: number; completedRound: number }
  | {
      type: 'WRITE_EVENT';
      name: string;
      detail?: string;
      data?: Readonly<Record<string, string | number | boolean | null>>;
    }
  | { type: 'COMPLETE_SESSION'; completedRounds: number };

export interface AgingCycleTransition {
  accepted: boolean;
  ok: boolean;
  state: AgingCycleState;
  effects: readonly AgingCycleEffect[];
  from: AgingCyclePhase;
  to: AgingCyclePhase;
  event: AgingCycleEvent['type'];
  error?: string;
}

const ACTIVE_PHASES: readonly AgingCyclePhase[] = [
  'initial_homing',
  'running_trajectory',
  'returning_home',
  'verifying_home',
  'interval_wait',
  'stopping',
];

function isActivePhase(phase: AgingCyclePhase): boolean {
  return ACTIVE_PHASES.includes(phase);
}

function event(name: string, detail?: string, data?: Readonly<Record<string, string | number | boolean | null>>): AgingCycleEffect {
  return { type: 'WRITE_EVENT', name, ...(detail === undefined ? {} : { detail }), ...(data === undefined ? {} : { data }) };
}

function initialState(): AgingCycleState {
  return {
    phase: 'preflight',
    config: null,
    round: 0,
    communication: 'connected',
    startedAtMs: null,
    verificationReason: null,
    completionRequested: false,
    holdReason: null,
    failureReason: null,
    stopReason: null,
  };
}

export function createAgingCycleState(): AgingCycleState {
  return initialState();
}

function reject(state: AgingCycleState, input: AgingCycleEvent, error: string): AgingCycleTransition {
  return {
    accepted: false,
    ok: false,
    state,
    effects: [],
    from: state.phase,
    to: state.phase,
    event: input.type,
    error,
  };
}

function move(
  state: AgingCycleState,
  input: AgingCycleEvent,
  next: AgingCycleState,
  effects: readonly AgingCycleEffect[],
): AgingCycleTransition {
  return {
    accepted: true,
    ok: true,
    state: next,
    effects,
    from: state.phase,
    to: next.phase,
    event: input.type,
  };
}

function withPhase(state: AgingCycleState, phase: AgingCyclePhase, changes: Partial<AgingCycleState> = {}): AgingCycleState {
  return { ...state, ...changes, phase };
}

function validateConfig(config: AgingCycleConfig): string | null {
  if (!config || !['count', 'duration', 'infinite'].includes(config.loopMode)) {
    return 'config.loopMode must be count, duration, or infinite';
  }
  if (!Number.isFinite(config.intervalMs) || config.intervalMs < 0) {
    return 'config.intervalMs must be finite and non-negative';
  }
  if (config.loopMode === 'count' && (!Number.isInteger(config.count) || (config.count ?? 0) < 1)) {
    return 'count mode requires a positive integer count';
  }
  if (config.loopMode === 'duration' && (!Number.isFinite(config.durationMs) || (config.durationMs ?? 0) <= 0)) {
    return 'duration mode requires a positive durationMs';
  }
  if (config.loopMode !== 'count' && config.count !== undefined) {
    return 'count is only valid in count mode';
  }
  if (config.loopMode !== 'duration' && config.durationMs !== undefined) {
    return 'durationMs is only valid in duration mode';
  }
  return null;
}

function copyConfig(config: AgingCycleConfig): AgingCycleConfig {
  return { ...config };
}

function communicationAvailable(state: AgingCycleState, input: { communicationAvailable?: boolean }): boolean {
  return state.communication === 'connected' && input.communicationAvailable !== false;
}

function held(state: AgingCycleState, input: AgingCycleEvent, detail: string): AgingCycleTransition {
  const next = withPhase(state, 'held', {
    communication: 'lost',
    holdReason: detail,
    failureReason: null,
  });
  return move(state, input, next, [event('cycle_held', detail)]);
}

function fail(state: AgingCycleState, input: AgingCycleEvent, detail: string): AgingCycleTransition {
  const next = withPhase(state, 'failed', {
    failureReason: detail,
    holdReason: null,
  });
  return move(state, input, next, [event('cycle_failed', detail)]);
}

function fault(
  state: AgingCycleState,
  input: AgingCycleEvent,
  detail: string,
): AgingCycleTransition {
  if ('communicationAvailable' in input && !communicationAvailable(state, input)) {
    return held(state, input, `${detail}; communication unavailable`);
  }
  if (state.communication === 'lost') return held(state, input, `${detail}; communication unavailable`);
  return fail(state, input, detail);
}

function complete(state: AgingCycleState, input: AgingCycleEvent): AgingCycleTransition {
  const next = withPhase(state, 'completed', { holdReason: null, failureReason: null });
  return move(state, input, next, [
    event('session_completed', undefined, { completedRounds: state.round }),
    { type: 'COMPLETE_SESSION', completedRounds: state.round },
  ]);
}

function durationReached(state: AgingCycleState, elapsedMs: number): boolean {
  return state.config?.loopMode === 'duration' && elapsedMs >= (state.config.durationMs ?? Number.POSITIVE_INFINITY);
}

/**
 * Apply exactly one event. Rejected events return the same state object and no
 * effects, making illegal ordering observable without throwing or side effects.
 */
export function transitionAgingCycle(state: AgingCycleState, input: AgingCycleEvent): AgingCycleTransition {
  if (!state || !input) {
    throw new TypeError('state and event are required');
  }

  if (input.type === 'COMMUNICATION_LOST') {
    if (!isActivePhase(state.phase)) return reject(state, input, `communication loss is not legal in ${state.phase}`);
    return held(state, input, input.detail ?? 'communication lost; homing and completion cannot be confirmed');
  }

  if (input.type === 'COMMUNICATION_RESTORED') {
    if (state.phase !== 'held') return reject(state, input, `communication restoration is not legal in ${state.phase}`);
    const next = { ...state, communication: 'connected' as const };
    return move(state, input, next, [event('communication_restored', 'communication is back; explicit RECOVER is required')]);
  }

  if (input.type === 'RECOVER') {
    if (state.phase !== 'held' || state.communication !== 'connected') {
      return reject(state, input, 'RECOVER requires a held state with restored communication');
    }
    const next = withPhase(state, 'initial_homing', {
      round: 0,
      verificationReason: null,
      completionRequested: false,
      holdReason: null,
      failureReason: null,
      stopReason: null,
    });
    return move(state, input, next, [
      event('recovery_started', 'communication restored; starting a new verified home sequence'),
      { type: 'REQUEST_HOME', reason: 'recovery', round: 0 },
    ]);
  }

  if (input.type === 'RESET') {
    if (state.phase !== 'failed') return reject(state, input, `RESET is not legal in ${state.phase}`);
    const next = initialState();
    return move(state, input, next, [event('cycle_reset')]);
  }

  if (input.type === 'START') {
    if (state.phase !== 'preflight') return reject(state, input, `START is not legal in ${state.phase}`);
    const configError = validateConfig(input.config);
    if (configError) return reject(state, input, configError);
    const next = withPhase(state, 'initial_homing', {
      config: copyConfig(input.config),
      round: 0,
      startedAtMs: input.atMs ?? null,
      verificationReason: null,
      completionRequested: false,
      communication: 'connected',
      holdReason: null,
      failureReason: null,
      stopReason: null,
    });
    return move(state, input, next, [
      event('session_started', undefined, { loopMode: input.config.loopMode }),
      { type: 'REQUEST_HOME', reason: 'initial', round: 0 },
    ]);
  }

  if (input.type === 'STOP') {
    if (!isActivePhase(state.phase) || state.phase === 'stopping') {
      return reject(state, input, `STOP is not legal in ${state.phase}`);
    }
    if (!communicationAvailable(state, input)) {
      return held(state, input, 'manual stop requested while communication was unavailable; no home command sent');
    }
    const reason = input.reason ?? 'manual stop';
    const next = withPhase(state, 'stopping', { stopReason: reason });
    return move(state, input, next, [
      event('stop_requested', reason),
      { type: 'REQUEST_HOME', reason: 'stop', round: state.round },
    ]);
  }

  if (input.type === 'TORQUE_SAMPLE') {
    if (!isActivePhase(state.phase)) return reject(state, input, `TORQUE_SAMPLE is not legal in ${state.phase}`);
    return move(state, input, state, [
      event('torque_sample', 'recorded for diagnostics; torque is not a stop threshold', {
        ...(input.jointId === undefined ? {} : { jointId: input.jointId }),
        torqueNm: input.torqueNm,
      }),
    ]);
  }

  if (input.type === 'STATUS_CODE') {
    if (!isActivePhase(state.phase) || state.phase === 'stopping') {
      return reject(state, input, `STATUS_CODE is not legal in ${state.phase}`);
    }
    if (!Number.isFinite(input.code)) return reject(state, input, 'status code must be finite');
    if (input.code === 0) {
      return move(state, input, state, [event('status_code_sample', 'normal status code', { code: input.code })]);
    }
    return fault(state, input, `status code ${input.code}`);
  }

  if (input.type === 'FOLLOW_ERROR') {
    if (!isActivePhase(state.phase) || state.phase === 'stopping') {
      return reject(state, input, `FOLLOW_ERROR is not legal in ${state.phase}`);
    }
    if (!Number.isFinite(input.error)) return reject(state, input, 'follow error must be finite');
    return fault(state, input, `follow error ${input.error}`);
  }

  if (input.type === 'HOME_TIMEOUT') {
    if (!['initial_homing', 'returning_home', 'stopping'].includes(state.phase)) {
      return reject(state, input, `HOME_TIMEOUT is not legal in ${state.phase}`);
    }
    return fault(state, input, input.detail ?? 'homing timeout');
  }

  if (input.type === 'HOME_VERIFY_FAIL') {
    if (state.phase !== 'verifying_home') return reject(state, input, `HOME_VERIFY_FAIL is not legal in ${state.phase}`);
    return fault(state, input, input.detail ?? 'home verification failed');
  }

  if (input.type === 'HOME_OK') {
    if (!communicationAvailable(state, input)) {
      if (isActivePhase(state.phase)) return held(state, input, 'HOME_OK cannot be accepted without communication');
      return reject(state, input, `HOME_OK is not legal in ${state.phase}`);
    }
    if (state.phase === 'initial_homing') {
      const next = withPhase(state, 'running_trajectory', { round: 1 });
      return move(state, input, next, [
        event('initial_home_confirmed'),
        { type: 'PLAY_TRAJECTORY', round: 1, trajectoryId: state.config?.trajectoryId },
      ]);
    }
    if (state.phase === 'returning_home') {
      const next = withPhase(state, 'verifying_home', { verificationReason: 'after_home' });
      return move(state, input, next, [
        event('home_reached_waiting_for_zero_verification'),
        { type: 'VERIFY_HOME', reason: 'after-home' },
      ]);
    }
    if (state.phase === 'stopping') {
      return complete(state, input);
    }
    return reject(state, input, `HOME_OK is not legal in ${state.phase}`);
  }

  if (input.type === 'HOME_VERIFIED') {
    if (state.phase !== 'verifying_home') return reject(state, input, `HOME_VERIFIED is not legal in ${state.phase}`);
    if (!communicationAvailable(state, input)) return held(state, input, 'home verification cannot be accepted without communication');
    const config = state.config;
    if (!config) return reject(state, input, 'an active cycle requires a config');
    if (state.completionRequested) return complete(state, input);
    if (state.verificationReason === 'next_round') {
      const nextRound = state.round + 1;
      const next = withPhase(state, 'running_trajectory', {
        round: nextRound,
        verificationReason: null,
      });
      return move(state, input, next, [
        event('home_still_verified'),
        { type: 'PLAY_TRAJECTORY', round: nextRound, trajectoryId: config.trajectoryId },
      ]);
    }
    if (config.loopMode === 'count' && state.round >= (config.count ?? 0)) return complete(state, input);
    const next = withPhase(state, 'interval_wait', { verificationReason: null });
    return move(state, input, next, [
      event('home_verified'),
      { type: 'START_INTERVAL', intervalMs: config.intervalMs, completedRound: state.round },
    ]);
  }

  if (input.type === 'TRAJECTORY_COMPLETE') {
    if (state.phase !== 'running_trajectory') return reject(state, input, `TRAJECTORY_COMPLETE is not legal in ${state.phase}`);
    const next = withPhase(state, 'returning_home');
    return move(state, input, next, [
      event('trajectory_completed', undefined, { round: state.round }),
      { type: 'REQUEST_HOME', reason: 'cycle-complete', round: state.round },
    ]);
  }

  if (input.type === 'INTERVAL_ELAPSED') {
    if (state.phase !== 'interval_wait') return reject(state, input, `INTERVAL_ELAPSED is not legal in ${state.phase}`);
    const next = withPhase(state, 'verifying_home', { verificationReason: 'next_round' });
    return move(state, input, next, [
      event('interval_elapsed_checking_home'),
      { type: 'VERIFY_HOME', reason: 'next-round' },
    ]);
  }

  if (input.type === 'TIME_ELAPSED') {
    if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) return reject(state, input, 'elapsedMs must be finite and non-negative');
    if (state.config?.loopMode !== 'duration') return reject(state, input, 'TIME_ELAPSED is only legal in duration mode');
    if (!durationReached(state, input.elapsedMs)) return reject(state, input, 'duration has not been reached');
    if (state.phase === 'running_trajectory') {
      const next = withPhase(state, 'returning_home', { completionRequested: true });
      return move(state, input, next, [
        event('duration_reached'),
        { type: 'REQUEST_HOME', reason: 'cycle-complete', round: state.round },
      ]);
    }
    if (state.phase === 'interval_wait') return complete(state, input);
    return reject(state, input, `TIME_ELAPSED is not legal in ${state.phase}`);
  }

  return reject(state, input as AgingCycleEvent, 'unsupported event');
}

export const reduceAgingCycle = transitionAgingCycle;
export const createInitialAgingCycleState = createAgingCycleState;
