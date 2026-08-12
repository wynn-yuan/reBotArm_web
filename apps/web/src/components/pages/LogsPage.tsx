import { useMemo, useState } from 'react';
import {
  ScrollText,
  Filter,
  Download,
  X,
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
} from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { EmptyState } from '../common/EmptyState';
import { Drawer } from '../common/Drawer';
import { StatusBadge } from '../common/StatusBadge';
import { formatDateTime } from '../../utils/format';
import type { LogEntry, LogEventType, LogResult } from '../../types';

const TYPE_OPTIONS: Array<{ value: LogEventType | 'all'; label: string }> = [
  { value: 'all', label: '全部类型' },
  { value: 'teach_record', label: '遥操录制' },
  { value: 'playback', label: '动作回放' },
  { value: 'aging', label: '老化' },
  { value: 'homing', label: '回零' },
  { value: 'emergency', label: '紧急失能' },
  { value: 'system', label: '系统' },
];

const RESULT_OPTIONS: Array<{ value: LogResult | 'all'; label: string }> = [
  { value: 'all', label: '全部结果' },
  { value: 'success', label: '成功' },
  { value: 'warning', label: '警告' },
  { value: 'error', label: '错误' },
  { value: 'info', label: '信息' },
];

const RESULT_VARIANT: Record<LogResult, 'online' | 'busy' | 'error' | 'info'> = {
  success: 'online',
  warning: 'busy',
  error: 'error',
  info: 'info',
};

const RESULT_LABEL: Record<LogResult, string> = {
  success: '成功',
  warning: '警告',
  error: '错误',
  info: '信息',
};

const RESULT_ICON: Record<LogResult, JSX.Element> = {
  success: <CircleCheck size={14} />,
  warning: <TriangleAlert size={14} />,
  error: <CircleAlert size={14} />,
  info: <Info size={14} />,
};

const TYPE_LABEL: Record<LogEventType, string> = {
  teach_record: '遥操录制',
  playback: '动作回放',
  aging: '老化',
  homing: '回零',
  emergency: '紧急失能',
  system: '系统',
};

