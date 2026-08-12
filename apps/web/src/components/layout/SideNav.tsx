import { Activity, LineChart, PlaySquare, Hourglass, ScrollText, SlidersHorizontal } from 'lucide-react';

export type PageKey = 'monitor' | 'trends' | 'motion' | 'aging' | 'params' | 'logs';

interface Props {
  active: PageKey;
  onChange: (page: PageKey) => void;
}

const ITEMS: Array<{
  key: PageKey;
  label: string;
  icon: JSX.Element;
}> = [
  { key: 'monitor', label: '实时监控', icon: <Activity size={16} /> },
  { key: 'trends', label: '关节趋势', icon: <LineChart size={16} /> },
  { key: 'motion', label: '动作中心', icon: <PlaySquare size={16} /> },
  { key: 'aging', label: '老化测试', icon: <Hourglass size={16} /> },
  { key: 'params', label: '参数配置', icon: <SlidersHorizontal size={16} /> },
  { key: 'logs', label: '日志中心', icon: <ScrollText size={16} /> },
];

// 导出名保持 SideNav，避免上游引用改动；实际渲染为顶部横向 PageNav
export function SideNav({ active, onChange }: Props) {
  return (
    <nav className="app-pagenav pagenav" aria-label="页面导航">
      <div className="pagenav-scroll">
        {ITEMS.map((it) => {
          const isActive = active === it.key;
          return (
            <button
              key={it.key}
              className={`pagenav-item${isActive ? ' pagenav-item--active' : ''}`}
              onClick={() => onChange(it.key)}
              aria-label={it.label}
              title={it.label}
              aria-current={isActive ? 'page' : undefined}
            >
              {it.icon}
              <span className="pagenav-item__label">{it.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}