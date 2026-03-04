/**
 * API Client + 轮询 Hooks
 */
import { useEffect, useRef } from 'react';

// ============ 端点配置 ============
const ENDPOINTS = {
  // 各节点 API
  central: { host: '10.10.0.1', healthPort: 3002, apiPort: 8080, meshPort: 3001 },
  silicon: { host: '10.10.0.2', healthPort: 3002, apiPort: 8080, meshPort: 3001 },
  tokyo:   { host: '10.10.0.3', healthPort: 3002, apiPort: 8080, meshPort: 3001 },
} as const;

type NodeId = keyof typeof ENDPOINTS;

function baseUrl(node: NodeId, port: number): string {
  return `http://${ENDPOINTS[node].host}:${port}`;
}

// ============ Fetch Wrapper ============
async function apiFetch<T>(url: string, options?: RequestInit & { timeout?: number }): Promise<T> {
  const controller = new AbortController();
  const timeout = options?.timeout ?? 5000;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

// ============ API Functions ============
export interface HealthData {
  status: string;
  uptime: number;
  version: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface QueueDepth {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}

export interface WorkerLoad {
  running: number;
  maxConcurrent: number;
  cpuUsage: number;
  memoryUsage: string;
  diskUsage: string;
}

export interface TopologyData {
  nodes: Array<{ id: string; label: string; status: string; ip: string }>;
  edges: Array<{ source: string; target: string; latency?: number }>;
}

export async function fetchHealth(node: NodeId): Promise<HealthData> {
  return apiFetch(`${baseUrl(node, ENDPOINTS[node].healthPort)}/health`);
}

export async function fetchQueueDepth(): Promise<QueueDepth> {
  return apiFetch(`${baseUrl('central', ENDPOINTS.central.apiPort)}/tools/get_queue_depth`);
}

export async function fetchWorkerLoad(): Promise<WorkerLoad> {
  return apiFetch(`${baseUrl('central', ENDPOINTS.central.apiPort)}/tools/get_worker_load`);
}

export async function fetchTopology(): Promise<TopologyData> {
  return apiFetch(`${baseUrl('central', ENDPOINTS.central.meshPort)}/api/mesh/topology`);
}

export async function batchDispatch(tasks: unknown[]): Promise<{ dispatched: number }> {
  return apiFetch(`${baseUrl('central', 8081)}/tools/batch_dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tasks }),
  });
}

// ============ 轮询 Hook ============
export function usePolling<T>(
  fetcher: () => Promise<T>,
  onData: (data: T) => void,
  intervalMs: number,
  enabled = true
) {
  const savedFetcher = useRef(fetcher);
  const savedCallback = useRef(onData);
  savedFetcher.current = fetcher;
  savedCallback.current = onData;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const data = await savedFetcher.current();
        if (!cancelled) savedCallback.current(data);
      } catch {
        // 静默处理——store 里保留上一次有效数据
      }
    };

    poll(); // 立即执行一次
    const id = setInterval(poll, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs, enabled]);
}

// ============ WebSocket Hook ============
export function useEventSocket(
  url: string,
  event: string,
  onMessage: (data: unknown) => void,
  enabled = true
) {
  const savedCallback = useRef(onMessage);
  savedCallback.current = onMessage;

  useEffect(() => {
    if (!enabled) return;

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      ws = new WebSocket(url);

      ws.onopen = () => {
        console.log(`[WS] Connected: ${url}`);
        // 订阅特定事件
        ws?.send(JSON.stringify({ subscribe: event }));
      };

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          savedCallback.current(data);
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        console.log(`[WS] Disconnected, reconnecting in 3s...`);
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [url, event, enabled]);
}

// ============ Governance API ============
const GOV_BASE = '/api/governance';

export interface GovernanceSummary {
  trust: Array<{
    agentId: string;
    score: number;
    totalTasks: number;
    successRate: number;
    avgQuality: number;
    cooldown: boolean;
  }>;
  budget: {
    hourlyUsage: number;
    dailyUsage: number;
    monthlyUsage: number;
    tier: string;
    model: string;
    canAccept: boolean;
  };
  audit: Array<{
    id: string;
    timestamp: number;
    eventType: string;
    agentId?: string;
    taskId?: string;
    decision?: string;
    details: string;
  }>;
  policies: Array<{
    id: string;
    name: string;
    level: string;
    enforcement: string;
    enabled: boolean;
  }>;
  quality: {
    total: number;
    approved: number;
    review: number;
    rejected: number;
    avgScore: number;
  };
  evolution: {
    strategy: string;
    explorationRate: number;
    diversityIndex: number;
    recentSuccessRate: number;
    capsuleCount: number;
  };
}

export async function fetchGovernanceSummary(): Promise<GovernanceSummary> {
  return apiFetch(`${GOV_BASE}/summary`);
}

export { ENDPOINTS, type NodeId };
