import { useCallback, useRef, useState } from 'react';
import { GripHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * 可拖拽调整内容区高度的容器。
 *
 * 4K / 宽屏显示器上模型视窗的固定高度会让竖直延伸的机械臂显得"窄"。
 * 本组件把一个受限区间（min..max）内的内容高度交给用户手动拖拽调节，
 * 并把用户偏好持久化到 localStorage（提供 storageKey 时），刷新后仍生效。
 * 内容区只改变自身高度，不压缩页面其他区域——参数/表格经页面滚动始终可见。
 */
export interface ResizablePanelProps {
  /** 未持久化偏好时的初始内容高度（px）。 */
  initialHeight: number;
  /** 可拖拽高度下限（px）。 */
  min?: number;
  /** 可拖拽高度上限（px）。 */
  max?: number;
  /** localStorage 持久化 key；提供则记住用户上次调整的高度。 */
  storageKey?: string;
  className?: string;
  children: ReactNode;
}

function readStored(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // 隐私模式 / 存储不可用时静默降级为仅本次会话有效。
  }
}

export function ResizablePanel({
  initialHeight,
  min = 360,
  max = 1200,
  storageKey,
  className,
  children,
}: ResizablePanelProps) {
  const [height, setHeight] = useState<number>(() => {
    const stored = storageKey ? readStored(storageKey) : null;
    return stored !== null ? Math.min(max, Math.max(min, stored)) : initialHeight;
  });
  // 拖拽期间供 pointermove / pointerup 读取最新高度，避免闭包过期。
  const heightRef = useRef(height);
  heightRef.current = height;
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: heightRef.current,
      };
      setIsDragging(true);
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const next = Math.min(max, Math.max(min, drag.startHeight + (event.clientY - drag.startY)));
      setHeight(next);
    },
    [max, min],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      setIsDragging(false);
      if (storageKey) writeStored(storageKey, heightRef.current);
    },
    [storageKey],
  );

  return (
    <div className={className}>
      <div style={{ height, overflow: 'hidden' }}>{children}</div>
      <div
        className={`resize-handle${isDragging ? ' resize-handle--active' : ''}`}
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整模型显示区域高度"
        aria-valuenow={Math.round(height)}
        aria-valuemin={min}
        aria-valuemax={max}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <GripHorizontal size={14} />
      </div>
    </div>
  );
}