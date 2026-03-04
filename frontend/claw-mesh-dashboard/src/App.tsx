import { useState } from 'react';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { StatsCards } from './components/StatsCards';
import { MeshTopology } from './components/MeshTopology';
import { StarOfficePanel } from './components/StarOfficePanel';
import { EventTimeline } from './components/EventTimeline';
import { TaskTable } from './components/TaskTable';
import { GovernancePanel } from './components/GovernancePanel';
import { useMeshStore } from './stores/useMeshStore';
import { useTaskStore } from './stores/useTaskStore';
import { useEventStore } from './stores/useEventStore';
import { useAuthStore, usePermission } from './stores/useAuthStore';
import {
  fetchHealth,
  fetchQueueDepth,
  fetchWorkerLoad,
  fetchGovernanceSummary,
  usePolling,
  useEventSocket,
  type NodeId,
} from './lib/api';
import type { MeshEvent } from './stores/useEventStore';
import { useGovernanceStore } from './stores/useGovernanceStore';

// ============ 数据轮询 ============
function DataProvider({ children }: { children: React.ReactNode }) {
  const setNodeHealth = useMeshStore((s) => s.setNodeHealth);
  const setQueue = useTaskStore((s) => s.setQueue);
  const setWorkerLoad = useTaskStore((s) => s.setWorkerLoad);
  const addEvent = useEventStore((s) => s.addEvent);
  const setTrust = useGovernanceStore((s) => s.setTrustLeaderboard);
  const setBudget = useGovernanceStore((s) => s.setBudget);
  const addAudit = useGovernanceStore((s) => s.addAuditEntries);
  const setPolicies = useGovernanceStore((s) => s.setPolicies);
  const setQuality = useGovernanceStore((s) => s.setQuality);
  const setEvolution = useGovernanceStore((s) => s.setEvolution);

  // 各节点健康检查 5s
  const nodeIds: NodeId[] = ['central', 'silicon', 'tokyo'];
  for (const node of nodeIds) {
    usePolling(() => fetchHealth(node), (data) => setNodeHealth(node, data), 5000);
  }

  // 队列深度 5s
  usePolling(fetchQueueDepth, setQueue, 5000);

  // Worker 负载 5s
  usePolling(fetchWorkerLoad, setWorkerLoad, 5000);

  // 治理数据 10s
  usePolling(fetchGovernanceSummary, (data) => {
    setTrust(data.trust);
    setBudget(data.budget);
    addAudit(data.audit);
    setPolicies(data.policies);
    setQuality(data.quality);
    setEvolution(data.evolution.strategy, data.evolution.diversityIndex);
  }, 10000);

  // 实时事件 WebSocket
  useEventSocket('ws://10.10.0.1:3001/ws', 'memov:event', (data) => {
    const d = data as Record<string, string>;
    addEvent({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: parseInt(d.timestamp) || Date.now(),
      type: d.type || 'unknown',
      agentId: d.agent_id || 'system',
      node: d.node || 'central',
      status: d.status === 'success' ? 'success' : d.status === 'failure' ? 'failure' : 'info',
      message: d.message,
    } satisfies MeshEvent);
  });

  return <>{children}</>;
}

// ============ 主布局 ============
function App() {
  const [activeNav, setActiveNav] = useState('mesh');

  return (
    <DataProvider>
      <div className="h-screen flex flex-col">
        <TopBar />

        <div className="flex-1 flex overflow-hidden">
          <Sidebar active={activeNav} onNavigate={setActiveNav} />

          <main className="flex-1 overflow-y-auto p-4 space-y-4">
            {activeNav === 'mesh' && <MeshView />}
            {activeNav === 'tasks' && <TasksView />}
            {activeNav === 'governance' && <GovernanceView />}
            {activeNav === 'logs' && <LogsView />}
            {activeNav === 'ai' && <AIView />}
            {activeNav === 'settings' && <SettingsView />}
          </main>
        </div>
      </div>
    </DataProvider>
  );
}

