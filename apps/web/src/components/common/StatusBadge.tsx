import type { ReactNode } from 'react';

type Variant = 'online' | 'busy' | 'offline' | 'error' | 'info';

interface Props {
  variant: Variant;
  children: ReactNode;
  showDot?: boolean;
  className?: string;
}

export function StatusBadge({ variant, children, showDot = true, className }: Props) {
  return (
    <span className={`badge badge--${variant} ${className ?? ''}`}>
      {showDot && <span className="badge__dot" />}
      {children}
    </span>
  );
}