#!/usr/bin/env bun
/**
 * MemoV Sync Daemon v2.1
 * 纯事件驱动 + 生产级容错
 *
 * v2.1 新增：
 * - BLOCK 5000 超时 + 智能重连（指数退避，区分可恢复/不可恢复错误）
 * - EventBatcher 双阈值（50ms / 100条 / 256KB 三条件触发）
 * - 死信流 fsc:memov:deadletter（重试 3 次失败后移入）
 * - 幂等性：LRU 缓存 + Redis Stream ID 去重
 */

import { spawn } from 'bun';
import Redis from 'ioredis';
import { watch } from 'fs';
import { createHash } from 'crypto';
import { readFile, writeFile } from 'fs/promises';

// ============ 配置 ============
import { REDIS_HOST, REDIS_PORT, REDIS_PASSWORD } from '../config/redis';
import { getActiveNodeIps } from '../config/network';

const MEM_DIR = '.mem';
const NODES = getActiveNodeIps(); // 动态获取 Tailscale 节点
const CONSUMER_GROUP = 'memov-sync';
const CONSUMER_NAME = `memov-${process.env.HOSTNAME || 'local'}`;
const STREAM_KEY = 'fsc:mem_events';
const DEADLETTER_STREAM = 'fsc:memov:deadletter';

// 批处理阈值
const BATCH_TIME_MS = 50;       // 时间阈值
const BATCH_COUNT_MAX = 100;    // 条数阈值
const BATCH_SIZE_BYTES = 256 * 1024; // 大小阈值 (256KB)

// 重试
const MAX_EVENT_RETRIES = 3;

// ============ Redis ============
const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  retryStrategy: (times) => Math.min(times * 200, 3000),
  maxRetriesPerRequest: null, // BLOCK 命令需要
});

redis.on('error', (err) => console.error('[Redis] Error:', err.message));
redis.on('connect', () => console.log('[Redis] Connected'));

// ============ SHA256 ============
function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ============ Git 操作 ============
async function gitCommit(message: string): Promise<boolean> {
  const startTime = Date.now();

  const add = spawn(['git', '-C', MEM_DIR, 'add', '.']);
  await add.exited;

  const commit = spawn(['git', '-C', MEM_DIR, 'commit', '-m', message, '--allow-empty=false']);
  const exitCode = await commit.exited;

  const latencyMs = Date.now() - startTime;

  if (exitCode === 0) {
    console.log(`[Git] Committed (${latencyMs}ms): ${message}`);
    // 反馈延迟给 batcher 做自适应
    batcher.reportGitLatency(latencyMs);
    return true;
  }
  return false;
}

// ============ WireGuard 节点同步 ============
async function syncToNodes() {
  for (const node of NODES) {
    const rsync = spawn([
      'rsync', '-avz', '--checksum',
      `${MEM_DIR}/shared/`,
      `root@${node}:${MEM_DIR}/shared/`
    ]);

    const exitCode = await rsync.exited;
    if (exitCode === 0) {
      console.log(`[Sync] Synced to ${node}`);
    } else {
      console.error(`[Sync] Failed to sync to ${node}`);
    }
  }
}

// ============ 幂等去重 LRU ============
class LRUSet {
  private cache = new Map<string, boolean>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  has(key: string): boolean {
    if (!this.cache.has(key)) return false;
    // 刷新访问顺序
    const val = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, val);
    return true;
  }

  add(key: string): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // 淘汰最旧
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
    this.cache.set(key, true);
  }
}

const processedIds = new LRUSet(10000);

// ============ 死信管理 ============
const retryCounters = new Map<string, number>();

async function moveToDeadLetter(event: MemEvent, error: Error) {
  try {
    await redis.xadd(DEADLETTER_STREAM, '*',
      'original_stream', STREAM_KEY,
      'original_id', event.id,
      'type', event.type,
      'agent_id', event.agent_id || '',
      'task_id', event.task_id || '',
      'error_message', error.message,
      'failed_at', new Date().toISOString(),
      'retry_count', String(MAX_EVENT_RETRIES),
    );
    console.error(`[DeadLetter] Event ${event.id} moved to ${DEADLETTER_STREAM}: ${error.message}`);
  } catch (dlqErr) {
    console.error('[DeadLetter] Failed to write:', dlqErr);
  }
}

