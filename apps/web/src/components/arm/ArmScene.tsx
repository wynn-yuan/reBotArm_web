import { useLayoutEffect, useMemo, useRef } from 'react';
import { useTelemetry } from '../../state/TelemetryContext';
import { useApp } from '../../state/AppContext';
import { armConfigFromModel, computeRobotJointWrites } from '../../telemetry/jointTransform';
import type { ArmModel } from '../../types';
import { useArmViewport, type ArmSlotConfig, type ArmView, type ArmFrameloop } from './ArmViewport';

export type { ArmView, ArmFrameloop } from './ArmViewport';

export interface ArmSceneProps {
  height?: number | string;
  /** 取景方式：透视（斜 45° 全貌）或正视（正前方） */
  view?: ArmView;
  /** 仅覆盖 Web 模型的离线预览姿态；不调用 API 或真机。 */
  overridePositions?: readonly number[] | null;
  /** 指定要渲染的机型（缺省为当前激活机型）。首页卡片预览用。 */
  arm?: ArmModel | null;
  /**
   * 渲染帧策略（透传给常驻单例 Canvas，仅本槽位挂载期间生效）：
   * - 'always'：每帧无条件重绘 —— 弱 GPU（Jetson 软件 GL）下整场景
   *   （阴影 + 抗锯齿 + dpr 2）单帧就要数百毫秒，静态画面也会把主线程
   *   占满导致卡死，引擎默认即此，仅实时遥测视窗沿用。
   * - 'demand'：仅在姿态/取景真正变化时重绘一帧（见 DemandInvalidator），
   *   交互视窗与离线预览（动作中心）翻页/静止时零重绘。
   */
  frameloop?: ArmFrameloop;
}

/**
 * 实时/离线 3D 视窗。真正的 Canvas 由 ArmViewportProvider 单例常驻，
 * 本组件只是「槽位」：把自己挂载到场景，publish 渲染配置后经 portal
 * 把单例 Canvas 渲染进自身 DOM，卸载时退回隐藏回退槽 —— 页面切换只
 * 移动场景节点，不新建/销毁 GL 上下文，消除「每次进入动作中心卡死」。
 */
export function ArmScene({ height = '100%', view = 'perspective', overridePositions = null, arm = null, frameloop = 'always' }: ArmSceneProps) {
  const { frame, comm, stale, wsStatus } = useTelemetry();
  const { activeArm } = useApp();
  const displayedArm = arm ?? activeArm;
  const armCfg = useMemo(() => armConfigFromModel(displayedArm), [displayedArm]);

  const { register, update, unregister, webgl } = useArmViewport();
  const slotRef = useRef<HTMLDivElement | null>(null);

  // 槽位配置：显示机型参数 + 取景/帧策略（随 displayedArm/override 变化）
  const slotConfig = useMemo<ArmSlotConfig>(() => ({
    urdfUrl: displayedArm ? `/robots/${displayedArm.armId}/model.urdf` : '/robots/rebot-b601-rs/model.urdf',
    modelScale: displayedArm?.modelScale ?? 2.5,
    modelRotationX: displayedArm?.modelRotationX ?? -Math.PI / 2,
    modelPosition: displayedArm?.modelPosition ?? [0, -1.2, 0],
    armCfg,
    view,
    overridePositions,
    frameloop,
  }), [displayedArm, armCfg, view, overridePositions, frameloop]);

  // 槽位生命周期：挂载时注册一次（portal 进入本 DOM），卸载退回过退槽。
  // 依赖只有稳定回调，不随配置变化重建槽位 —— 初始配置经 ref 读取。
  const initialConfigRef = useRef(slotConfig);
  useLayoutEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    register(el, initialConfigRef.current);
    return () => unregister(el);
  }, [register, unregister]);

  // 配置变化（预览播放/拖动进度条，可高频）：只更新配置，不重建槽位
  useLayoutEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    update(el, slotConfig);
  }, [update, slotConfig]);

  // 超限关节与夹爪标定状态（只读纯函数，供叠加层告警）
  const mapResult = useMemo(() => {
    const revoluteIds = armCfg.revoluteIds;
    if (overridePositions && overridePositions.length >= revoluteIds.length) {
      return computeRobotJointWrites(
        revoluteIds.map((id, index) => ({ id, position: overridePositions[index] ?? null })),
        armCfg,
      );
    }
    return frame ? computeRobotJointWrites(frame.joints, armCfg) : null;
  }, [frame, overridePositions, armCfg]);

  return (
    <div ref={slotRef} className="arm-viewport" style={{ height }}>
      {/* 单例 Canvas 经 portal 渲染进此处（ArmViewportProvider） */}

      {/* 无 WebGL（本机 Firefox 无 /dev/dri 时不支持硬件加速）：3D 视窗降级为占位，
          遥测/控制等其余功能不受影响，避免 r3f 抛错掀翻整棵应用树。 */}
      {!webgl && (
        <div className="arm-viewport__fallback">
          <div className="arm-viewport__fallback-title">3D 视窗不可用</div>
          <div className="arm-viewport__fallback-hint">
            当前浏览器未开启 WebGL（本机 Firefox 因缺少 /dev/dri 无法创建 GL 上下文）。
            建议改用 Chrome 查看 3D 模型；遥测与运动控制等其余功能不受影响。
          </div>
        </div>
      )}

      {/* 视窗叠加信息 */}
      <div className="arm-viewport__overlay">
        <div className="arm-viewport__overlay-row">
          {overridePositions ? '离线预览姿态' : '数据时间'}：{overridePositions ? '本地轨迹' : frame ? new Date(frame.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}
        </div>
        <div className="arm-viewport__overlay-row">
          通信频率：{comm.freq.toFixed(1)} Hz
        </div>
        <div className="arm-viewport__overlay-row">
          延迟：{comm.latencyMs.toFixed(1)} ms · 丢帧 {(comm.dropRate * 100).toFixed(2)}%
        </div>
        {stale && (
          <div className="arm-viewport__overlay-row" style={{ color: '#c41e2f' }}>
            通信异常：数据陈旧，已暂停更新
          </div>
        )}
        {mapResult && mapResult.outOfLimitIds.length > 0 && (
          <div className="arm-viewport__overlay-row" style={{ color: '#c41e2f' }}>
            超出 URDF 限位：{mapResult.outOfLimitIds.map((id) => `J${id}`).join('、')}
          </div>
        )}
        {mapResult && !mapResult.gripper.calibrated && (
          <div className="arm-viewport__overlay-row" style={{ color: '#b45309' }}>
            夹爪映射待标定：模型动画已暂停
          </div>
        )}
        {wsStatus === 'connecting' && (
          <div className="arm-viewport__overlay-row">正在连接遥测…</div>
        )}
        {wsStatus === 'error' && (
          <div className="arm-viewport__overlay-row" style={{ color: '#c41e2f' }}>
            遥测连接异常
          </div>
        )}
      </div>

      <div className="arm-viewport__legend">
        <div className="arm-viewport__legend-row">
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              background: '#14b8a6',
              borderRadius: 2,
            }}
          />
          <span>关节执行器</span>
        </div>
        <div className="arm-viewport__legend-row">
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              background: '#3a4655',
              borderRadius: 2,
            }}
          />
          <span>连杆</span>
        </div>
        <div className="arm-viewport__legend-row" style={{ color: 'var(--text-tertiary)' }}>
          鼠标拖动旋转 · 滚轮按指针位置缩放
        </div>
      </div>
    </div>
  );
}