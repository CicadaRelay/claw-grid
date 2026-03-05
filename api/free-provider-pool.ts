/**
 * Free Provider Pool — 免费 LLM 负载均衡 + 熔断器
 *
 * 支持 OpenRouter / NVIDIA NIM / 自定义 OpenAI 兼容端点
 * 轮询负载均衡 + 3次失败熔断 + 60s恢复 + 健康探测
 * Redis 持久化 endpoint 配置，circuit 状态仅内存
 */

import type { RedisClientType } from 'redis';

// ============ 数据结构 ============

export interface FreeEndpoint {
  id: string;                    // "openrouter:stepfun/step-3.5-flash:free"
  provider: 'openrouter' | 'nvidia-nim' | 'custom';
  baseUrl: string;               // "https://openrouter.ai/api/v1"
  apiKey: string;
  model: string;
  enabled: boolean;
  addedAt: number;
}

export interface CircuitState {
  status: 'closed' | 'open' | 'half-open';
  failures: number;
  lastFailure: number;
  lastSuccess: number;
  totalRequests: number;
  totalFailures: number;
}

export interface FreeEndpointStatus extends FreeEndpoint {
  circuit: CircuitState;
}

export interface FreeProviderSummary {
  total: number;
  healthy: number;
  open: number;
  halfOpen: number;
}

// ============ 常量 ============

const REDIS_KEY = 'fsc:free-providers';
const FAILURE_THRESHOLD = 3;
const OPEN_TIMEOUT_MS = 60_000;     // 60s 后 open → half-open
const HEALTH_CHECK_INTERVAL = 120_000; // 2min 健康探测

// ============ 预设免费模型 ============

export const FREE_MODEL_PRESETS = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'stepfun/step-3.5-flash:free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'mistralai/mistral-7b-instruct:free',
      'google/gemma-2-9b-it:free',
    ],
  },
  'nvidia-nim': {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: [
      'meta/llama-3.1-8b-instruct',
      'nvidia/llama-3.1-nemotron-70b-instruct',
    ],
  },
} as const;

// ============ FreeProviderPool ============

