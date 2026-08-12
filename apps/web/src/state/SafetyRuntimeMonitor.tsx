import { useEffect, useRef } from 'react';
import { useApp } from './AppContext';
import { useTelemetry } from './TelemetryContext';
import { postDisconnect, toErrorMessage } from '../api/client';

/**
 * 统一安全状态机运行时驱动器：全局常驻，挂载于 AppShell（TelemetryProvider 内）。
 *
 * 职责：把「停止任务 → 回零 → 失能 → 断开/空闲」序列按阶段推进，
 * 并在每一阶段依据遥测实时校验通信是否可用。
 *
 * 安全语义保证：
 * - 通信可用时才推进到下一阶段；通信失联（freshness 超阈值）时不得盲目模拟
 *   "已回零 / 已失能 / 已断开"，而是转入通信丢失安全保持（hold_comm_lost）。
 * - 回零 / 失能失败走 SAFETY_HOMING_FAIL / SAFETY_DISABLE_FAIL 进入保持态，
 *   由人工处理后再重试（本组件默认不触发失败，保留给真实后端逐步返回结果）。
 *
 * 本组件只驱动状态，不渲染任何 UI。
 */

/** 安全序列各阶段时长（ms，模拟） */
const STOP_MS = 500;
const HOMING_MS = 2500;
const DISABLE_MS = 900;
/** 遥测新鲜度阈值：超过该时长视为通信失联 */
const COMM_FRESH_MS = 1500;

export function SafetyRuntimeMonitor() {
  const {
    state,
    readOnly,
    safetyStopTaskDone,
    safetyHomingProgress,
    safetyHomingOk,
    safetyDisableDone,
    safetyCommLost,
    safetyDisconnectDone,
    safetyDisconnectFail,
  } = useApp();
  const { comm } = useTelemetry();

  const status = state.safety.status;

  // 真机只读：无控制能力，绝不使用遥测推进回零/失能/断开序列。
  if (readOnly) return null;

  // 最新通信到达时间 ref：不随每帧重建 effect
  const lastArrivalRef = useRef(comm.lastArrivalMs);
  lastArrivalRef.current = comm.lastArrivalMs;

  const isCommFresh = () => {
    const last = lastArrivalRef.current;
    return last !== null && Date.now() - last <= COMM_FRESH_MS;
  };

  // 阶段 1：stopping → homing（若通信失联则转安全保持，不盲目推进）
  useEffect(() => {
    if (status !== 'stopping') return;
    const t = window.setTimeout(() => {
      if (!isCommFresh()) {
        safetyCommLost('正在停止任务时通信失联：无法确认任务已停止，未下发回零，进入通信丢失安全保持');
        return;
      }
      safetyStopTaskDone();
    }, STOP_MS);
    return () => window.clearTimeout(t);
  }, [status, safetyStopTaskDone, safetyCommLost]);

  // 阶段 2：homing → 进度推进 → disabling（每拍校验通信，失联则转保持）
  useEffect(() => {
    if (status !== 'homing') return;
    const start = Date.now();
    const iv = window.setInterval(() => {
      if (!isCommFresh()) {
        window.clearInterval(iv);
        safetyCommLost('回零过程中通信失联：未确认到位，停止回零，进入通信丢失安全保持');
        return;
      }
      const p = Math.min(1, (Date.now() - start) / HOMING_MS);
      if (p >= 1) {
        window.clearInterval(iv);
        safetyHomingOk();
      } else {
        safetyHomingProgress(p);
      }
    }, 100);
    return () => window.clearInterval(iv);
  }, [status, safetyHomingProgress, safetyHomingOk, safetyCommLost]);

  // 阶段 3：disabling → done（校验通信后再确认失能完成）
  useEffect(() => {
    if (status !== 'disabling') return;
    const t = window.setTimeout(() => {
      if (!isCommFresh()) {
        safetyCommLost('失能过程中通信失联：未确认失能完成，进入通信丢失安全保持');
        return;
      }
      safetyDisableDone();
    }, DISABLE_MS);
    return () => window.clearTimeout(t);
  }, [status, safetyDisableDone, safetyCommLost]);

  // 阶段 4：disconnecting → 调用 POST /api/robot/disconnect（仅手动断开到达此处）。
  // 仅在回零 + 失能都完成后才调用；失败则进入失能/断开失败保持，绝不显示"已安全断开"。
  useEffect(() => {
    if (status !== 'disconnecting') return;
    let cancelled = false;
    postDisconnect()
      .then((conn) => {
        if (!cancelled) safetyDisconnectDone(conn);
      })
      .catch((err) => {
        if (!cancelled) safetyDisconnectFail(toErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [status, safetyDisconnectDone, safetyDisconnectFail]);

  // 常驻监视器不渲染任何 UI
  return null;
}