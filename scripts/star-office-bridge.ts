#!/usr/bin/env bun
/**
 * Star Office Bridge v1.1
 * Redis fsc:results + fsc:mem_events + fsc:heartbeats → Star Office UI API
 *
 * v1.1 新增：
 * - TaskID 本地缓存保序（同一任务的事件按时间戳排序后处理）
 * - 心跳阈值配置化（env / 按 Agent 类型动态调整）
 * - Agent 注册指数退避重试 + 本地缓存防重复
 * - Star Office 不可用时的离线降级
 */

import Redis from 'ioredis';

// ============ 配置 ============
const REDIS_HOST = process.env.REDIS_HOST || '10.10.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || 'fsc-mesh-2026';
const STAR_OFFICE_URL = process.env.STAR_OFFICE_URL || 'http://localhost:18791';
const CONSUMER_GROUP = 'star-office-bridge';
const CONSUMER_NAME = `bridge-${process.env.HOSTNAME || 'local'}`;
const RESULT_STREAM = 'fsc:results';
const MEM_EVENTS_STREAM = 'fsc:mem_events';
const HEARTBEAT_STREAM = 'fsc:heartbeats';

// 可配置心跳超时（秒）
const HEARTBEAT_TIMEOUT_DEFAULT = parseInt(process.env.HEARTBEAT_TIMEOUT || '300');
const HEARTBEAT_TIMEOUT_BY_TYPE: Record<string, number> = {
  offline_worker: 1800,   // 离线任务 30 分钟
  lightweight: 120,       // 轻量任务 2 分钟
  critical: 60,           // 关键任务 1 分钟
};

// ============ 状态映射 ============
type StarOfficeStatus = 'idle' | 'writing' | 'researching' | 'executing' | 'syncing' | 'error';

interface AgentState {
  agentId: string;
  status: StarOfficeStatus;
  message: string;
  lastSeen: number;
  agentType: string;
  registered: boolean; // 本地注册缓存
}

const agentStates = new Map<string, AgentState>();

// ============ Star Office 可用性检测 ============
let starOfficeAvailable = true;
let lastAvailabilityCheck = 0;

async function checkStarOfficeAvailability(): Promise<boolean> {
  if (Date.now() - lastAvailabilityCheck < 10000) return starOfficeAvailable;
  lastAvailabilityCheck = Date.now();

  try {
    const res = await fetch(`${STAR_OFFICE_URL}/status`, {
      signal: AbortSignal.timeout(3000),
    });
    starOfficeAvailable = res.ok;
  } catch {
    starOfficeAvailable = false;
  }

  if (!starOfficeAvailable) {
    console.warn('[StarOffice] Service unavailable, operating in offline mode');
  }
  return starOfficeAvailable;
}

// ============ Redis ============
const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  retryStrategy: (times) => Math.min(times * 200, 3000),
  maxRetriesPerRequest: null,
});

redis.on('error', (err) => console.error('[Redis]', err.message));
redis.on('connect', () => console.log('[Redis] Connected'));

// ============ Star Office API（带超时）============
async function pushAgentStatus(agentId: string, status: StarOfficeStatus, bubble: string) {
  if (!await checkStarOfficeAvailability()) return;

  try {
    const res = await fetch(`${STAR_OFFICE_URL}/agent-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        status,
        bubble_message: bubble,
        timestamp: Date.now(),
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.error(`[StarOffice] Push failed (${res.status})`);
    }
  } catch (err: any) {
    console.error(`[StarOffice] Push error: ${err.message}`);
    starOfficeAvailable = false;
  }
}

// ============ Agent 注册：指数退避重试 + 本地缓存 ============
async function registerAgent(agentId: string, displayName?: string): Promise<void> {
  const existing = agentStates.get(agentId);
  if (existing?.registered) {
    // 已注册过，只刷新心跳
    return;
  }

  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (!await checkStarOfficeAvailability()) {
      // Star Office 不可用，标记为待注册，后续恢复时批量注册
      console.warn(`[Registry] ${agentId} deferred (StarOffice unavailable)`);
      return;
    }

    try {
      const res = await fetch(`${STAR_OFFICE_URL}/join-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId,
          display_name: displayName || agentId,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        const state = agentStates.get(agentId);
        if (state) state.registered = true;
        console.log(`[Registry] Agent registered: ${agentId}`);
        return;
      }

      console.error(`[Registry] Join failed (${res.status}), attempt ${attempt + 1}/${MAX_RETRIES}`);
    } catch (err: any) {
      console.error(`[Registry] Join error (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}`);
      starOfficeAvailable = false;
    }

    // 指数退避：1s → 2s → 4s → 8s → 16s (最大 60s)
    const delay = Math.min(1000 * Math.pow(2, attempt), 60000);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  console.error(`[Registry] ${agentId} registration failed after ${MAX_RETRIES} attempts`);
}

