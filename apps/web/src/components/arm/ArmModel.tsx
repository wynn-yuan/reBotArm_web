import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import URDFLoader from 'urdf-loader';
import type { URDFRobot } from 'urdf-loader';
import { useTelemetry } from '../../state/TelemetryContext';
import { JOINT_TABLE } from '../../data/simulatedTelemetry';
import { computeRobotJointWrites } from '../../telemetry/jointTransform';
import type { TelemetryFrame } from '../../types';

/**
 * 使用 urdf-loader 加载真实机械臂模型（rebot-b601-rs）。
 * - URDF 位于 public 目录：/robots/rebot-b601-rs/model.urdf
 * - motor 1..6 的 position（rad）按「有依据的显式变换」映射到 joint1..joint6：
 *   urdf = raw * scale * direction + offset（当前为恒等变换，依据见
 *   telemetry/jointTransform.ts），并应用 URDF 限位（超限告警由页面展示，
 *   写入模型的为截断值，仅用于渲染）。
 * - motor 7（夹爪）：标定依据缺失（传动比/左右方向/机械零位/最大开度），
 *   不产生任何 joint_left/joint_right 写入 —— 夹爪模型动画暂停，
 *   绝不以 clamp01 等方式伪造开度。
 * - 数据陈旧（stale）时停止更新 URDF，不继续用最后一帧冒充实时状态
 * - URDF 为 Z-up 坐标系，因此绕 X 轴旋转 -90° 对齐 three.js 的 Y-up 场景
 */

const URDF_URL = '/robots/rebot-b601-rs/model.urdf';

/** 模型缩放系数（URDF 单位为米，适当放大以匹配场景观感） */
const MODEL_SCALE = 2.5;

/** URDF 为 Z-up 坐标系，绕 X 轴旋转 -90° 对齐 three.js 的 Y-up 场景 */
const MODEL_ROTATION_X = -Math.PI / 2;

/** 渲染 group 在场景坐标中的平移（机器人基座放置于地面 y=-1.2） */
const MODEL_POSITION: [number, number, number] = [0, -1.2, 0];

/**
 * 中心换算专用的轴向与平移向量。
 * 注意：这里与上方渲染 group 的 scale/rotation/position 使用同一组常量，
 * 保证"回传的包围盒中心"与"实际渲染位置"严格一致，避免参数漂移。
 */
const X_AXIS: THREE.Vector3 = new THREE.Vector3(1, 0, 0);
const MODEL_POSITION_VECTOR: THREE.Vector3 = new THREE.Vector3(...MODEL_POSITION);

interface ArmProps {
  /** 离线预览用：按 [J1..J7] 关节位置驱动 Web 模型，不产生任何控制调用。 */
  overridePositions?: readonly number[] | null;
  /**
   * 可选稳定回调：URDF 加载完成后，回传模型包围盒中心（场景坐标）。
   * 相机取景以该中心为目标，保证模型始终位于三维视窗正中间。
   */
  onModelCenter?: (center: [number, number, number]) => void;
}

/** 按遥测帧驱动 URDF 关节（显式变换 + URDF 限位，见 telemetry/jointTransform.ts）。 */
function applyFrameToRobot(robot: URDFRobot, frame: TelemetryFrame): void {
  // 夹爪未标定时 computeRobotJointWrites 不会返回 gripper 写入 → 动画暂停
  const { writes } = computeRobotJointWrites(frame.joints);
  for (const w of writes) {
    const urdf = robot.joints[w.jointName];
    if (urdf) urdf.setJointValue(w.value);
  }
}

function applyOverrideToRobot(robot: URDFRobot, positions: readonly number[]): void {
  const { writes } = computeRobotJointWrites(
    positions.map((position, index) => ({ id: index + 1, position })),
  );
  for (const w of writes) {
    const urdf = robot.joints[w.jointName];
    if (urdf) urdf.setJointValue(w.value);
  }
}

export function ArmModel({ onModelCenter, overridePositions = null }: ArmProps) {
  const { frame, stale } = useTelemetry();
  const [robot, setRobot] = useState<URDFRobot | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 用 ref 保存最新回调：中心只在加载完成时回传一次，
  // 避免回调引用变化导致模型被重新加载
  const onModelCenterRef = useRef(onModelCenter);
  useEffect(() => {
    onModelCenterRef.current = onModelCenter;
  }, [onModelCenter]);

  // 异步加载 URDF；卸载后通过 disposed 标记防止 setState，并释放几何/材质资源
  useEffect(() => {
    let disposed = false;
    let loadedRobot: URDFRobot | null = null;

    const loader = new URDFLoader();
    loader
      .loadAsync(URDF_URL)
      .then((loaded) => {
        // 所有 Mesh 开启阴影
        loaded.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          }
        });

        if (disposed) {
          disposeRobot(loaded);
          return;
        }

        // 计算模型局部坐标下的实际包围盒中心，再应用与渲染 group 完全一致的
        // 变换（先缩放 → 绕 X 轴旋转 → 平移），回传场景坐标中心用于相机取景。
        // 公式：center_scene = MODEL_POSITION + R_x(MODEL_ROTATION_X) · (MODEL_SCALE · center_local)
        const localCenter = new THREE.Box3()
          .setFromObject(loaded)
          .getCenter(new THREE.Vector3());
        const sceneCenter = localCenter
          .multiplyScalar(MODEL_SCALE)
          .applyAxisAngle(X_AXIS, MODEL_ROTATION_X)
          .add(MODEL_POSITION_VECTOR);

        loadedRobot = loaded;
        setRobot(loaded);
        onModelCenterRef.current?.([sceneCenter.x, sceneCenter.y, sceneCenter.z]);
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      disposed = true;
      if (loadedRobot) {
        disposeRobot(loadedRobot);
      }
    };
  }, []);

  // 根据遥测帧驱动关节；数据陈旧时停止更新（不继续用最后一帧冒充实时状态）
  useEffect(() => {
    if (!robot) return;
    if (overridePositions && overridePositions.length >= 6) {
      applyOverrideToRobot(robot, overridePositions);
      return;
    }
    if (!frame || stale) return;
    applyFrameToRobot(robot, frame);
  }, [robot, frame, stale, overridePositions]);

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
      position={MODEL_POSITION}
      rotation={[MODEL_ROTATION_X, 0, 0]}
      scale={MODEL_SCALE}
    >
      <primitive object={robot} />
    </group>
  );
}

function disposeRobot(robot: URDFRobot): void {
  robot.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        material.dispose();
      }
    }
  });
}

export const ARM_JOINT_LABELS = JOINT_TABLE.map((j) => ({ id: j.id, label: j.label, name: j.name }));