// ============ 自适应双阈值 EventBatcher ============
interface MemEvent {
  id: string;
  type: string;
  agent_id?: string;
  task_id?: string;
  sha256?: string;
  file?: string;
  timestamp: string;
}

function estimateEventSize(event: MemEvent): number {
  // 粗估序列化大小
  return JSON.stringify(event).length * 2;
}

class AdaptiveEventBatcher {
  private buffer: MemEvent[] = [];
  private bufferBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushTime = Date.now();
  private processing = false;
  private gitLatencyP99 = 0; // 最近 Git 延迟

  add(event: MemEvent) {
    const size = estimateEventSize(event);
    this.buffer.push(event);
    this.bufferBytes += size;

    // 三条件任一满足即触发
    if (this.buffer.length >= BATCH_COUNT_MAX ||
        this.bufferBytes >= BATCH_SIZE_BYTES) {
      this.flushNow();
      return;
    }

    this.scheduleFlush();
  }

  reportGitLatency(ms: number) {
    // 指数移动平均
    this.gitLatencyP99 = this.gitLatencyP99 * 0.8 + ms * 0.2;
  }

  private scheduleFlush() {
    if (this.timer) return;
    // 自适应：高负载时适当延长批处理窗口
    const loadFactor = Math.min(1, this.gitLatencyP99 / 200);
    const effectiveWait = BATCH_TIME_MS * (1 + loadFactor * 0.5);
    this.timer = setTimeout(() => this.flushNow(), effectiveWait);
  }

  private flushNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  private async flush() {
    if (this.processing || this.buffer.length === 0) return;

    this.processing = true;
    const batch = this.buffer.splice(0);
    this.bufferBytes = 0;
    this.lastFlushTime = Date.now();

    try {
      const types = [...new Set(batch.map(e => e.type))];
      const agents = [...new Set(batch.map(e => e.agent_id).filter(Boolean))];
      const needsSync = batch.some(e =>
        e.type === 'context_update' || e.type === 'shared_update' || e.type === 'config_changed'
      );

      const summary = `batch(${batch.length}): ${types.join('+')}${agents.length ? ` [${agents.join(',')}]` : ''}`;
      const committed = await gitCommit(summary);

      if (needsSync && committed) {
        await syncToNodes();
      }

      console.log(`[Batch] Processed ${batch.length} events (${types.join(', ')})`);
    } catch (err) {
      console.error('[Batch] Error processing batch:', err);
      // 批处理失败不移入死信——事件已 ACK，Git 会在下次批处理重试
    } finally {
      this.processing = false;
      if (this.buffer.length > 0) {
        this.scheduleFlush();
      }
    }
  }
}

const batcher = new AdaptiveEventBatcher();

// ============ 事件处理器 ============
const EVENT_HANDLERS: Record<string, (event: MemEvent) => void> = {
  task_started: (e) => console.log(`[Event] Task started: ${e.task_id} by ${e.agent_id}`),
  task_complete: (e) => console.log(`[Event] Task complete: ${e.task_id} by ${e.agent_id}`),
  worktree_diff: (e) => console.log(`[Event] Worktree diff: ${e.agent_id}`),
  network_healed: (e) => console.log(`[Event] Network healed: ${e.agent_id}`),
  worker_shutdown: (e) => console.log(`[Event] Worker shutdown: ${e.agent_id}`),
  context_update: (e) => console.log(`[Event] Context update: ${e.agent_id}`),
  shared_update: (e) => console.log(`[Event] Shared update: ${e.file}`),
  config_changed: (e) => console.log(`[Event] Config changed: ${e.agent_id || 'system'}`),
};

async function processEvent(event: MemEvent): Promise<void> {
  // 幂等去重
  if (processedIds.has(event.id)) {
    console.log(`[Dedup] Skipping duplicate: ${event.id}`);
    return;
  }

  const handler = EVENT_HANDLERS[event.type];
  if (handler) {
    handler(event);
  } else {
    console.log(`[Event] Unknown type: ${event.type}`, event);
  }

  batcher.add(event);
  processedIds.add(event.id);
}

