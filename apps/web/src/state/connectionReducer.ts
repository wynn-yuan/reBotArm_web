/**
 * 连接状态纯 reducer（与 React 解耦，便于单元测试）。
 *
 * 仅处理后端连接快照的落库与本地请求/错误标志。
 * 字段一律来自后端返回（CONNECTION_SET / SAFETY_DISCONNECT_DONE 的 payload）。
 * 能力（capabilities）未由后端返回时按 source 派生：simulation → 全开，其余 → fail closed。
 */
import type { ConnectionState, RobotCapabilities, RobotConnection } from '../types';
import { FAIL_CLOSED_CAPABILITIES } from '../types';
import { capabilitiesForSource } from './readOnly';

export const INITIAL_CONNECTION: ConnectionState = {
  status: 'disconnected',
  channel: 'can0',
  expected_ids: [1, 2, 3, 4, 5, 6, 7],
  found_ids: [],
  missing_ids: [],
  started_at: null,
  completed_at: null,
  source: null,
  message: null,
  scanning: false,
  error: null,
  syncedAt: null,
  capabilities: FAIL_CLOSED_CAPABILITIES,
};

/** 后端返回 capabilities 则直接采用（api client 已做 fail-closed 严格解析）；
 *  未返回时按 source 派生（fail closed）。 */
export function capabilitiesFor(payload: RobotConnection): RobotCapabilities {
  if (payload.capabilities) return payload.capabilities;
  return capabilitiesForSource(payload.source);
}

export type ConnectionAction =
  | { type: 'CONNECTION_SET'; payload: RobotConnection }
  | { type: 'CONNECTION_SCAN_START' }
  | { type: 'CONNECTION_ERROR'; payload: { error: string } };

export function connectionReducer(state: ConnectionState, action: ConnectionAction): ConnectionState {
  switch (action.type) {
    case 'CONNECTION_SET':
      // 完全采用后端返回的字段；能力未返回时按 source 派生（fail closed）
      return {
        ...action.payload,
        capabilities: capabilitiesFor(action.payload),
        scanning: false,
        error: null,
        syncedAt: Date.now(),
      };
    case 'CONNECTION_SCAN_START':
      // 仅本地请求在途标志（后端 status 保持最后一次结果）
      return { ...state, scanning: true, error: null };
    case 'CONNECTION_ERROR':
      return { ...state, scanning: false, error: action.payload.error };
    default:
      return state;
  }
}