import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import URDFLoader from 'urdf-loader';
import type { URDFRobot } from 'urdf-loader';
import { useTelemetry } from '../../state/TelemetryContext';
import { computeRobotJointWrites } from '../../telemetry/jointTransform';
import type { ArmConfig } from '../../telemetry/jointTransform';
import type { TelemetryFrame } from '../../types';

/**
 * 使用 urdf-loader 加载机械臂模型（URDF 来自激活机型的 model.urdf）。
 * - URDF 位于 public 目录：/robots/<arm_id>/model.urdf
 * - motor 的 position（rad）按「有依据的显式变换」映射到 URDF 关节：
 *   urdf = raw * scale * direction + offset（当前为恒等变换，依据见
 *   telemetry/jointTransform.ts），并应用机型限位（超限告警由页面展示，
 *   写入模型的为截断值，仅用于渲染）。
 * - 夹爪：标定依据缺失（传动比/左右方向/机械零位/最大开度），
 *   不产生任何 joint_left/joint_right 写入 —— 夹爪模型动画暂停，
 *   绝不以 clamp01 等方式伪造开度。
 * - 数据陈旧（stale）时停止更新 URDF，不继续用最后一帧冒充实时状态
 * - URDF 为 Z-up 坐标系，因此绕 X 轴旋转 -90° 对齐 three.js 的 Y-up 场景
 */

interface ArmModelProps {
  /** 离线预览用：按 [J1..JN] 关节位置驱动 Web 模型，不产生任何控制调用。 */
  overridePositions?: readonly number[] | null;
  /**
   * 可选稳定回调：URDF 加载完成后，回传模型包围盒中心（场景坐标）。
   * 相机取景以该中心为目标，保证模型始终位于三维视窗正中间。
   */
  onModelCenter?: (center: [number, number, number]) => void;
  /** URDF 地址（由激活机型派生） */
  urdfUrl: string;
  /** 模型缩放 / Z-up 旋转 / 场景平移（来自机型配置） */
  modelScale: number;
  modelRotationX: number;
  modelPosition: [number, number, number];
  /** 关节映射配置（来自机型配置） */
  config: ArmConfig;
}

/**
 * 机型 mesh 解析/上传缓存，keyed by urdfUrl。
 *
 * 页面切换（模型/监控/动作）会反复挂载卸载 ArmModel —— 每台机型的
 * URDF+STL 有数 MB，urdf-loader 同步反序列化（parseBinary）+ three.js
 * 建几何/包围球 + GPU 上传在主线程是好几秒的阻塞，弱 CPU（Jetson）上
 * 表现为切页"卡死"。首次按机型解析一次后缓存，之后切换页面直接复用
 * （THREE.Group 可跨场景重新挂载），卸载时不释放。
 */
const robotCache = new Map<string, URDFRobot>();

function boundingCenterOf(
  robot: URDFRobot,
  modelScale: number,
  modelRotationX: number,
  modelPosition: [number, number, number],
): [number, number, number] {
  // 模型局部坐标下的实际包围盒中心，再应用与渲染 group 完全一致的变换
  // （先缩放 → 绕 X 轴旋转 → 平移），回传场景坐标中心用于相机取景。
  // formula: center_scene = modelPosition + R_x(modelRotationX) · (modelScale · center_local)
  const localCenter = new THREE.Box3()
    .setFromObject(robot)
    .getCenter(new THREE.Vector3());
  const sceneCenter = localCenter
    .multiplyScalar(modelScale)
    .applyAxisAngle(new THREE.Vector3(1, 0, 0), modelRotationX)
    .add(new THREE.Vector3(...modelPosition));
  return [sceneCenter.x, sceneCenter.y, sceneCenter.z];
}

/**
 * 解析并缓存一台机型的 URDF（解析 + Mesh 开启阴影）。命中缓存直接返回。
 * 异步执行；主要用于开机预热（见 prefetchArmModel），也供 ArmModel 挂载时调用。
 */