// ============ 事件排序缓冲区（按 TaskID 保序）============
interface BufferedEvent {
  data: Record<string, string>;
  stream: string;
  timestamp: number;
}

class TaskEventOrderer {
  private buffers = new Map<string, BufferedEvent[]>();
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly MAX_BUFFER_MS = 2000; // 最大等待 2 秒

  add(taskId: string, event: BufferedEvent, processor: (events: BufferedEvent[]) => Promise<void>) {
    const buffer = this.buffers.get(taskId) || [];
    buffer.push(event);
    this.buffers.set(taskId, buffer);

    // 重置定时器
    const existing = this.flushTimers.get(taskId);
    if (existing) clearTimeout(existing);

    this.flushTimers.set(taskId, setTimeout(async () => {
      await this.flush(taskId, processor);
    }, this.MAX_BUFFER_MS));
  }

  async flush(taskId: string, processor: (events: BufferedEvent[]) => Promise<void>) {
    const buffer = this.buffers.get(taskId);
    if (!buffer || buffer.length === 0) return;

    // 按时间戳排序
    buffer.sort((a, b) => a.timestamp - b.timestamp);

    await processor(buffer);

    this.buffers.delete(taskId);
    const timer = this.flushTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(taskId);
    }
  }

  // 无 TaskID 的事件直接处理
  async processImmediate(event: BufferedEvent, processor: (events: BufferedEvent[]) => Promise<void>) {
    await processor([event]);
  }
}

const eventOrderer = new TaskEventOrderer();

// ============ 事件处理 ============
function ensureAgent(agentId: string, agentType = 'default') {
  if (!agentStates.has(agentId)) {
    agentStates.set(agentId, {
      agentId,
      status: 'idle',
      message: '',
      lastSeen: Date.now(),
      agentType,
      registered: false,
    });
    registerAgent(agentId);
  }
}

function getHeartbeatTimeout(agentId: string): number {
  const state = agentStates.get(agentId);
  if (state) {
    const byType = HEARTBEAT_TIMEOUT_BY_TYPE[state.agentType];
    if (byType) return byType * 1000;
  }
  return HEARTBEAT_TIMEOUT_DEFAULT * 1000;
}

async function processOrderedEvents(events: BufferedEvent[]) {
  for (const event of events) {
    if (event.stream === RESULT_STREAM) {
      await handleResultEvent(event.data);
    } else if (event.stream === MEM_EVENTS_STREAM) {
      await handleMemEvent(event.data);
    } else if (event.stream === HEARTBEAT_STREAM) {
      await handleHeartbeat(event.data);
    }
  }
}

async function handleResultEvent(data: Record<string, string>) {
  const agentId = data.agent_id || data.task_id?.split('-')[0] || 'unknown';
  const status = data.status;
  const taskId = data.task_id || 'unknown';

  ensureAgent(agentId);

  if (status === 'success') {
    await pushAgentStatus(agentId, 'writing', `任务完成 ✓ (${taskId})`);
    const state = agentStates.get(agentId)!;
    state.status = 'writing';
    state.lastSeen = Date.now();

    setTimeout(async () => {
      await pushAgentStatus(agentId, 'idle', '等待新任务...');
      const s = agentStates.get(agentId);
      if (s) { s.status = 'idle'; s.lastSeen = Date.now(); }
    }, 2000);
  } else if (status === 'failure' || status === 'timeout') {
    const preview = (data.error || '未知错误').slice(0, 50);
    await pushAgentStatus(agentId, 'error', `出错了: ${preview}`);
    const state = agentStates.get(agentId)!;
    state.status = 'error';
    state.lastSeen = Date.now();

    setTimeout(async () => {
      await pushAgentStatus(agentId, 'idle', '已恢复');
      const s = agentStates.get(agentId);
      if (s) { s.status = 'idle'; s.lastSeen = Date.now(); }
    }, 10000);
  }
}

