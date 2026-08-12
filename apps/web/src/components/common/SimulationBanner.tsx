import { AlertCircle } from 'lucide-react';

/** 顶部全局提示：模拟数据，不会驱动机械臂 */
export function SimulationBanner() {
  return (
    <div className="sim-banner" role="status" aria-live="polite">
      <AlertCircle size={14} />
      <span>模拟数据 · 不会驱动机械臂 · 仅用于原型演示</span>
    </div>
  );
}