import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../state/AppContext';
import { TelemetryProvider } from '../../state/TelemetryContext';
import { prefetchArmModel } from '../arm/ArmModel';
import { ArmViewportProvider } from '../arm/ArmViewport';
import { SideNav, type PageKey } from './SideNav';
import { TopBar } from './TopBar';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { ModelPage } from '../pages/ModelPage';
import { MonitorPage } from '../pages/MonitorPage';
import { TrendsPage } from '../pages/TrendsPage';
import { MotionCenterPage } from '../pages/MotionCenterPage';
import { AgingPage } from '../pages/AgingPage';
import { ParameterPage } from '../pages/ParameterPage';
import { LogsPage } from '../pages/LogsPage';

function ShellInner() {
  const [page, setPage] = useState<PageKey>('model');
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

  // 开机预热：应用启动时在空闲期异步解析激活机型的 URDF mesh，
  // 首次进入监控/动作中心视窗直接复用缓存，避免冷启动切页卡顿
  const activeArm = state.activeArm;
  useEffect(() => {
    if (activeArm) {
      prefetchArmModel(`/robots/${activeArm.armId}/model.urdf`);
    }
  }, [activeArm]);

  return (
    <div className="app-root">
      <div className="app-shell">
        <TopBar onEmergencyClick={handleEmergencyClick} />
        <SideNav active={page} onChange={setPage} />
        <main className="app-main">
          <ArmViewportProvider>
            {page === 'model' && <ModelPage />}
            {page === 'monitor' && <MonitorPage />}
            {page === 'trends' && <TrendsPage />}
            {page === 'motion' && <MotionCenterPage />}
            {page === 'aging' && <AgingPage />}
            {page === 'params' && <ParameterPage />}
            {page === 'logs' && <LogsPage />}
          </ArmViewportProvider>
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
