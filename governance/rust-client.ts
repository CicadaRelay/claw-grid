/**
 * FSC-Mesh Governance Rust Client — Thin IPC Client
 *
 * 通过 Unix socket 连接 Rust fsc-govern sidecar。
 * MessagePack 编码/解码, 长度前缀帧协议 (4 bytes big-endian + body)。
 */

import { connect, type Socket } from 'net';

import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import type {
  GovernedTask,
  TrustProfile,
  BudgetState,
  PolicyCheckResult,
  ExecutionReceipt,
} from './types';

const DEFAULT_SOCKET_PATH = '/tmp/fsc-govern.sock';
const CONNECT_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 5000;

interface RustValidationResult {
  allowed: boolean;
  violations: Array<{
    rule_id: string;
    rule_name: string;
    enforcement: string;
    penalty: number;
    details: string;
  }>;
  warnings: Array<{
    rule_id: string;
    rule_name: string;
    enforcement: string;
    penalty: number;
    details: string;
  }>;
}

interface RustRecordResult {
  trust_delta: number;
  new_trust_score: number;
  budget_tier: string;
  budget_warning: boolean;
  budget_paused: boolean;
}

interface RustHealthResult {
  uptime_secs: number;
  cached_agents: number;
  redis_connected: boolean;
}

export class GovernanceRustClient {
  private socketPath: string;
  private socket: Socket | null = null;
  private connected = false;
  private pendingResponse: {
    resolve: (data: any) => void;
    reject: (err: Error) => void;
    buffer: Buffer;
    expectedLen: number | null;
  } | null = null;

  constructor(socketPath = DEFAULT_SOCKET_PATH) {
    this.socketPath = socketPath;
  }

  /** 检查 Rust sidecar 是否可用 */
  static async isAvailable(socketPath = DEFAULT_SOCKET_PATH): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = connect(socketPath, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', () => resolve(false));
      setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, 500);
    });
  }

  /** 连接到 sidecar */
  async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connect timeout'));
      }, CONNECT_TIMEOUT_MS);

      this.socket = connect(this.socketPath, () => {
        clearTimeout(timeout);
        this.connected = true;
        this.setupSocket();
        resolve();
      });

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        this.connected = false;
        reject(err);
      });
    });
  }

  /** 断开连接 */
  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
  }

  /** 策略校验 */
  async validateTask(
    task: Partial<GovernedTask>,
    agent: Partial<TrustProfile>,
    budget: Partial<BudgetState>,
    activeTasks: number,
    maxConcurrent: number,
  ): Promise<PolicyCheckResult> {
    const resp = await this.request({
      method: 'validate_task',
      task: {
        id: task.id || '',
        risk_level: task.riskLevel || 'low',
        estimated_tokens: task.estimatedTokens || 0,
        required_trust_score: task.requiredTrustScore || 0,
      },
      agent: {
        agent_id: agent.agentId || '',
        score: agent.score || 50,
        consecutive_failures: agent.consecutiveFailures || 0,
        cooldown_until: agent.cooldownUntil || 0,
      },
      budget: {
        hourly_spent: budget.hourlySpent || 0,
        hourly_limit: budget.hourlyLimit || 0.5,
      },
      active_tasks: activeTasks,
      max_concurrent: maxConcurrent,
    });

    const data = resp.data as RustValidationResult;
    return {
      allowed: data.allowed,
      violations: data.violations.map((v) => ({
        ruleId: v.rule_id,
        ruleName: v.rule_name,
        enforcement: v.enforcement as 'hard' | 'soft',
        penalty: v.penalty,
        details: v.details,
        timestamp: Date.now(),
      })),
      warnings: data.warnings.map((v) => ({
        ruleId: v.rule_id,
        ruleName: v.rule_name,
        enforcement: v.enforcement as 'hard' | 'soft',
        penalty: v.penalty,
        details: v.details,
        timestamp: Date.now(),
      })),
    };
  }

  /** 记录执行结果 */
  async recordResult(receipt: ExecutionReceipt): Promise<RustRecordResult> {
    const resp = await this.request({
      method: 'record_result',
      receipt: {
        task_id: receipt.taskId,
        agent_id: receipt.agentId,
        duration_ms: receipt.durationMs,
        tokens_used: receipt.tokensUsed,
        cost_usd: receipt.costUSD,
        status: receipt.status,
        quality_score: receipt.qualityScore,
        failure_class: receipt.failureClass || null,
        policy_violations: receipt.policyViolations.map((v) => ({
          rule_id: v.ruleId,
          penalty: v.penalty,
        })),
      },
    });
    return resp.data as RustRecordResult;
  }

  /** 健康检查 */
  async health(): Promise<RustHealthResult> {
    const resp = await this.request({ method: 'health' });
    return resp.data as RustHealthResult;
  }

  // ============ 内部方法 ============

  private setupSocket(): void {
    if (!this.socket) return;

    this.socket.on('data', (chunk: Buffer) => {
      if (!this.pendingResponse) return;

      this.pendingResponse.buffer = Buffer.concat([this.pendingResponse.buffer, chunk]);

      // 读取长度前缀
      if (this.pendingResponse.expectedLen === null && this.pendingResponse.buffer.length >= 4) {
        this.pendingResponse.expectedLen = this.pendingResponse.buffer.readUInt32BE(0);
        this.pendingResponse.buffer = this.pendingResponse.buffer.subarray(4);
      }

      // 读取完整消息
      if (
        this.pendingResponse.expectedLen !== null &&
        this.pendingResponse.buffer.length >= this.pendingResponse.expectedLen
      ) {
        const msgBuf = this.pendingResponse.buffer.subarray(0, this.pendingResponse.expectedLen);
        const decoded = msgpackDecode(msgBuf) as any;
        this.pendingResponse.resolve(decoded);
        this.pendingResponse = null;
      }
    });

    this.socket.on('close', () => {
      this.connected = false;
      if (this.pendingResponse) {
        this.pendingResponse.reject(new Error('Connection closed'));
        this.pendingResponse = null;
      }
    });
  }

  private async request(data: any): Promise<any> {
    if (!this.connected || !this.socket) {
      await this.connect();
    }

    const encoded = Buffer.from(msgpackEncode(data));
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(encoded.length, 0);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponse = null;
        reject(new Error('Request timeout'));
      }, REQUEST_TIMEOUT_MS);

      this.pendingResponse = {
        resolve: (data) => {
          clearTimeout(timeout);
          if (data.status === 'error') {
            reject(new Error(data.message));
          } else {
            resolve(data);
          }
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        buffer: Buffer.alloc(0),
        expectedLen: null,
      };

      this.socket!.write(lenBuf);
      this.socket!.write(encoded);
    });
  }
}
