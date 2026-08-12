import type { ReactNode } from 'react';
import { Inbox, AlertTriangle, OctagonX, Loader2 } from 'lucide-react';

type Variant = 'empty' | 'warning' | 'error' | 'loading';

interface Props {
  variant?: Variant;
  title: string;
  desc?: string;
  action?: ReactNode;
}

const ICONS: Record<Variant, JSX.Element> = {
  empty: <Inbox size={28} />,
  warning: <AlertTriangle size={28} />,
  error: <OctagonX size={28} />,
  loading: <Loader2 size={28} className="spin" />,
};

export function EmptyState({ variant = 'empty', title, desc, action }: Props) {
  const cls =
    variant === 'warning'
      ? 'state-box state-box--warning'
      : variant === 'error'
        ? 'state-box state-box--error'
        : 'state-box';
  return (
    <div className={cls}>
      <div className="state-box__icon">{ICONS[variant]}</div>
      <div className="state-box__title">{title}</div>
      {desc && <div className="state-box__desc">{desc}</div>}
      {action && <div className="row" style={{ marginTop: 'var(--space-2)' }}>{action}</div>}
    </div>
  );
}