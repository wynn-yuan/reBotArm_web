import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../state/AppContext';
import { TelemetryProvider } from '../../state/TelemetryContext';
import { SideNav, type PageKey } from './SideNav';
import { TopBar } from './TopBar';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { MonitorPage } from '../pages/MonitorPage';
import { TrendsPage } from '../pages/TrendsPage';
import { MotionCenterPage } from '../pages/MotionCenterPage';
import { AgingPage } from '../pages/AgingPage';
import { ParameterPage } from '../pages/ParameterPage';
import { LogsPage } from '../pages/LogsPage';

function ShellInner() {
  const [page, setPage] = useState<PageKey>('monitor');
  const { state, triggerEmergencyDisable, resetEmergency } = useApp();
  const [confirmEmergency, setConfirmEmergency] = useState(false);

  const handleEmergencyClick = useCallback(() => {
    if (state.emergencyStop) return;
    setConfirmEmergency(true);
  }, [state.emergencyStop]);

  useEffect(() => {
    const onReset = () => {
      resetEmergency();
    };
    window.addEventListener('rebot:reset-emergency', onReset as EventListener);
    return () => window.removeEventListener('rebot:reset-emergency', onReset as EventListener);
  }, [resetEmergency]);

  return (
    <div className="app-root">
      <div className="app-shell">
        <TopBar onEmergencyClick={handleEmergencyClick} />
        <SideNav active={page} onChange={setPage} />
        <main className="app-main">
          {page === 'monitor' && <MonitorPage />}
          {page === 'trends' && <TrendsPage />}
          {page === 'motion' && <MotionCenterPage />}
          {page === 'aging' && <AgingPage />}
          {page === 'params' && <ParameterPage />}
          {page === 'logs' && <LogsPage />}
        </main>
      </div>

      <ConfirmDialog
        open={confirmEmergency}
        title="确认触发紧急失能？"
        confirmLabel="确认紧急失能"
        confirmVariant="danger"
        onConfirm={() => {
          setConfirmEmergency(false);
          triggerEmergencyDisable();
        }}
        onCancel={() => setConfirmEmergency(false)}
      />
    </div>
  );
}

export function AppShell() {
  return (
    <TelemetryProvider>
      <ShellInner />
    </TelemetryProvider>
  );
}
