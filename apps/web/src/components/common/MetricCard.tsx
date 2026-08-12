import type { ReactNode } from 'react';

interface Props {
  label: string;
  value: ReactNode;
  unit?: string;
  delta?: ReactNode;
  hint?: string;
}

export function MetricCard({ label, value, unit, delta, hint }: Props) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div>
        <span className="metric-value mono">{value}</span>
        {unit && <span className="metric-unit">{unit}</span>}
      </div>
      {delta !== undefined && <div className="metric-delta">{delta}</div>}
      {hint && <div className="metric-delta tertiary">{hint}</div>}
    </div>
  );
}