export class FreeProviderPool {
  private endpoints: FreeEndpoint[] = [];
  private circuits = new Map<string, CircuitState>();
  private roundRobinIndex = 0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private redis: RedisClientType) {}

  /** 从 Redis 加载配置，启动健康检查 */
  async init(): Promise<void> {
    try {
      const raw = await this.redis.get(REDIS_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        this.endpoints = data.endpoints || [];
      }
    } catch (e: any) {
      console.error('[FreePool] Init load error:', e.message);
    }

    // 为所有 endpoint 初始化 circuit 状态
    for (const ep of this.endpoints) {
      if (!this.circuits.has(ep.id)) {
        this.circuits.set(ep.id, this.newCircuit());
      }
    }

    // 启动健康检查定时器
    this.healthTimer = setInterval(() => this.healthCheck(), HEALTH_CHECK_INTERVAL);

    console.log(`[FreePool] Initialized with ${this.endpoints.length} endpoints`);
  }

  /** 停止健康检查 */
  destroy(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  // ============ CRUD ============

  async addEndpoint(ep: Omit<FreeEndpoint, 'id' | 'addedAt'>): Promise<FreeEndpoint> {
    const id = `${ep.provider}:${ep.model}`;
    const existing = this.endpoints.find(e => e.id === id);
    if (existing) {
      // 更新已存在的
      Object.assign(existing, ep);
      await this.persist();
      return existing;
    }

    const endpoint: FreeEndpoint = {
      ...ep,
      id,
      addedAt: Date.now(),
    };
    this.endpoints.push(endpoint);
    this.circuits.set(id, this.newCircuit());
    await this.persist();
    console.log(`[FreePool] Added endpoint: ${id}`);
    return endpoint;
  }

  async removeEndpoint(id: string): Promise<boolean> {
    const idx = this.endpoints.findIndex(e => e.id === id);
    if (idx < 0) return false;
    this.endpoints.splice(idx, 1);
    this.circuits.delete(id);
    await this.persist();
    console.log(`[FreePool] Removed endpoint: ${id}`);
    return true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const ep = this.endpoints.find(e => e.id === id);
    if (!ep) return false;
    ep.enabled = enabled;
    await this.persist();
    return true;
  }

  // ============ 负载均衡 ============

  /** 轮询获取下一个可用 endpoint（跳过 disabled 和 circuit open 的） */
  getNextEndpoint(): FreeEndpoint | null {
    const available = this.endpoints.filter(ep => {
      if (!ep.enabled) return false;
      const circuit = this.circuits.get(ep.id);
      if (!circuit) return true;

      // open 状态检查是否超时 → 转 half-open
      if (circuit.status === 'open') {
        if (Date.now() - circuit.lastFailure >= OPEN_TIMEOUT_MS) {
          circuit.status = 'half-open';
          return true;
        }
        return false;
      }
      return true; // closed 或 half-open 都可用
    });

    if (available.length === 0) return null;

    this.roundRobinIndex = this.roundRobinIndex % available.length;
    const ep = available[this.roundRobinIndex];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % available.length;
    return ep;
  }

  // ============ 熔断器反馈 ============

  reportSuccess(id: string): void {
    const circuit = this.circuits.get(id);
    if (!circuit) return;

    circuit.totalRequests++;
    circuit.lastSuccess = Date.now();
    circuit.failures = 0;

    // half-open → closed
    if (circuit.status === 'half-open') {
      circuit.status = 'closed';
      console.log(`[FreePool] Circuit CLOSED: ${id}`);
    }
  }

  reportFailure(id: string): void {
    const circuit = this.circuits.get(id);
    if (!circuit) return;

    circuit.totalRequests++;
    circuit.totalFailures++;
    circuit.failures++;
    circuit.lastFailure = Date.now();

    // half-open 失败 → 回到 open
    if (circuit.status === 'half-open') {
      circuit.status = 'open';
      console.log(`[FreePool] Circuit OPEN (half-open failed): ${id}`);
      return;
    }

    // closed → 达到阈值 → open
    if (circuit.status === 'closed' && circuit.failures >= FAILURE_THRESHOLD) {
      circuit.status = 'open';
      console.log(`[FreePool] Circuit OPEN (${circuit.failures} failures): ${id}`);
    }
  }

  // ============ 状态查询 ============

  getStatus(): FreeEndpointStatus[] {
    return this.endpoints.map(ep => ({
      ...ep,
      circuit: this.circuits.get(ep.id) || this.newCircuit(),
    }));
  }

  getSummary(): FreeProviderSummary {
    let healthy = 0, open = 0, halfOpen = 0;
    for (const ep of this.endpoints) {
      if (!ep.enabled) continue;
      const c = this.circuits.get(ep.id);
      if (!c || c.status === 'closed') healthy++;
      else if (c.status === 'open') open++;
      else if (c.status === 'half-open') halfOpen++;
    }
    return { total: this.endpoints.length, healthy, open, halfOpen };
  }

  // ============ 内部方法 ============

  private newCircuit(): CircuitState {
    return {
      status: 'closed',
      failures: 0,
      lastFailure: 0,
      lastSuccess: 0,
      totalRequests: 0,
      totalFailures: 0,
    };
  }

  /** 持久化到 Redis */
  private async persist(): Promise<void> {
    try {
      await this.redis.set(REDIS_KEY, JSON.stringify({ endpoints: this.endpoints }));
    } catch (e: any) {
      console.error('[FreePool] Persist error:', e.message);
    }
  }

  /** 健康检查: 探测 open 状态的 endpoint */
  private async healthCheck(): Promise<void> {
    for (const ep of this.endpoints) {
      if (!ep.enabled) continue;
      const circuit = this.circuits.get(ep.id);
      if (!circuit || circuit.status !== 'open') continue;

      // 超时检查
      if (Date.now() - circuit.lastFailure < OPEN_TIMEOUT_MS) continue;

      try {
        const resp = await fetch(`${ep.baseUrl}/models`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${ep.apiKey}`,
          },
          signal: AbortSignal.timeout(5000),
        });

        if (resp.ok) {
          circuit.status = 'half-open';
          console.log(`[FreePool] Health check passed, half-open: ${ep.id}`);
        }
      } catch {
        // 探测失败，保持 open
      }
    }
  }
}
