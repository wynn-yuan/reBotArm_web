import { Power, AlertTriangle, Loader2, PlugZap, ShieldAlert, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../state/AppContext';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Modal } from '../common/Modal';
import { postDisable, postEnable, toErrorMessage } from '../../api/client';

interface OtaCheckResult {
  ok: boolean;
  error?: string;
  current?: string;
  latest?: string;
  has_update?: boolean;
  latest_name?: string;
  latest_body?: string;
}

interface OtaProgress {
  step: string;
  message: string;
  progress: number;
}

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

  // OTA state
  const [otaOpen, setOtaOpen] = useState(false);
  const [otaStatus, setOtaStatus] = useState<OtaCheckResult | null>(null);
  const [otaChecking, setOtaChecking] = useState(false);
  const [otaUpdating, setOtaUpdating] = useState(false);
  const [otaError, setOtaError] = useState<string | null>(null);
  const [otaResult, setOtaResult] = useState<string | null>(null);
  const [otaProgress, setOtaProgress] = useState<OtaProgress | null>(null);
  const otaAbortRef = useRef<AbortController | null>(null);
  const otaPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 提交更新后轮询进度
  useEffect(() => {
    if (!otaProgress || otaProgress.step === 'done' || otaProgress.step === 'error') return;
    const poll = async () => {
      try {
        const resp = await fetch('/api/ota/progress');
        if (!resp.ok) throw new Error('poll failed');
        const p: OtaProgress = await resp.json();
        setOtaProgress(p);
        if (p.step === 'done') {
          setOtaResult('更新完成，正在刷新…');
          // 等待 2 秒让服务完全启动，然后刷新页面
          setTimeout(() => { window.location.reload(); }, 2000);
        }
      } catch {
        // 服务正在重启，稍后重试
        setOtaProgress((prev) => prev ? { ...prev, message: '服务重启中，等待连接…' } : null);
      }
    };
    otaPollRef.current = setInterval(poll, 1000);
    return () => {
      if (otaPollRef.current) clearInterval(otaPollRef.current);
    };
  }, [otaProgress?.step]);

  const checkOta = useCallback(async () => {
    // 取消上一次未完成的请求
    otaAbortRef.current?.abort();
    const controller = new AbortController();
    otaAbortRef.current = controller;

    setOtaChecking(true);
    setOtaError(null);
    setOtaStatus(null);
    try {
      const resp = await fetch('/api/ota/check', { signal: controller.signal });
      const data: OtaCheckResult = await resp.json();
      if (!resp.ok) {
        setOtaError(data.error || `服务器错误 (${resp.status})`);
        return;
      }
      if (!data.ok) {
        setOtaError(data.error || '无法获取更新信息');
        return;
      }
      setOtaStatus(data);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setOtaError('无法连接更新服务');
    } finally {
      if (otaAbortRef.current === controller) {
        otaAbortRef.current = null;
      }
      setOtaChecking(false);
    }
  }, []);

  const doOtaUpdate = useCallback(async () => {
    setOtaUpdating(true);
    setOtaError(null);
    setOtaResult(null);
    try {
      const form = new FormData();
      form.append('confirm', 'true');
      const resp = await fetch('/api/ota/update-from-github', { method: 'POST', body: form });
      const data = await resp.json();
      if (resp.ok) {
        setOtaResult(data.message || '更新已开始');
        // 更新已提交，隐藏"立即更新"按钮，开始轮询进度
        setOtaStatus((prev) => prev ? { ...prev, has_update: false } : null);
        setOtaProgress({ step: 'submitted', message: '更新已提交…', progress: 0.0 });
      } else {
        setOtaError(data.error || '更新失败');
      }
    } catch (e) {
      setOtaError('更新请求失败');
    } finally {
      setOtaUpdating(false);
    }
  }, []);

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
        <button
          className="btn btn--ghost"
          onClick={() => { setOtaOpen(true); void checkOta(); }}
          title="系统更新"
          aria-label="系统更新"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <ConfirmDialog
        open={manualAction !== null}
        title={`确认人工${requestedAction}`}
        confirmLabel={`确认${requestedAction}`}
        confirmVariant={manualAction === 'disable_all' ? 'danger' : 'warning'}
        onCancel={() => setManualAction(null)}
        onConfirm={() => { void submitManualAction(); }}
      />
      <Modal open={otaOpen} title="系统更新" onClose={() => { otaAbortRef.current?.abort(); if (otaPollRef.current) clearInterval(otaPollRef.current); setOtaOpen(false); setOtaStatus(null); setOtaError(null); setOtaResult(null); setOtaProgress(null); }}>
        <div className="stack" style={{ minWidth: 320 }}>
          {otaStatus && (
            <div className="stack stack--sm">
              <div className="kv">
                <span className="kv__k">当前版本</span>
                <span className="kv__v mono">{otaStatus.current ?? '—'}</span>
              </div>
              <div className="kv">
                <span className="kv__k">最新版本</span>
                <span className="kv__v mono">{otaStatus.latest ?? '—'}</span>
              </div>
              {otaStatus.has_update && (
                <div className="state-box" style={{ background: 'var(--color-primary-dim)', borderColor: 'var(--color-primary)' }}>
                  <div className="state-box__desc">有新版本可用</div>
                </div>
              )}
              {!otaStatus.has_update && otaStatus.latest && (
                <div className="state-box" style={{ background: 'var(--color-success-dim)', borderColor: 'var(--color-success)' }}>
                  <div className="state-box__desc">已是最新版本</div>
                </div>
              )}
            </div>
          )}
          {otaError && <div className="state-box state-box--error"><div className="state-box__desc">{otaError}</div></div>}
          {otaResult && <div className="state-box" style={{ background: 'var(--color-success-dim)', borderColor: 'var(--color-success)' }}><div className="state-box__desc">{otaResult}</div></div>}
          {otaProgress && (
            <div className="stack stack--sm" style={{ width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>
                <span>{otaProgress.message}</span>
                <span>{Math.round(otaProgress.progress * 100)}%</span>
              </div>
              <div style={{ width: '100%', height: 6, background: 'var(--color-bg-inset)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                <div style={{
                  width: `${Math.round(otaProgress.progress * 100)}%`,
                  height: '100%',
                  background: otaProgress.step === 'error' ? 'var(--color-danger)' : 'var(--color-primary)',
                  borderRadius: 'var(--radius-full)',
                  transition: 'width 0.5s ease',
                }} />
              </div>
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            {!otaProgress && (
            <>
              <button className="btn btn--primary" onClick={() => { void checkOta(); }} disabled={otaChecking}>
                {otaChecking ? '检查中…' : '检查更新'}
              </button>
              {otaStatus?.has_update && (
                <button className="btn btn--warning" onClick={() => { void doOtaUpdate(); }} disabled={otaUpdating}>
                  {otaUpdating ? '更新中…' : '立即更新'}
                </button>
              )}
            </>
          )}
          </div>
        </div>
      </Modal>
    </header>
  );
}