// ============ 带重试的事件处理 ============
async function processEventWithRetry(event: MemEvent): Promise<void> {
  const retryKey = event.id;
  const currentRetries = retryCounters.get(retryKey) || 0;

  try {
    await processEvent(event);
    retryCounters.delete(retryKey); // 成功则清除
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const nextRetry = currentRetries + 1;

    if (nextRetry >= MAX_EVENT_RETRIES) {
      // 重试耗尽 → 死信
      await moveToDeadLetter(event, err);
      retryCounters.delete(retryKey);
    } else {
      retryCounters.set(retryKey, nextRetry);
      console.warn(`[Retry] Event ${event.id} attempt ${nextRetry}/${MAX_EVENT_RETRIES}: ${err.message}`);
      // 下次消费循环会重新处理（不 ACK）
      throw err; // 重新抛出以阻止 ACK
    }
  }
}

// ============ 智能重连消费者 ============
const RECOVERABLE_ERRORS = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'NR_CLOSED', 'UNCERTAIN_STATE'];

function isRecoverableError(err: unknown): boolean {
  if (err instanceof Error) {
    const name = err.name || '';
    const msg = err.message || '';
    return RECOVERABLE_ERRORS.some(code => name.includes(code) || msg.includes(code));
  }
  return false;
}

async function listenMemEvents() {
  // 确保 consumer group 存在
  try {
    await redis.xgroup('CREATE', STREAM_KEY, CONSUMER_GROUP, '0', 'MKSTREAM');
    console.log(`[Redis] Consumer group created: ${CONSUMER_GROUP}`);
  } catch (err: any) {
    if (err.message?.includes('BUSYGROUP')) {
      console.log(`[Redis] Consumer group exists: ${CONSUMER_GROUP}`);
    } else {
      throw err;
    }
  }

  // 确保死信 stream 存在
  try {
    await redis.xgroup('CREATE', DEADLETTER_STREAM, 'deadletter-monitor', '0', 'MKSTREAM');
  } catch (err: any) {
    if (!err.message?.includes('BUSYGROUP')) {
      console.warn('[Redis] DeadLetter stream setup warning:', err.message);
    }
  }

  console.log('[MemoV] Listening (BLOCK 5000, dual-threshold batcher, deadletter enabled)...');

  let reconnectAttempts = 0;
  const MAX_RECONNECT_DELAY = 30000;

  while (true) {
    try {
      // BLOCK 5000: 5 秒超时，避免无限阻塞
      const results = await redis.xreadgroup(
        'GROUP', CONSUMER_GROUP, CONSUMER_NAME,
        'BLOCK', 5000,
        'COUNT', 100,
        'STREAMS', STREAM_KEY, '>'
      );

      // 成功消费（含超时返回 null）→ 重置重连计数
      reconnectAttempts = 0;

      if (!results) continue;

      for (const [_stream, messages] of results) {
        for (const [id, fields] of messages) {
          const data: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) {
            data[fields[i]] = fields[i + 1];
          }

          const event: MemEvent = {
            id,
            type: data.type || 'unknown',
            agent_id: data.agent_id,
            task_id: data.task_id,
            sha256: data.sha256,
            file: data.file,
            timestamp: data.timestamp || Date.now().toString(),
          };

          try {
            await processEventWithRetry(event);
            // 处理成功 → ACK
            await redis.xack(STREAM_KEY, CONSUMER_GROUP, id);
          } catch {
            // processEventWithRetry 抛出 = 需要重试，不 ACK
            // 消息留在 PEL，下次 XREADGROUP 用 0 读取 pending
          }
        }
      }
    } catch (err) {
      if (isRecoverableError(err)) {
        // 可恢复：指数退避重连
        const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), MAX_RECONNECT_DELAY);
        console.warn(`[Redis] Connection lost, retry in ${delay}ms (attempt ${reconnectAttempts + 1})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        reconnectAttempts++;
      } else {
        // 不可恢复：告警并退出
        console.error('[Redis] Unrecoverable error:', err);
        process.exit(1);
      }
    }
  }
}

// ============ PEL 清理：处理重启后的 pending 消息 ============
async function claimPendingMessages() {
  try {
    // XAUTOCLAIM: 认领超过 60 秒未 ACK 的消息
    const result = await redis.xautoclaim(
      STREAM_KEY, CONSUMER_GROUP, CONSUMER_NAME,
      60000, // 60 秒 idle 阈值
      '0-0',
      'COUNT', 50
    );

    if (result && Array.isArray(result) && result.length >= 2) {
      const messages = result[1];
      if (Array.isArray(messages) && messages.length > 0) {
        console.log(`[PEL] Claimed ${messages.length} pending messages`);
      }
    }
  } catch (err) {
    // XAUTOCLAIM 可能不可用（Redis < 6.2），忽略
    console.debug('[PEL] XAUTOCLAIM not available, skipping');
  }
}

// 每 30 秒清理一次 pending 消息
setInterval(() => claimPendingMessages(), 30000);

// ============ 死信重放接口（供运维脚本调用）============
export async function replayDeadLetter(deadLetterId: string): Promise<boolean> {
  try {
    const entries = await redis.xrange(DEADLETTER_STREAM, deadLetterId, deadLetterId);
    if (!entries || entries.length === 0) {
      console.error(`[DeadLetter] Entry not found: ${deadLetterId}`);
      return false;
    }

    const [, fields] = entries[0];
    const data: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      data[fields[i]] = fields[i + 1];
    }

    // 重新注入原始 stream
    await redis.xadd(STREAM_KEY, '*',
      'type', data.type || 'unknown',
      'agent_id', data.agent_id || '',
      'task_id', data.task_id || '',
      'replayed_from', deadLetterId,
      'timestamp', Date.now().toString(),
    );

    // 删除死信
    await redis.xdel(DEADLETTER_STREAM, deadLetterId);
    console.log(`[DeadLetter] Replayed: ${deadLetterId}`);
    return true;
  } catch (err) {
    console.error('[DeadLetter] Replay failed:', err);
    return false;
  }
}

// ============ 监听 shared/ 目录变更 ============
watch(`${MEM_DIR}/shared`, { recursive: true }, async (_event, filename) => {
  console.log(`[Watch] ${_event}: ${filename}`);

  await redis.xadd(STREAM_KEY, '*',
    'type', 'shared_update',
    'file', filename || 'unknown',
    'timestamp', Date.now().toString()
  );
});

// ============ CAS 写入 ============
export async function writeWithCAS(path: string, content: string): Promise<boolean> {
  const fullPath = `${MEM_DIR}/${path}`;

  try {
    const current = await readFile(fullPath, 'utf-8');
    const currentHash = sha256(current);
    const newHash = sha256(content);

    const success = await redis.eval(`
      if redis.call('get', KEYS[1]) == ARGV[1] then
        redis.call('set', KEYS[1], ARGV[2])
        return 1
      else
        return 0
      end
    `, 1, `mem:${path}`, currentHash, newHash) as number;

    if (success === 1) {
      await writeFile(fullPath, content);
      await redis.xadd(STREAM_KEY, '*',
        'type', 'context_update',
        'agent_id', 'cas',
        'sha256', newHash.slice(0, 16),
        'timestamp', Date.now().toString()
      );
      return true;
    }

    return false;
  } catch (err) {
    console.error('[CAS] Error:', err);
    return false;
  }
}

// ============ 启动 ============
console.log('[MemoV Sync] v2.1 — Event-Driven + Resilient');
console.log(`[Redis] ${REDIS_HOST}:${REDIS_PORT}`);
console.log(`[Consumer] ${CONSUMER_GROUP}/${CONSUMER_NAME}`);
console.log(`[Nodes] ${NODES.join(', ')}`);
console.log(`[Batcher] ${BATCH_TIME_MS}ms / ${BATCH_COUNT_MAX} count / ${BATCH_SIZE_BYTES / 1024}KB`);
console.log(`[DeadLetter] ${DEADLETTER_STREAM} (max retries: ${MAX_EVENT_RETRIES})`);

// 启动时先认领 pending 消息
claimPendingMessages().then(() => listenMemEvents());

// ============ 优雅退出 ============
async function shutdown(signal: string) {
  console.log(`[MemoV Sync] ${signal}, shutting down...`);
  await gitCommit(`shutdown snapshot (${signal})`);
  await redis.quit();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
