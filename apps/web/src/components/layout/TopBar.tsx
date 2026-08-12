import { Power, AlertTriangle, Loader2, PlugZap, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../../state/AppContext';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { postDisable, postEnable, toErrorMessage } from '../../api/client';

interface Props {
  onEmergencyClick: () => void;
}

export function TopBar({ onEmergencyClick }: Props) {
  const { state, startConnectionScan, readOnly, zeroTorqueStatus } = useApp();
  const emergency = state.emergencyStop;
  const safetyStatus = state.safety.status;
  const connection = state.connection;
  const connected = connection.status === 'connected';
  const scanning = connection.scanning;
  const [manualAction, setManualAction] = useState<'enable_all' | 'disable_all' | null>(null);
  const [manualStatus, setManualStatus] = useState<'idle' | 'in-progress' | 'error'>('idle');
  const [manualError, setManualError] = useState<string | null>(null);

  const connectLabel = scanning
    ? '扫描中…'
    : connected
      ? `已连接 ${connection.channel}`
      : '连接机械臂';

  const manualBusy = manualStatus === 'in-progress';
  const manualAllowed = connected && connection.source === 'motorbridge'
    && (state.connection.capabilities.enable || state.connection.capabilities.disable)
    && !emergency && !scanning && safetyStatus === 'idle'
    && !['starting', 'active', 'stopping'].includes(zeroTorqueStatus.status);
  const requestedAction = manualAction === 'enable_all' ? '使能' : '失能';
  const submitManualAction = async () => {
    if (!manualAction || manualBusy) return;
    setManualStatus('in-progress');
    setManualError(null);
    try {
      if (manualAction === 'enable_all') await postEnable();
      else await postDisable();
      setManualStatus('idle');
    } catch (err) {
      setManualStatus('error');
      setManualError(toErrorMessage(err));
    } finally {
      setManualAction(null);
    }
  };

  return (
    <header className="topbar app-topbar" role="banner">
      <div className="topbar-brand">
        <div className="topbar-brand-mark">B</div>
        <span>reBotArm 控制台</span>
      </div>

      <div className="topbar-mode">
        <button
          className={`btn ${connected ? 'btn--connected' : 'btn--primary'}`}
          onClick={() => { void startConnectionScan(); }}
          disabled={scanning || connected}
          aria-label={connectLabel}
        >
          {scanning ? <Loader2 size={14} className="spin" /> : <PlugZap size={14} />}
          <span>{connectLabel}</span>
        </button>
        <div className="row" style={{ gap: 'var(--space-1)' }} aria-label="人工使能失能控制" title={manualError ?? undefined}>
          <button
            className="btn btn--warning"
            onClick={() => { setManualStatus('idle'); setManualAction('enable_all'); }}
            disabled={!manualAllowed || manualBusy || !connection.capabilities.enable}
          >
            {manualBusy && manualAction === 'enable_all' ? <Loader2 size={14} className="spin" /> : <Power size={14} />}
            使能
          </button>
          <button
            className="btn btn--danger"
            onClick={() => { setManualStatus('idle'); setManualAction('disable_all'); }}
            disabled={!manualAllowed || manualBusy || !connection.capabilities.disable}
          >
            {manualBusy && manualAction === 'disable_all' ? <Loader2 size={14} className="spin" /> : <ShieldAlert size={14} />}
            失能
          </button>
        </div>
        <button
          className="btn btn--danger"
          onClick={onEmergencyClick}
          disabled={!connected || emergency || readOnly}
          aria-label="触发紧急失能"
        >
          {emergency ? <AlertTriangle size={14} /> : <Power size={14} />}
          <span>{emergency ? '紧急失能已触发' : '紧急失能'}</span>
        </button>
        {emergency && (
          <button
            className="btn"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('rebot:reset-emergency'));
            }}
            aria-label="复位紧急失能"
          >
            复位紧急失能
          </button>
        )}
      </div>
      <ConfirmDialog
        open={manualAction !== null}
        title={`确认人工${requestedAction}`}
        confirmLabel={`确认${requestedAction}`}
        confirmVariant={manualAction === 'disable_all' ? 'danger' : 'warning'}
        onCancel={() => setManualAction(null)}
        onConfirm={() => { void submitManualAction(); }}
      />
    </header>
  );
}