async function handleMemEvent(data: Record<string, string>) {
  const agentId = data.agent_id || 'system';
  const type = data.type;

  ensureAgent(agentId);
  const state = agentStates.get(agentId)!;
  state.lastSeen = Date.now();

  switch (type) {
    case 'task_started':
      await pushAgentStatus(agentId, 'executing', `正在执行任务 ${data.task_id || ''}...`);
      state.status = 'executing';
      break;

    case 'task_complete':
      await pushAgentStatus(agentId, 'writing', '任务完成，保存中...');
      state.status = 'writing';
      setTimeout(async () => {
        await pushAgentStatus(agentId, 'idle', '任务完成 ✓');
        const s = agentStates.get(agentId);
        if (s) { s.status = 'idle'; }
      }, 2000);
      break;

    case 'context_update':
    case 'shared_update':
      await pushAgentStatus(agentId, 'syncing', '同步记忆...');
      setTimeout(async () => {
        await pushAgentStatus(agentId, 'idle', '同步完成');
      }, 3000);
      break;

    case 'config_changed':
      await pushAgentStatus(agentId, 'syncing', '配置更新...');
      break;

    case 'network_healed':
      await pushAgentStatus(agentId, 'idle', '网络恢复 ✓');
      break;

    case 'worker_shutdown':
      await pushAgentStatus(agentId, 'idle', '已下线');
      break;
  }
}

async function handleHeartbeat(data: Record<string, string>) {
  const agentId = data.agent || 'unknown';
  const agentType = data.agent_type || 'default';

  ensureAgent(agentId, agentType);

  const state = agentStates.get(agentId)!;
  state.lastSeen = Date.now();
  state.agentType = agentType;

  const activeTasks = parseInt(data.active_tasks || '0');
  if (activeTasks > 0 && state.status === 'idle') {
    await pushAgentStatus(agentId, 'executing', `执行中 (${activeTasks} 任务)`);
    state.status = 'executing';
  }
}

// ============ Stream 消费者 ============
async function ensureGroup(stream: string) {
  try {
    await redis.xgroup('CREATE', stream, CONSUMER_GROUP, '0', 'MKSTREAM');
    console.log(`[Redis] Group created: ${stream}/${CONSUMER_GROUP}`);
  } catch (err: any) {
    if (!err.message?.includes('BUSYGROUP')) throw err;
  }
}

function parseStreamFields(fields: string[]): Record<string, string> {
  const data: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    data[fields[i]] = fields[i + 1];
  }
  return data;
}

async function consumeStreams() {
  await ensureGroup(RESULT_STREAM);
  await ensureGroup(MEM_EVENTS_STREAM);
  await ensureGroup(HEARTBEAT_STREAM);

  console.log('[Bridge] Consuming streams (with event ordering + retry)...');

  while (true) {
    try {
      const results = await redis.xreadgroup(
        'GROUP', CONSUMER_GROUP, CONSUMER_NAME,
        'BLOCK', 5000,
        'COUNT', 50,
        'STREAMS',
        RESULT_STREAM, MEM_EVENTS_STREAM, HEARTBEAT_STREAM,
        '>', '>', '>'
      );

      if (!results) continue;

      for (const [stream, messages] of results) {
        for (const [id, fields] of messages) {
          const data = parseStreamFields(fields);
          const timestamp = parseInt(data.timestamp || '0') || Date.now();
          const taskId = data.task_id;

          const bufferedEvent: BufferedEvent = { data, stream, timestamp };

          if (taskId) {
            // 有 TaskID → 缓冲保序
            eventOrderer.add(taskId, bufferedEvent, processOrderedEvents);
          } else {
            // 无 TaskID → 立即处理
            await eventOrderer.processImmediate(bufferedEvent, processOrderedEvents);
          }

          await redis.xack(stream, CONSUMER_GROUP, id);
        }
      }
    } catch (err: any) {
      console.error('[Bridge] Stream error:', err.message);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// ============ 过期 Agent 清理（配置化心跳阈值）============
setInterval(async () => {
  const now = Date.now();

  // 先检查 Star Office 恢复情况，批量注册未注册的 Agent
  if (await checkStarOfficeAvailability()) {
    for (const [agentId, state] of agentStates) {
      if (!state.registered) {
        registerAgent(agentId);
      }
    }
  }

  for (const [agentId, state] of agentStates) {
    const timeout = getHeartbeatTimeout(agentId);
    if (now - state.lastSeen > timeout && state.status !== 'idle') {
      await pushAgentStatus(agentId, 'idle', '连接超时');
      state.status = 'idle';
    }
  }
}, 30000);

// ============ 启动 ============
console.log('[Star Office Bridge] v1.1 Starting...');
console.log(`[Redis] ${REDIS_HOST}:${REDIS_PORT}`);
console.log(`[StarOffice] ${STAR_OFFICE_URL}`);
console.log(`[Heartbeat] Default timeout: ${HEARTBEAT_TIMEOUT_DEFAULT}s`);
console.log(`[Streams] ${RESULT_STREAM}, ${MEM_EVENTS_STREAM}, ${HEARTBEAT_STREAM}`);

consumeStreams();

// ============ 优雅退出 ============
async function shutdown(signal: string) {
  console.log(`[Bridge] ${signal}, shutting down...`);
  await redis.quit();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