// ============ 页面视图 ============
function MeshView() {
  return (
    <>
      <StatsCards />
      <div className="grid grid-cols-2 gap-4" style={{ height: 'calc(100vh - 280px)' }}>
        <div className="flex flex-col gap-4">
          <div className="flex-1">
            <MeshTopology />
          </div>
          <TaskTable />
        </div>
        <div className="flex flex-col gap-4">
          <div style={{ flex: '0 0 50%' }}>
            <StarOfficePanel />
          </div>
          <div className="flex-1">
            <EventTimeline />
          </div>
        </div>
      </div>
    </>
  );
}

function TasksView() {
  return (
    <>
      <StatsCards />
      <TaskTable />
      <div style={{ height: 'calc(100vh - 380px)' }}>
        <EventTimeline />
      </div>
    </>
  );
}

function GovernanceView() {
  return <GovernancePanel />;
}

function LogsView() {
  return (
    <div style={{ height: 'calc(100vh - 120px)' }}>
      <EventTimeline />
    </div>
  );
}

function AIView() {
  return (
    <div className="glass-card p-6 flex items-center justify-center" style={{ height: 'calc(100vh - 120px)' }}>
      <div className="text-center">
        <div className="text-lg font-heading font-semibold mb-2" style={{ color: 'var(--color-primary)' }}>
          AI Assistant
        </div>
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Coming soon — 智能调度 + 故障诊断
        </div>
      </div>
    </div>
  );
}

function SettingsView() {
  const nodes = useMeshStore((s) => s.nodes);
  const { can: canViewSettings } = usePermission('VIEW_SETTINGS');
  const { can: canModifyConfig, require: requireConfigWrite } = usePermission('MODIFY_CONFIG');
  const user = useAuthStore((s) => s.user);
  const auditLog = useAuthStore((s) => s.constitutionAuditLog);

  if (!canViewSettings) {
    return (
      <div className="glass-card p-6 flex items-center justify-center" style={{ height: 'calc(100vh - 120px)' }}>
        <div className="text-xs" style={{ color: 'var(--color-error)' }}>
          Permission Denied: settings:read required (current role: {user.role})
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-heading font-semibold" style={{ color: 'var(--text-primary)' }}>
            Cluster Configuration
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono px-2 py-0.5 rounded"
              style={{ background: 'rgba(96,165,250,0.1)', color: 'var(--color-primary)' }}>
              {user.role}
            </span>
          </div>
        </div>

        <div className="space-y-3">
          {Object.entries(nodes).map(([id, node]) => (
            <div key={id} className="glass-surface p-3 flex items-center justify-between">
              <div>
                <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                  {node.label}
                </div>
                <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                  {node.ip}
                </div>
              </div>
              <span className={`status-dot ${node.online ? 'status-online' : 'status-offline'}`} />
            </div>
          ))}
        </div>

        {canModifyConfig && (
          <div className="mt-4 pt-4 border-t border-white/[0.06]">
            <button
              onClick={() => {
                try {
                  requireConfigWrite();
                  console.log('[Settings] Config save audited');
                } catch {
                  // permission denied
                }
              }}
              className="text-xs px-3 py-1.5 rounded-lg transition-colors"
              style={{
                background: 'rgba(96,165,250,0.15)',
                color: 'var(--color-primary)',
                border: '1px solid rgba(96,165,250,0.2)',
                cursor: 'pointer',
              }}
            >
              Save Configuration (Audited)
            </button>
          </div>
        )}
      </div>

      {/* 宪法审计日志 */}
      {auditLog.length > 0 && (
        <div className="glass-card p-4">
          <div className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
            Constitution Audit Log
          </div>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {auditLog.slice(-10).reverse().map((entry, i) => (
              <div key={i} className="flex items-center gap-2 text-[10px] font-mono"
                style={{ color: 'var(--text-muted)' }}>
                <span>{new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                <span style={{ color: 'var(--color-primary)' }}>{entry.userId}</span>
                <span>{entry.permission}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
