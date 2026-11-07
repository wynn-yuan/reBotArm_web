import { useState } from 'react';
import { Bot, RefreshCw } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { EmptyState } from '../common/EmptyState';
import { StatusBadge } from '../common/StatusBadge';

/** 切换激活的确认对话框负载（点选另一台机型直接切换，无需先取消激活）。 */
type PendingConfirm = { kind: 'activate'; armId: string };

/**
 * 首页 · 机型选择。
 * 机型由后端注册表提供（packages/arm-models/robots 下每台机型一份 model.yaml，前端不可配置）。
 * 激活机型是后端运行时状态：直接点「激活」即可切换，后端要求切换前断开连接（409 must_disconnect_first），前端自动断开后重试。
 */
export function ModelPage() {
  const { state, switchArm, disconnectRobot } = useApp();
  const { models, activeArm, connection } = state;
  const connected = connection.status === 'connected';

  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 连接态下的后端动作会 409：先弹确认框提示会断开；断开态直接执行。
  const guardConnected = (payload: PendingConfirm, run: () => void) => {
    if (connected) {
      setPending(payload);
      setConfirmOpen(true);
      return;
    }
    run();
  };

  const handleActivate = (armId: string) => {
    if (armId === activeArm?.armId) return;
    guardConnected({ kind: 'activate', armId }, () => void doSwitch(armId));
  };

  const doSwitch = async (armId: string, { afterDisconnect = false } = {}) => {
    setSwitching(armId);
    setError(null);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
        try {
          await switchArm(armId);
          return;
        } catch (e) {
          const code = (e as { code?: string } | null)?.code;
          if (code !== 'must_disconnect_first') {
            setError(e instanceof Error ? e.message : String(e));
            return;
          }
          // 409：刚发起的断开尚未生效，发起断开并重试；已断开仍 409 则放弃。
          if (!afterDisconnect) {
            afterDisconnect = true;
            disconnectRobot();
          } else if (attempt === 2) {
            setError('切换机型失败：后端仍处于连接状态，请先手动断开连接。');
          }
        }
      }
    } finally {
      setSwitching(null);
    }
  };

  const handleConfirm = () => {
    setConfirmOpen(false);
    const p = pending;
    if (!p) return;
    setPending(null);
    void doSwitch(p.armId);
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">机械臂型号</h1>
          <div className="page-subtitle">
            机型配置来自后端注册表（model.yaml）· 激活机型需断开连接后切换
          </div>
        </div>
        <StatusBadge variant={activeArm ? 'online' : 'offline'}>
          {activeArm ? activeArm.name : '未激活'}
        </StatusBadge>
      </div>

      {error && (
        <div className="param-notice param-notice--danger" role="alert">
          <span>{error}</span>
        </div>
      )}

      {models.length === 0 ? (
        <EmptyState
          title="暂无可用机型"
          desc="后端未从 packages/arm-models/robots/*/model.yaml 读到任何机型。"
        />
      ) : (
        <div className="models-grid">
          {models.map((arm) => {
            const isActive = arm.armId === activeArm?.armId;
            return (
              <div key={arm.armId} className={`card model-card${isActive ? ' model-card--active' : ''}`}>
                <div className="model-card__head">
                  <div className="card-title">
                    <Bot size={16} /> {arm.name}
                  </div>
                  {isActive && <StatusBadge variant="online">当前激活</StatusBadge>}
                </div>
                <button
                  className="btn btn--primary btn--lg model-card__activate"
                  disabled={isActive || switching === arm.armId}
                  onClick={() => handleActivate(arm.armId)}
                  title={isActive ? '当前已激活' : connected ? '切换机型会先断开当前连接' : undefined}
                >
                  {isActive ? (
                    '已激活'
                  ) : switching === arm.armId ? (
                    <><RefreshCw size={14} className="spin" /> 切换中…</>
                  ) : (
                    '激活'
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="切换机型将断开当前连接？"
        description="激活机型属于后端运行时状态（扫描电机、老化限位、重力模型都与机型绑定），改动前必须断开当前扫描连接。断开后需重新扫描连接。"
        warning="确认后会自动断开当前连接并切换机型。"
        confirmLabel="断开并切换"
        confirmVariant="warning"
        onConfirm={handleConfirm}
        onCancel={() => { setConfirmOpen(false); setPending(null); }}
      />
    </div>
  );
}