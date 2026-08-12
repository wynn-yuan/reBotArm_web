import { useEffect, useRef } from 'react';
import { useApp } from './AppContext';
import { useTelemetry } from './TelemetryContext';

/**
 * 老化运行时监视器：全局常驻组件，挂载于 AppShell（TelemetryProvider 内）。
 *
 * 职责（独立于 AgingPage 的生命周期，切换页面后持续运行）：
 * 1. 循环计数推进（按启动时锁定的配置快照 state.aging.config 推算）；
 * 2. 自动完成判定：按次数 / 按时长到达后请求受控回零并失能；
 *    无限时长（infinite）不存在自动完成条件；
 * 3. 200ms 通信 freshness 看门狗与 fault / statusCode 状态保护：
 *    - 通信超时：链路可用性无法确认 → 停止老化并进入 communication-lost
 *      安全保持，不请求、也不模拟回零；
 *    - 电机 fault 或状态码命中：控制链路可用 → 请求既有受控回零并失能。
 *
 * 每次老化运行最多触发一次终止（firedRef / finishedRef）。
 * 本组件只驱动状态，不渲染任何 UI。
 */

/** 循环计数推进节拍（ms） */
const TICK_MS = 500;
/** 保护检查节拍（ms）；独立于遥测刷新，遥测停滞时也能判定超时 */
const PROTECTION_CHECK_MS = 200;

export function AgingRuntimeMonitor() {
  const {
    state,
    readOnly,
    agingTick,
    setAgingNote,
    requestHomingAndDisable,
    haltForCommunicationLoss,
    pushLog,
  } = useApp();
  const { joints, comm } = useTelemetry();

  // 真机只读：老化被禁用，本监视器不得使用遥测推进任何老化/保护逻辑。
  if (readOnly) return null;

  const aging = state.controlMode === 'aging' ? state.aging : null;
  const isAging = aging !== null;
  // 锁定的运行配置快照（运行期间引用稳定，不随 AGING_TICK 变化）
  const agingConfig = aging?.config ?? null;
  const startedAt = aging?.startedAt ?? null;

  // 最新通信到达时间 / 关节 ref：保护节拍 effect 不必随每帧遥测重建
  const lastArrivalRef = useRef(comm.lastArrivalMs);
  lastArrivalRef.current = comm.lastArrivalMs;
  const jointsRef = useRef(joints);
  jointsRef.current = joints;

  // 每次老化运行：自动完成与保护终止各最多一次
  const finishedRef = useRef(false);
  const firedRef = useRef(false);
  useEffect(() => {
    if (!isAging) {
      finishedRef.current = false;
      firedRef.current = false;
    }
  }, [isAging]);

  // ---- 1) 循环计数推进（演示用：elapsed / 每次循环用时） ----
  useEffect(() => {
    if (!isAging || startedAt === null || !agingConfig) return;
    const action = state.recordedActions.find((a) => a.id === agingConfig.actionId) ?? null;
    const each = Math.max(2, agingConfig.loopIntervalSec + (action ? action.durationMs / 1000 : 6));
    const interval = window.setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      agingTick(Math.max(0, Math.floor(elapsed / each)));
    }, TICK_MS);
    return () => window.clearInterval(interval);
  }, [isAging, startedAt, agingConfig, state.recordedActions, agingTick]);

  // ---- 2) 自动完成：循环次数到达 / 持续时长到达 → 统一回零 ----
  // infinite 模式 totalLoops = 0 且 endAt = null，永不自动完成。
  useEffect(() => {
    if (!isAging || !aging) return;
    if (finishedRef.current || firedRef.current) return;
    let done = false;
    if (aging.totalLoops > 0 && aging.loopsCompleted >= aging.totalLoops) done = true;
    if (aging.endAt !== null && Date.now() >= aging.endAt) done = true;
    if (!done) return;
    finishedRef.current = true;
    const totalLoops = aging.totalLoops || aging.loopsCompleted;
    setAgingNote(`老化已达到目标（${totalLoops} 次），自动进入回零序列`);
    pushLog({
      type: 'aging',
      result: 'success',
      title: '老化自动完成',
      detail: `达到目标（${totalLoops} 次），请求受控回零并失能`,
    });
    requestHomingAndDisable('business-end');
  }, [isAging, aging, setAgingNote, pushLog, requestHomingAndDisable]);

  // ---- 3) 通信 / 状态保护（每次老化运行最多触发一次） ----
  // 通信丢失优先判定：链路状态未知时不得声称回零成功。
  useEffect(() => {
    if (!isAging || !agingConfig) return;
    const interval = window.setInterval(() => {
      if (firedRef.current || finishedRef.current) return;
      const lastArrival = lastArrivalRef.current;

      // ---- 通信丢失：freshness = Date.now() - lastArrivalMs ----
      const freshness = lastArrival !== null ? Date.now() - lastArrival : Number.POSITIVE_INFINITY;
      if (agingConfig.stopOnCommunicationLoss && freshness > agingConfig.communicationLossTimeoutMs) {
        firedRef.current = true;
        pushLog({
          type: 'aging',
          result: 'error',
          title: '通信超时保护触发',
          detail: `遥测已 ${Math.round(freshness)}ms 未更新（阈值 ${agingConfig.communicationLossTimeoutMs}ms）；链路可用性无法确认，未下发回零指令，老化进入安全保持`,
          meta: { freshnessMs: Math.round(freshness), timeoutMs: agingConfig.communicationLossTimeoutMs },
        });
        setAgingNote('检测到通信超时：无法确认控制链路，未下发回零指令，已进入“通信丢失”安全保持');
        haltForCommunicationLoss();
        return;
      }

      // ---- 状态码 / 关节静默（链路可用 → 受控回零并失能） ----
      const reasons: string[] = [];
      const affected: string[] = [];
      const currentJoints = jointsRef.current;
      if (agingConfig.stopOnStatusCode) {
        const codeSet = new Set(agingConfig.triggerStatusCodes);
        currentJoints.forEach((j) => {
          if (j.statusCode !== null && codeSet.has(j.statusCode)) {
            reasons.push(`关节 ${j.id} 状态码 ${j.statusCode}`);
            affected.push(`${j.id}(码${j.statusCode})`);
          }
        });
      }
      if (reasons.length > 0) {
        firedRef.current = true;
        pushLog({
          type: 'aging',
          result: 'error',
          title: '状态保护触发，停止老化',
          detail: `${reasons.join('；')}；控制链路可用，请求受控回零并失能`,
          meta: { affected: affected.join(','), motorCount: affected.length },
        });
        setAgingNote(`检测到 ${reasons.join('；')}，已停止老化并请求受控回零`);
        requestHomingAndDisable('aging-fault');
      }
    }, PROTECTION_CHECK_MS);
    return () => window.clearInterval(interval);
  }, [isAging, agingConfig, pushLog, setAgingNote, haltForCommunicationLoss, requestHomingAndDisable]);

  // 常驻监视器不渲染任何 UI
  return null;
}
