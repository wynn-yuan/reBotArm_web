import { Suspense, Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import { ArmModel } from './ArmModel';
import type { ArmConfig } from '../../telemetry/jointTransform';

export type ArmView = 'perspective' | 'front';
export type ArmFrameloop = 'always' | 'demand';

/**
 * 单个 3D 槽位（.arm-viewport）发布的渲染配置：
 * Canvas 常驻 provider，槽位变化只换配置、不重建 GL 上下文。
 */
export interface ArmSlotConfig {
  urdfUrl: string;
  modelScale: number;
  modelRotationX: number;
  modelPosition: [number, number, number];
  /** 关节映射（armConfigFromModel(displayedArm)） */
  armCfg: ArmConfig;
  view: ArmView;
  overridePositions: readonly number[] | null;
  frameloop: ArmFrameloop;
}

interface ArmViewportContextValue {
  /** 槽位挂载：把常驻 Canvas portal 进该 DOM，并设置渲染配置 */
  register: (el: HTMLDivElement, config: ArmSlotConfig) => void;
  /** 配置变化（预览播放/拖进度条可高频调用）：只更新配置，不重建槽位 */
  update: (el: HTMLDivElement, config: ArmSlotConfig) => void;
  /** 槽位卸载：portal 退回隐藏回退槽，上下文不销毁 */
  unregister: (el: HTMLDivElement) => void;
  /**
   * 当前浏览器是否可创建 WebGL 上下文。
   * 真机 Firefox（本 Jetson 无 /dev/dri）glTexImage 全不可用；无 WebGL 时
   * 不挂载 Canvas（避免 r3f 抛 "Error creating WebGL context" 掀翻整棵应用树），
   * ArmScene 依此显示「3D 视窗不可用」占位，其余功能照常。
   */
  webgl: boolean;
}

/** 探测 WebGL 可用性（一次性，进程级）。失败返回 false，绝不向 r3f 抛出。 */
function isWebGLAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/**
 * 兜底错误边界：即使探测通过、运行时创建 GL 仍失败（如 GPU 进程崩溃），
 * 只降级 3D 视窗，绝不把「Error creating WebGL context」抛上整棵应用树。
 */
class CanvasErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error('[ArmViewport] WebGL 渲染降级：', error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const ArmViewportContext = createContext<ArmViewportContextValue | null>(null);

/** OrbitControls 最小结构类型，避免额外引入 three-stdlib 类型依赖 */
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
function cameraPositionFor(view: ArmView, target: [number, number, number]): [number, number, number] {
  const [ox, oy, oz] = VIEW_OFFSET[view];
  return [target[0] + ox, target[1] + oy, target[2] + oz];
}

/**
 * frameloop="demand" 下的重绘触发器：展示姿态/取景真正变化时请求重绘一帧
 * （R3F invalidate）。注意不订阅遥测帧：50-100Hz 的帧若逐帧重绘整场景，
 * 会把 demand 退化成 always 循环；离线预览只需要按 overridePositions
 * （播放/拖动进度条）与相机变化重绘。OrbitControls 的拖拽/滚轮由 drei
 * 自带 invalidate 处理，无需在此覆盖。
 */
function DemandInvalidator({
  overridePositions,
  view,
  modelCenter,
}: {
  overridePositions: readonly number[] | null;
  view: ArmView;
  modelCenter: [number, number, number];
}) {
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    invalidate();
  }, [overridePositions, view, modelCenter, invalidate]);
  return null;
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

/** 常驻 Canvas 的场景主体：只在本槽位挂载期间渲染（槽位配置驱动）。 */
function SceneContents({
  config,
  modelCenter,
  onModelCenter,
}: {
  config: ArmSlotConfig;
  modelCenter: [number, number, number];
  onModelCenter: (center: [number, number, number]) => void;
}) {
  return (
    <>
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
        <ArmModel
          onModelCenter={onModelCenter}
          overridePositions={config.overridePositions}
          urdfUrl={config.urdfUrl}
          modelScale={config.modelScale}
          modelRotationX={config.modelRotationX}
          modelPosition={config.modelPosition}
          config={config.armCfg}
        />
      </Suspense>

      <CameraRig view={config.view} target={modelCenter} />

      <DemandInvalidator
        overridePositions={config.overridePositions}
        view={config.view}
        modelCenter={modelCenter}
      />

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
    </>
  );
}

export function ArmViewportProvider({ children }: { children: ReactNode }) {
  const [slotEl, setSlotEl] = useState<HTMLDivElement | null>(null);
  const [slotConfig, setSlotConfig] = useState<ArmSlotConfig | null>(null);
  const [fallbackEl, setFallbackEl] = useState<HTMLDivElement | null>(null);
  const [modelCenter, setModelCenter] = useState<[number, number, number]>(FALLBACK_CENTER);
  const [webgl] = useState(isWebGLAvailable);
  const slotElRef = useRef<HTMLDivElement | null>(null);

  const register = useCallback((el: HTMLDivElement, config: ArmSlotConfig) => {
    slotElRef.current = el;
    setSlotEl(el);
    setSlotConfig(config);
  }, []);
  const update = useCallback((el: HTMLDivElement, config: ArmSlotConfig) => {
    // identity 守卫：早退的旧槽位不得覆盖新槽位
    if (slotElRef.current !== el) return;
    setSlotConfig(config);
  }, []);
  const unregister = useCallback((el: HTMLDivElement) => {
    if (slotElRef.current !== el) return;
    slotElRef.current = null;
    setSlotEl(null);
    setSlotConfig(null);
  }, []);

  const value = useMemo<ArmViewportContextValue>(
    () => ({ register, update, unregister, webgl }),
    [register, update, unregister, webgl],
  );
  const target = slotEl ?? fallbackEl;

  return (
    <ArmViewportContext.Provider value={value}>
      {children}

      {/* 无槽位时的隐藏回退槽：任何页面切换间隙 3D 上下文都常驻，不 forceContextLoss */}
      <div
        ref={setFallbackEl}
        aria-hidden
        style={{ position: 'fixed', width: 1, height: 1, overflow: 'hidden', opacity: 0, pointerEvents: 'none' }}
      />

      {/* 无 WebGL（如本机 Firefox）：不挂载 Canvas，避免 r3f 抛错掀翻应用树。
          各槽位照常 register，ArmScene 据 webgl 显示「3D 视窗不可用」占位。 */}
      {webgl && target && createPortal(
        <CanvasErrorBoundary>
        <Canvas
          shadows
          frameloop={slotEl ? (slotConfig?.frameloop ?? 'demand') : 'demand'}
          dpr={1}
          camera={{ position: cameraPositionFor('perspective', FALLBACK_CENTER), fov: 38 }}
          gl={{ antialias: false, alpha: true }}
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
            shadow-mapSize-width={512}
            shadow-mapSize-height={512}
          />
          {/* 补光：柔和冷白，提亮暗部 */}
          <directionalLight position={[-3, 2, -2]} intensity={0.5} color={'#e8ecf2'} />

          {slotEl && slotConfig && (
            <SceneContents config={slotConfig} modelCenter={modelCenter} onModelCenter={setModelCenter} />
          )}
        </Canvas>
        </CanvasErrorBoundary>,
        target,
      )}
    </ArmViewportContext.Provider>
  );
}

export function useArmViewport(): ArmViewportContextValue {
  const ctx = useContext(ArmViewportContext);
  if (!ctx) throw new Error('useArmViewport 必须在 <ArmViewportProvider> 内使用');
  return ctx;
}