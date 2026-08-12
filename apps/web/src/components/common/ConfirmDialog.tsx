import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';

interface Props {
  open: boolean;
  title: string;
  description?: string;
  warning?: string;
  confirmLabel: string;
  cancelLabel?: string;
  confirmVariant?: 'primary' | 'danger' | 'warning';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  warning,
  confirmLabel,
  cancelLabel = '取消',
  confirmVariant = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const cls =
    confirmVariant === 'danger'
      ? 'btn btn--danger'
      : confirmVariant === 'warning'
        ? 'btn btn--warning'
        : 'btn btn--primary';

  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button className={cls} onClick={onConfirm} disabled={busy} autoFocus>
            {confirmLabel}
          </button>
        </>
      }
    >
      {warning && (
        <div
          className="row"
          style={{
            padding: 'var(--space-2) var(--space-3)',
            background: 'var(--color-warning-dim)',
            border: '1px solid var(--color-warning-border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--color-warning)',
            marginBottom: 'var(--space-3)',
          }}
        >
          <AlertTriangle size={16} />
          <span style={{ fontSize: 'var(--font-sm)' }}>{warning}</span>
        </div>
      )}
      {description && (
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-md)' }}>
          {description}
        </p>
      )}
    </Modal>
  );
}