function loadIntoCache(urdfUrl: string): Promise<URDFRobot | undefined> {
  const cached = robotCache.get(urdfUrl);
  if (cached) return Promise.resolve(cached);
  const loader = new URDFLoader();
  return loader.loadAsync(urdfUrl).then((loaded) => {
    loaded.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    robotCache.set(urdfUrl, loaded);
    return loaded;
  });
}

/**
 * 开机预热：应用启动时（空闲期）异步解析激活机型的 URDF 进缓存，
 * 用户随后首次进入需要 3D 视窗的页面（监控/动作中心）时直接复用缓存，
 * 不再在主线程同步解析数 MB 的 STL mesh —— 消除冷启动切页卡顿。
 * 失败静默忽略（页面首次挂载时仍会自行加载并展示错误）。
 */
export function prefetchArmModel(urdfUrl: string): void {
  void loadIntoCache(urdfUrl).catch(() => {});
}

/** 按遥测帧驱动 URDF 关节（显式变换 + 机型限位，见 telemetry/jointTransform.ts）。 */
function applyFrameToRobot(robot: URDFRobot, frame: TelemetryFrame, config: ArmConfig): void {
  // 夹爪未标定时 computeRobotJointWrites 不会返回 gripper 写入 → 动画暂停
  const { writes } = computeRobotJointWrites(frame.joints, config);
  for (const w of writes) {
    const urdf = robot.joints[w.jointName];
    if (urdf) urdf.setJointValue(w.value);
  }
}

function applyOverrideToRobot(robot: URDFRobot, positions: readonly number[], config: ArmConfig): void {
  const { writes } = computeRobotJointWrites(
    positions.map((position, index) => ({ id: config.revoluteIds[index] ?? index + 1, position })),
    config,
  );
  for (const w of writes) {
    const urdf = robot.joints[w.jointName];
    if (urdf) urdf.setJointValue(w.value);
  }
}

export function ArmModel({
  onModelCenter,
  overridePositions = null,
  urdfUrl,
  modelScale,
  modelRotationX,
  modelPosition,
  config,
}: ArmModelProps) {
  const { frame, stale } = useTelemetry();
  const [robot, setRobot] = useState<URDFRobot | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 用 ref 保存最新回调：中心只在加载完成时回传一次，
  // 避免回调引用变化导致模型被重新加载
  const onModelCenterRef = useRef(onModelCenter);
  useEffect(() => {
    onModelCenterRef.current = onModelCenter;
  }, [onModelCenter]);

  // 使用共享缓存加载 URDF（见 loadIntoCache）；跨页面挂载复用已解析的 mesh，
  // 卸载时不释放 —— mesh 解析 / GPU 上传只做一次，避免切页卡死。
  useEffect(() => {
    let disposed = false;

    loadIntoCache(urdfUrl).then((loaded) => {
      if (!loaded || disposed) return;
      onModelCenterRef.current?.(boundingCenterOf(loaded, modelScale, modelRotationX, modelPosition));
      setRobot(loaded);
    }).catch((err: unknown) => {
      if (!disposed) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

    return () => {
      disposed = true;
    };
  }, [urdfUrl, modelScale, modelRotationX, modelPosition]);

  // 根据遥测帧驱动关节；数据陈旧时停止更新（不继续用最后一帧冒充实时状态）
  useEffect(() => {
    if (!robot) return;
    if (overridePositions && overridePositions.length >= config.revoluteIds.length) {
      applyOverrideToRobot(robot, overridePositions, config);
      return;
    }
    if (!frame || stale) return;
    applyFrameToRobot(robot, frame, config);
  }, [robot, frame, stale, overridePositions, config]);

  if (error) {
    return (
      <Html center>
        <div style={{ color: '#ef4444', fontSize: 14, whiteSpace: 'nowrap' }}>
          机械臂模型加载失败：{error}
        </div>
      </Html>
    );
  }

  if (!robot) {
    return (
      <Html center>
        <div style={{ color: '#94a3b8', fontSize: 14, whiteSpace: 'nowrap' }}>
          机械臂模型加载中…
        </div>
      </Html>
    );
  }

  return (
    <group
      position={modelPosition}
      rotation={[modelRotationX, 0, 0]}
      scale={modelScale}
    >
      <primitive object={robot} />
    </group>
  );
}
