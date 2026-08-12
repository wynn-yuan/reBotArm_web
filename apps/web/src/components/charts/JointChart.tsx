import { memo, useEffect, useMemo, useRef } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import type { TrendSeries, TrendMetric } from '../../types';

interface Props {
  series: TrendSeries[];
  metric: TrendMetric;
  windowSize: '10s' | '30s' | '2m';
  onClear?: () => void;
}

const METRIC_LABEL: Record<TrendMetric, string> = {
  position: '位置',
  velocity: '速度',
  torque: '扭矩',
  temperature: '温度',
  status: '状态码',
};

const METRIC_UNIT: Record<TrendMetric, string> = {
  position: 'rad',
  velocity: 'rad/s',
  torque: 'Nm',
  temperature: '°C',
  status: 'code',
};

const WINDOW_SECONDS: Record<Props['windowSize'], number> = {
  '10s': 10,
  '30s': 30,
  '2m': 120,
};

// 7 个电机的颜色，按色相均匀分布，避免和品牌色冲突
const COLORS: Record<number, string> = {
  1: '#14b8a6',
  2: '#3b82f6',
  3: '#a855f7',
  4: '#f59e0b',
  5: '#ef4444',
  6: '#10b981',
  7: '#94a3b8',
};

/**
 * 趋势图表。memo 化：父级因 50Hz 实时状态重渲染时，只要 series/metric/
 * windowSize 引用不变（趋势只在 ≤10Hz 降采样写入时更新）就跳过重绘，
 * 保证 ECharts 刷新率 ≤10Hz。
 */
export const JointChart = memo(function JointChart({ series, metric, windowSize, onClear }: Props) {
  const ref = useRef<ReactECharts | null>(null);

  const windowSec = WINDOW_SECONDS[windowSize];

  const option: EChartsOption = useMemo(() => {
    // 以最新采样点为时间轴右端：实时时等价于"现在"，避免窗口随墙钟继续滑动。
    // 无数据时才回退到 Date.now()。
    const lastT = series.reduce((acc, s) => {
      const last = s.data[s.data.length - 1];
      return last && last.t > acc ? last.t : acc;
    }, 0);
    const now = lastT > 0 ? lastT : Date.now();
    const from = now - windowSec * 1000;

    const legendData = series.map((s) => `${s.motorId}`);

    return {
      animation: false,
      backgroundColor: 'transparent',
      grid: { top: 30, right: 24, bottom: 36, left: 56 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        backgroundColor: '#1a242d',
        borderColor: '#2a3543',
        borderWidth: 1,
        textStyle: { color: '#e6edf3', fontSize: 12 },
        formatter: (params: unknown) => {
          const arr = params as Array<{ axisValue: number; seriesName: string; value: [number, number] }>;
          const first = arr[0];
          const time = first
            ? new Date(first.axisValue).toLocaleTimeString('zh-CN', { hour12: false })
            : '';
          const unit = METRIC_UNIT[metric];
          const lines = arr
            .map((p) => {
              const color = COLORS[Number(p.seriesName)] ?? '#9aa7b3';
              const v = metric === 'status' ? String(p.value[1]) : p.value[1].toFixed(3);
              return `<span style="display:inline-block;width:8px;height:8px;background:${color};border-radius:50%;margin-right:6px"></span>J${p.seriesName}: <b>${v}</b> ${unit}`;
            })
            .join('<br/>');
          return `${time}<br/>${lines}`;
        },
      },
      legend: {
        data: legendData,
        textStyle: { color: '#9aa7b3', fontSize: 11 },
        top: 4,
        icon: 'roundRect',
        itemWidth: 10,
        itemHeight: 6,
        itemGap: 8,
      },
      xAxis: {
        type: 'time',
        min: from,
        max: now,
        axisLine: { lineStyle: { color: '#2a3543' } },
        axisLabel: {
          color: '#9aa7b3',
          fontSize: 11,
          formatter: (v: number) => {
            const d = new Date(v);
            return `${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
          },
        },
        splitLine: { lineStyle: { color: '#1f2a35' } },
      },
      yAxis: {
        type: 'value',
        name: `${METRIC_LABEL[metric]} (${METRIC_UNIT[metric]})`,
        nameTextStyle: { color: '#9aa7b3', fontSize: 11, padding: [0, 0, 0, -32] },
        axisLine: { lineStyle: { color: '#2a3543' } },
        axisLabel: { color: '#9aa7b3', fontSize: 11 },
        splitLine: { lineStyle: { color: '#1f2a35' } },
        scale: true,
      },
      series: series.map((s) => {
        const filtered = s.data.filter((p) => p.t >= from);
        return {
          name: `${s.motorId}`,
          type: 'line' as const,
          showSymbol: false,
          sampling: 'lttb' as const,
          smooth: 0.2,
          lineStyle: { width: 1.5 },
          itemStyle: { color: COLORS[s.motorId] },
          data: filtered.map((p) => [p.t, p.v]),
        };
      }),
    };
  }, [series, metric, windowSec]);

  // 时间窗变化时立即重绘
  useEffect(() => {
    ref.current?.getEchartsInstance().resize();
  }, [windowSec]);

  if (series.length === 0) {
    return null;
  }

  return (
    <div style={{ position: 'relative' }}>
      <ReactECharts
        ref={ref}
        option={option}
        notMerge
        lazyUpdate
        style={{ width: '100%', height: 360 }}
        opts={{ renderer: 'canvas' }}
      />
      {onClear && (
        <button
          className="btn btn--ghost btn--sm"
          style={{ position: 'absolute', right: 4, top: 4 }}
          onClick={onClear}
        >
          清空曲线
        </button>
      )}
    </div>
  );
});