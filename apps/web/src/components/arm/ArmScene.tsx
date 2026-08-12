import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import { ArmModel } from './ArmModel';
import { useTelemetry } from '../../state/TelemetryContext';
import { computeRobotJointWrites } from '../../telemetry/jointTransform';

export type ArmView = 'perspective' | 'front';

export interface ArmSceneProps {
  height?: number | string;
  /** 取景方式：透视（斜 45° 全貌）或正视（正前方） */
  view?: ArmView;
  /** 仅覆盖 Web 模型的离线预览姿态；不调用 API 或真机。 */
  overridePositions?: readonly number[] | null;
}

/** OrbitControls 的最小结构类型，避免额外引入 three-stdlib 类型依赖 */
interface OrbitControlsLike {
  target: { set: (x: number, y: number, z: number) => void };
  update: () => void;
}

/**
 * 模型加载完成前的回退取景中心：
 * 地面位于 y=-1.2，模型基座落地后几何中心必然在地面上方、y 为负值，
 * 绝不能再使用 +0.55（与渲染 group 的 y=-1.2 方向相反）。
 * 模型加载完成后由 ArmModel 回传真实包围盒中心替换。
 */
const FALLBACK_CENTER: [number, number, number] = [0, -0.6, 0];

/**
 * 相机相对取景中心的偏移（与中心点解耦，中心平移时取景几何不变）。
 * 约 0.6m 的模型在 scale=2.5 下约 1.5 单位高，
 * 视锥 fov=38°、距离约 2.5~2.7 时可明显充满视窗。
 */
const VIEW_OFFSET: Record<ArmView, [number, number, number]> = {
  perspective: [1.7, 0.8, 2.05],
  front: [0, 0.35, 2.55],
};

/** 相机位置 = 取景中心 + 视图偏移 */
function cameraPositionFor(
  view: ArmView,
  target: [number, number, number],
): [number, number, number] {
  const [ox, oy, oz] = VIEW_OFFSET[view];
  return [target[0] + ox, target[1] + oy, target[2] + oz];
}

/**
 * 相机取景切换：相机位置 = 动态模型中心 + 固定偏移，OrbitControls target 同步中心；
 * 视角按钮切换后重新以中心取景，之后仍可拖动旋转、滚轮缩放（围绕模型几何中心）。
 */
function CameraRig({ view, target }: { view: ArmView; target: [number, number, number] }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitControlsLike | null;

  useEffect(() => {
    const [px, py, pz] = cameraPositionFor(view, target);
    camera.position.set(px, py, pz);
    if (controls) {
      controls.target.set(target[0], target[1], target[2]);
      controls.update();
    }
  }, [view, target, camera, controls]);

  return null;
}

/** 实时监控视窗：Canvas + OrbitControls + 关节角驱动几何变换 */
export function ArmScene({ height = '100%', view = 'perspective', overridePositions = null }: ArmSceneProps) {
  const { frame, comm, stale, wsStatus } = useTelemetry();

  // 模型几何中心（场景坐标）：加载完成前用回退中心（地面上方、y 为负），
  // ArmModel 加载完成后回传真实包围盒中心
  const [modelCenter, setModelCenter] = useState<[number, number, number]>(FALLBACK_CENTER);

  // 用 useCallback 稳定回调引用，避免 ArmModel 因引用变化重新加载模型
  const handleModelCenter = useCallback((center: [number, number, number]) => {
    setModelCenter(center);
  }, []);

  // 超限关节与夹爪标定状态（只读纯函数，供叠加层告警）
  const mapResult = useMemo(() => {
    if (overridePositions && overridePositions.length >= 6) {
      return computeRobotJointWrites(
        overridePositions.map((position, index) => ({ id: index + 1, position })),
      );
    }
    return frame ? computeRobotJointWrites(frame.joints) : null;
  }, [frame, overridePositions]);

  return (
    <div className="arm-viewport" style={{ height }}>
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: cameraPositionFor('perspective', FALLBACK_CENTER), fov: 38 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        {/* 苹果式浅灰白背景 */}
        <color attach="background" args={['#f5f5f7']} />
        <ambientLight intensity={0.65} />
        {/* 主光：中性白，适合白灰 STL 材质，保留阴影 */}
        <directionalLight
          position={[4, 6, 3]}
          intensity={1.4}
          color={'#ffffff'}
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
        />
        {/* 补光：柔和冷白，提亮暗部 */}
        <directionalLight position={[-3, 2, -2]} intensity={0.5} color={'#e8ecf2'} />

        <Suspense fallback={null}>
          <Grid
            position={[0, -1.2, 0]}
            args={[14, 14]}
            cellSize={0.25}
            cellThickness={0.5}
            cellColor={'#e3e3e8'}
            sectionSize={1}
            sectionThickness={1}
            sectionColor={'#d4d4da'}
            fadeDistance={12}
            fadeStrength={1}
            followCamera={false}
            infiniteGrid={false}
          />
          <ArmModel onModelCenter={handleModelCenter} overridePositions={overridePositions} />
        </Suspense>

        <CameraRig view={view} target={modelCenter} />

        <OrbitControls
          enablePan
          enableRotate
          enableZoom
          zoomToCursor
          target={modelCenter}
          minDistance={1.2}
          maxDistance={8}
          maxPolarAngle={Math.PI * 0.48}
          makeDefault
        />
      </Canvas>

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