export function LogsPage() {
  const { state } = useApp();
  const [typeFilter, setTypeFilter] = useState<LogEventType | 'all'>('all');
  const [resultFilter, setResultFilter] = useState<LogResult | 'all'>('all');
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [exporting, setExporting] = useState(false);

  const filtered = useMemo(() => {
    return state.logs.filter((l) => {
      if (typeFilter !== 'all' && l.type !== typeFilter) return false;
      if (resultFilter !== 'all' && l.result !== resultFilter) return false;
      return true;
    });
  }, [state.logs, typeFilter, resultFilter]);

  // 会话分组：相同 sessionId 视为同一会话
  const sessions = useMemo(() => {
    const map = new Map<string, LogEntry[]>();
    state.logs.forEach((l) => {
      const arr = map.get(l.sessionId) ?? [];
      arr.push(l);
      map.set(l.sessionId, arr);
    });
    return Array.from(map.entries()).map(([id, entries]) => ({
      id,
      count: entries.length,
      lastAt: Math.max(...entries.map((e) => e.timestamp)),
    }));
  }, [state.logs]);

  const handleExport = () => {
    setExporting(true);
    // 仅演示：浏览器端下载一个简单的 CSV
    const rows = [
      ['id', 'session', 'timestamp', 'type', 'result', 'title', 'detail'].join(','),
      ...state.logs.map((l) =>
        [l.id, l.sessionId, new Date(l.timestamp).toISOString(), l.type, l.result, l.title, l.detail ?? '']
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(','),
      ),
    ];
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rebotarm-logs-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    window.setTimeout(() => setExporting(false), 400);
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">日志中心</h1>
          <div className="page-subtitle">会话表格 · 类型与结果筛选 · 详情抽屉 · CSV 导出</div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={handleExport} disabled={state.logs.length === 0 || exporting}>
            <Download size={14} /> {exporting ? '已生成' : '导出 CSV'}
          </button>
        </div>
      </div>

      <div
        className="grid"
        style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.6fr)', gap: 'var(--space-4)' }}
      >
        {/* 会话概览 */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">
                <ScrollText size={16} /> 会话
              </div>
              <div className="card-subtitle">按 sessionId 聚合</div>
            </div>
            <span className="tertiary" style={{ fontSize: 'var(--font-xs)' }}>
              {sessions.length} 个会话
            </span>
          </div>
          <div className="card-body card-body--flush">
            {sessions.length === 0 ? (
              <EmptyState title="暂无会话" desc="所有操作都会记录到当前会话。" />
            ) : (
              <div className="table-scroll">
                <table className="motor-table">
                  <thead>
                    <tr>
                      <th>会话 ID</th>
                      <th style={{ width: 100, textAlign: 'right' }}>事件数</th>
                      <th style={{ width: 160 }}>最后活跃</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr key={s.id}>
                        <td className="mono">{s.id}</td>
                        <td style={{ textAlign: 'right' }}>{s.count}</td>
                        <td>{formatDateTime(s.lastAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* 事件表 + 筛选 */}
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">
                <Filter size={16} /> 事件
              </div>
              <div className="card-subtitle">点击任意行查看详情</div>
            </div>
            <div className="row">
              <select className="select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as LogEventType | 'all')} style={{ width: 130 }}>
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select className="select" value={resultFilter} onChange={(e) => setResultFilter(e.target.value as LogResult | 'all')} style={{ width: 130 }}>
                {RESULT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="card-body card-body--flush">
            {filtered.length === 0 ? (
              <EmptyState
                variant={state.logs.length === 0 ? 'empty' : 'warning'}
                title={state.logs.length === 0 ? '暂无事件' : '没有符合筛选的事件'}
                desc={state.logs.length === 0 ? '在其它页面触发的操作都会记录在这里。' : '尝试放宽筛选条件。'}
              />
            ) : (
              <div className="table-scroll">
                <table className="motor-table">
                  <thead>
                    <tr>
                      <th style={{ width: 160 }}>时间</th>
                      <th style={{ width: 100 }}>类型</th>
                      <th style={{ width: 100 }}>结果</th>
                      <th>标题</th>
                      <th style={{ width: 100 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((l) => (
                      <tr key={l.id}>
                        <td>{formatDateTime(l.timestamp)}</td>
                        <td>
                          <span className="tag">{TYPE_LABEL[l.type]}</span>
                        </td>
                        <td>
                          <StatusBadge variant={RESULT_VARIANT[l.result]}>{RESULT_LABEL[l.result]}</StatusBadge>
                        </td>
                        <td>{l.title}</td>
                        <td>
                          <button className="btn btn--sm" onClick={() => setSelected(l)}>
                            查看
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 详情抽屉 */}
      <Drawer
        open={selected !== null}
        title="事件详情"
        onClose={() => setSelected(null)}
        footer={
          <button className="btn btn--ghost" onClick={() => setSelected(null)}>
            <X size={14} /> 关闭
          </button>
        }
      >
        {selected && (
          <div className="stack stack--lg">
            <div className="kv">
              <span className="kv__k">事件 ID</span>
              <span className="kv__v mono">{selected.id}</span>
            </div>
            <div className="kv">
              <span className="kv__k">会话 ID</span>
              <span className="kv__v mono">{selected.sessionId}</span>
            </div>
            <div className="kv">
              <span className="kv__k">时间</span>
              <span className="kv__v">{formatDateTime(selected.timestamp)}</span>
            </div>
            <div className="kv">
              <span className="kv__k">类型</span>
              <span className="kv__v">
                <span className="tag">{TYPE_LABEL[selected.type]}</span>
              </span>
            </div>
            <div className="kv">
              <span className="kv__k">结果</span>
              <span className="kv__v">
                <StatusBadge variant={RESULT_VARIANT[selected.result]}>
                  {RESULT_ICON[selected.result]} {RESULT_LABEL[selected.result]}
                </StatusBadge>
              </span>
            </div>
            <div>
              <div className="kv">
                <span className="kv__k">标题</span>
                <span className="kv__v">{selected.title}</span>
              </div>
              {selected.detail && (
                <p
                  style={{
                    marginTop: 'var(--space-2)',
                    color: 'var(--text-secondary)',
                    fontSize: 'var(--font-md)',
                    background: 'var(--bg-inset)',
                    padding: 'var(--space-3)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  {selected.detail}
                </p>
              )}
            </div>
            {selected.meta && (
              <div>
                <div className="section-title" style={{ marginBottom: 'var(--space-2)' }}>
                  元数据
                </div>
                <div className="stack stack--sm">
                  {Object.entries(selected.meta).map(([k, v]) => (
                    <div key={k} className="kv">
                      <span className="kv__k">{k}</span>
                      <span className="kv__v mono">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}