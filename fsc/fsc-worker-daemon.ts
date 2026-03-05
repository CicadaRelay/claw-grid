#!/usr/bin/env bun
/**
 * FSC Worker Daemon v0.3.0
 * 符合 FSC-MESH 规范 + WireGuard Mesh 集成 + 主动自愈引擎
 * 
 * v0.3.0 新增：
 * - 主动自愈引擎（Proactive Healing Engine）
 *   - 僵尸容器清理（防宿主机磁盘爆炸）
 *   - 网络断联主动自救（连续 3 次 ping 失败自动重启 WireGuard）
 *   - 主动心跳与资源上报（CPU、内存、磁盘、任务数）
 * 
 * v0.2.0 功能：
 * - 分布式锁（Redis SETNX）防止多节点重复执行
 * - 锁自动过期（5分钟）防止死锁
 * - 锁释放保证（try-finally）
 * 
 * v0.1.0 功能：
 * - Redis Streams (XREADGROUP+XACK) 替代 BLPOP
 * - Semaphore 并发控制 + finally 释放
 * - unhandledRejection + DLQ
 * - SIGTERM → drain → exit
 * - MemoV per-agent-branch
 * - Event-driven snapshot
 */

import { createClient } from 'redis';
import { DockerInstance } from './packages/core/src/dockerInstance';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { FscCodec } from '../c/fsc-codec/ffi-bun';
import { resolve } from 'path';

// C codec for zero-copy heartbeat encoding (fallback to msgpack if unavailable)
let fscCodec: FscCodec | null = null;
try {
  fscCodec = new FscCodec(resolve(import.meta.dir, '../c/fsc-codec/libfsc-ffi.so'));
} catch { /* C codec not available, using TS fallback */ }
import winston from 'winston';

// ============ 配置 ============
const REDIS_HOST = process.env.REDIS_HOST || '10.10.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const STREAM_KEY = 'fsc:tasks';
const CONSUMER_GROUP = 'fsc-workers';
const CONSUMER_NAME = `worker-${process.env.HOSTNAME || 'unknown'}`;
const RESULT_STREAM = 'fsc:results';
const DLQ_STREAM = 'fsc:dlq';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '10');
const RETRY_ATTEMPTS = 3;
const AGENT_ID = process.env.AGENT_ID || CONSUMER_NAME;

// ============ Logger ============
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ filename: 'fsc-worker.log' })
  ]
});

// ============ Semaphore ============
class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];
  
  constructor(permits: number) {
    this.permits = permits;
  }
  
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }
  
  release(): void {
    this.permits++;
    const next = this.queue.shift();
    if (next) {
      this.permits--;
      next();
    }
  }
  
  available(): number {
    return this.permits;
  }
}

const semaphore = new Semaphore(MAX_CONCURRENT);

// ============ Redis Client ============
const redis = createClient({
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT,
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        logger.error('Redis reconnect failed after 10 attempts');
        return new Error('Max reconnect attempts reached');
      }
      return Math.min(retries * 100, 3000);
    }
  }
});

redis.on('error', (err) => logger.error('Redis error:', err));
redis.on('connect', () => logger.info('Redis connected'));
redis.on('reconnecting', () => logger.warn('Redis reconnecting...'));

// ============ 未处理的 Rejection ============
process.on('unhandledRejection', async (reason, promise) => {
  logger.error('Unhandled Rejection:', { reason, promise });
  
  // 发送到 DLQ
  try {
    await redis.xAdd(DLQ_STREAM, '*', {
      type: 'unhandledRejection',
      reason: String(reason),
      timestamp: Date.now().toString()
    });
  } catch (err) {
    logger.error('Failed to send to DLQ:', err);
  }
});

// ============ 失败分类 ============
type FailureClass = 'RESOURCE' | 'TRANSIENT' | 'PERMANENT' | 'QUALITY' | 'UNKNOWN';

function classifyFailure(error: string): FailureClass {
  if (/OOM|out of memory|ENOMEM|disk full|No space/i.test(error)) return 'RESOURCE';
  if (/ECONNREFUSED|timeout|ETIMEDOUT|ENOTFOUND/i.test(error)) return 'TRANSIENT';
  if (/permission denied|EACCES|EPERM/i.test(error)) return 'PERMANENT';
  if (/lint|test.*fail|type.*error|compilation|eslint/i.test(error)) return 'QUALITY';
  return 'UNKNOWN';
}

// 不同失败类型的重试策略
const RETRY_CONFIG: Record<FailureClass, { maxRetries: number; backoffBase: number }> = {
  RESOURCE:  { maxRetries: 2, backoffBase: 5000 },   // 重试少、间隔长
  TRANSIENT: { maxRetries: 3, backoffBase: 2000 },   // 标准退避
  PERMANENT: { maxRetries: 0, backoffBase: 0 },       // 不重试
  QUALITY:   { maxRetries: 1, backoffBase: 1000 },    // 重试 1 次（换 Agent 在调度层）
  UNKNOWN:   { maxRetries: 3, backoffBase: 2000 },    // 标准重试
};

// ============ 任务执行 ============
interface Task {
  id: string;
  image: string;
  commands: string[];
  timeoutSeconds?: number;
  riskLevel?: string;
  estimatedTokens?: number;
}

interface TaskResult {
  taskId: string;
  status: 'success' | 'failure' | 'timeout';
  output?: string;
  error?: string;
  failureClass?: FailureClass;
  timestamp: number;
  durationMs?: number;
}

async function executeTask(task: Task): Promise<TaskResult> {
  const startTime = Date.now();
  logger.info(`[Task ${task.id}] Starting execution (risk=${task.riskLevel || 'low'})`);

  // 发射 task_started 事件
  await triggerMemoVSnapshot(task.id, 'task_started');

  try {
    const docker = new DockerInstance();

    // 启动容器
    const containerName = await docker.startContainer(task.image, `fsc-${task.id}`);
    logger.info(`[Task ${task.id}] Container started: ${containerName}`);

    // 执行命令
    const result = await docker.runCommands(task.commands, task.timeoutSeconds);

    // 清理容器
    await docker.stopContainer();

    const durationMs = Date.now() - startTime;
    logger.info(`[Task ${task.id}] Completed in ${durationMs}ms`);

    // Event-driven MemoV snapshot
    await triggerMemoVSnapshot(task.id, 'task_complete');

    return {
      taskId: task.id,
      status: result.status === 'success' ? 'success' :
              result.status === 'timeout' ? 'timeout' : 'failure',
      output: result.output,
      error: result.error,
      failureClass: result.status !== 'success' ? classifyFailure(result.error || '') : undefined,
      durationMs,
      timestamp: Date.now()
    };

  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    const fc = classifyFailure(errorMsg);
    logger.error(`[Task ${task.id}] Failed after ${durationMs}ms [${fc}]:`, error);

    return {
      taskId: task.id,
      status: 'failure',
      error: errorMsg,
      failureClass: fc,
      durationMs,
      timestamp: Date.now()
    };
  }
}

// ============ Event-driven MemoV Snapshot ============
async function triggerMemoVSnapshot(taskId: string, event: string) {
  try {
    await redis.xAdd('fsc:mem_events', '*', {
      type: event,
      task_id: taskId,
      agent_id: AGENT_ID,
      timestamp: Date.now().toString()
    });
    
    logger.debug(`[MemoV] Snapshot triggered: ${event} for task ${taskId}`);
  } catch (err) {
    logger.error('[MemoV] Failed to trigger snapshot:', err);
  }
}

// ============ 重试逻辑（失败分类感知） ============
async function executeWithRetry(task: Task, messageId: string, attempt = 1): Promise<TaskResult> {
  const result = await executeTask(task);

  if (result.status !== 'failure') return result;

  const fc = result.failureClass || 'UNKNOWN';
  const config = RETRY_CONFIG[fc];

  // PERMANENT → 不重试，直接 DLQ
  if (config.maxRetries === 0) {
    logger.error(`[Task ${task.id}] Permanent failure [${fc}], no retry → DLQ`);
    await sendToDLQ(task, messageId, result, attempt, fc);
    return result;
  }

  // 还有重试次数
  if (attempt < config.maxRetries) {
    const delay = Math.pow(2, attempt) * config.backoffBase;
    logger.warn(`[Task ${task.id}] Retry ${attempt}/${config.maxRetries} [${fc}], backoff ${delay}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));
    return executeWithRetry(task, messageId, attempt + 1);
  }

  // 最终失败 → DLQ
  await sendToDLQ(task, messageId, result, attempt, fc);
  return result;
}

async function sendToDLQ(
  task: Task,
  messageId: string,
  result: TaskResult,
  attempts: number,
  failureClass: FailureClass,
): Promise<void> {
  await redis.xAdd(DLQ_STREAM, '*', {
    task_id: task.id,
    message_id: messageId,
    error: result.error || 'unknown',
    failure_class: failureClass,
    attempts: attempts.toString(),
    duration_ms: (result.durationMs || 0).toString(),
    timestamp: Date.now().toString()
  });

  logger.error(`[Task ${task.id}] → DLQ [${failureClass}] after ${attempts} attempts`);
}

// ============ 主循环 ============
let isShuttingDown = false;
let drainingTasks = 0;

async function mainLoop() {
  logger.info('FSC Worker Daemon v0.3.0 starting...');
  logger.info(`Redis: ${REDIS_HOST}:${REDIS_PORT}`);
  logger.info(`Consumer: ${CONSUMER_GROUP}/${CONSUMER_NAME}`);
  logger.info(`Max concurrent: ${MAX_CONCURRENT}`);
  logger.info(`Agent ID: ${AGENT_ID}`);
  logger.info(`Distributed lock: Enabled (Redis SETNX with 300s TTL)`);
  logger.info(`Self-healing: Enabled (60s interval)`);
  
  await redis.connect();
  
  // 创建 consumer group（如果不存在）
  try {
    await redis.xGroupCreate(STREAM_KEY, CONSUMER_GROUP, '0', {
      MKSTREAM: true
    });
    logger.info(`Consumer group created: ${CONSUMER_GROUP}`);
  } catch (err: any) {
    if (err.message.includes('BUSYGROUP')) {
      logger.info(`Consumer group already exists: ${CONSUMER_GROUP}`);
    } else {
      throw err;
    }
  }
  
  while (!isShuttingDown) {
    try {
      // XREADGROUP 阻塞读取
      const messages = await redis.xReadGroup(
        CONSUMER_GROUP,
        CONSUMER_NAME,
        [{ key: STREAM_KEY, id: '>' }],
        { BLOCK: 5000, COUNT: 1 }
      );
      
      if (!messages || messages.length === 0) {
        continue;
      }
      
      for (const { name, messages: streamMessages } of messages) {
        for (const { id: messageId, message } of streamMessages) {
          const taskData = JSON.parse(message.task) as Task;
          logger.info(`[Task ${taskData.id}] Received from stream`);
          
          // 分布式锁：防止多节点重复执行
          const lockKey = `lock:task:${messageId}`;
          const lockAcquired = await redis.set(lockKey, CONSUMER_NAME, {
            NX: true,  // Only set if not exists
            EX: 300    // Expire after 5 minutes
          });
          
          if (!lockAcquired) {
            logger.warn(`[Task ${taskData.id}] Lock already held by another worker, skipping`);
            // XACK 确认消息（避免重复消费）
            await redis.xAck(STREAM_KEY, CONSUMER_GROUP, messageId);
            continue;
          }
          
          logger.info(`[Task ${taskData.id}] Lock acquired: ${lockKey}`);
          
          // Semaphore 控制并发
          await semaphore.acquire();
          drainingTasks++;
          
          // 异步执行任务
          (async () => {
            try {
              const taskResult = await executeWithRetry(taskData, messageId);
              
              // 推送结果（MessagePack 编码, 省 30-50% Stream 内存）
              const resultPayload = {
                task_id: taskData.id,
                agent_id: AGENT_ID,
                status: taskResult.status,
                output: taskResult.output || '',
                error: taskResult.error || '',
                failure_class: taskResult.failureClass || '',
                duration_ms: taskResult.durationMs || 0,
                timestamp: taskResult.timestamp,
              };
              const encoded = Buffer.from(msgpackEncode(resultPayload)).toString('base64');
              await redis.xAdd(RESULT_STREAM, '*', {
                payload: encoded,
                encoding: 'msgpack',
              });
              logger.info(`[Task ${taskData.id}] Result pushed to ${RESULT_STREAM} (${taskResult.status}, msgpack)`);

              
              // XACK 确认消息（前）
              logger.info(`[Task ${taskData.id}] Acknowledging message: ${messageId}`);
              await redis.xAck(STREAM_KEY, CONSUMER_GROUP, messageId);
              logger.info(`[Task ${taskData.id}] Message acknowledged: ${messageId}`);
              
              // 释放锁
              await redis.del(lockKey);
              logger.info(`[Task ${taskData.id}] Lock released: ${lockKey}`);
              
            } catch (error) {
              logger.error(`[Task ${taskData.id}] Execution error:`, error);
              // 确保锁被释放
              await redis.del(lockKey);
            } finally {
              semaphore.release();
              drainingTasks--;
            }
          })();
        }
      }
      
    } catch (error) {
      logger.error('Main loop error:', error);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  logger.info('Main loop exited');
}

// ============ 健康检查 ============
setInterval(async () => {
  try {
    await redis.set('fsc:worker:health', JSON.stringify({
      timestamp: Date.now(),
      running: MAX_CONCURRENT - semaphore.available(),
      maxConcurrent: MAX_CONCURRENT,
      agentId: AGENT_ID
    }), { EX: 60 });
  } catch (error) {
    logger.error('Health check failed:', error);
  }
}, 30000);

// ============ Worker 主动自愈引擎 (Proactive Healing Engine) ============
/**
 * 核心功能：
 * 1. 僵尸容器清理（防宿主机磁盘爆炸）
 * 2. 网络断联主动自救（别干等 Master 发现）
 * 3. 主动心跳与资源上报
 */

let networkFailureCount = 0;

async function proactiveSelfHealing() {
  logger.debug('[Self-Healing] Starting proactive health check...');
  
  try {
    // ========== 功能 1: 僵尸容器清理 ==========
    await cleanupZombieContainers();
    
    // ========== 功能 2: 网络断联主动自救 ==========
    await checkAndHealNetwork();
    
    // ========== 功能 3: 主动心跳与资源上报 ==========
    await reportHeartbeat();
    
  } catch (error) {
    logger.error('[Self-Healing] Error during self-healing:', error);
  }
}

// 功能 1: 清理僵尸容器
async function cleanupZombieContainers() {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    // 清理已退出的容器
    try {
      const { stdout: exitedContainers } = await execAsync('docker ps -aq -f status=exited');
      if (exitedContainers.trim()) {
        await execAsync(`docker rm ${exitedContainers.trim().split('\n').join(' ')}`);
        logger.info('[Self-Healing] Cleaned up exited containers');
      }
    } catch (err) {
      // 没有容器需要清理，忽略错误
    }
    
    // 清理超过 2 小时的卡死容器
    const { stdout: runningContainers } = await execAsync(
      "docker ps --format '{{.ID}} {{.RunningFor}}' | grep -E 'hours|days' || true"
    );
    
    if (runningContainers.trim()) {
      const lines = runningContainers.trim().split('\n');
      for (const line of lines) {
        const [containerId, ...timeParts] = line.split(' ');
        const timeStr = timeParts.join(' ');
        
        // 检查是否超过 2 小时
        if (timeStr.includes('hours') || timeStr.includes('days')) {
          const hours = timeStr.includes('days') ? 48 : parseInt(timeStr);
          if (hours >= 2) {
            await execAsync(`docker kill ${containerId}`);
            logger.warn(`[Self-Healing] Killed stuck container: ${containerId} (running for ${timeStr})`);
          }
        }
      }
    }
    
    // 清理游离的 Docker volume
    try {
      await execAsync('docker volume prune -f');
      logger.debug('[Self-Healing] Pruned dangling volumes');
    } catch (err) {
      // 忽略错误
    }
    
  } catch (error) {
    logger.error('[Self-Healing] Container cleanup failed:', error);
  }
}

// 功能 2: 网络断联主动自救
async function checkAndHealNetwork() {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    // 尝试 ping Redis 主节点
    try {
      await execAsync(`ping -c 1 -W 1 ${REDIS_HOST}`);
      
      // Ping 成功，重置失败计数
      if (networkFailureCount > 0) {
        logger.info('[Self-Healing] Network recovered');
        networkFailureCount = 0;
        
        // 上报网络恢复事件
        await redis.xAdd('fsc:mem_events', '*', {
          type: 'network_healed',
          agent_id: AGENT_ID,
          timestamp: Date.now().toString()
        });
      }
      
    } catch (pingError) {
      networkFailureCount++;
      logger.warn(`[Self-Healing] Network check failed (${networkFailureCount}/3)`);
      
      // 连续 3 次失败，主动重启 WireGuard
      if (networkFailureCount >= 3) {
        logger.error('[Self-Healing] Network down, restarting WireGuard...');
        
        try {
          await execAsync('sudo systemctl restart wg-quick@wg0');
          logger.info('[Self-Healing] WireGuard restarted');
          
          // 等待 5 秒让网络恢复
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // 重置计数
          networkFailureCount = 0;
          
        } catch (restartError) {
          logger.error('[Self-Healing] Failed to restart WireGuard:', restartError);
        }
      }
    }
    
  } catch (error) {
    logger.error('[Self-Healing] Network check failed:', error);
  }
}

// 功能 3: 主动心跳与资源上报 (/proc 直读，省去 fork+exec 开销)
let prevCpuIdle = 0;
let prevCpuTotal = 0;

function parseProcStat(content: string): { idle: number; total: number } {
  const cpuLine = content.split('\n').find(l => l.startsWith('cpu '));
  if (!cpuLine) return { idle: 0, total: 0 };
  const parts = cpuLine.split(/\s+/).slice(1).map(Number);
  // user, nice, system, idle, iowait, irq, softirq, steal
  const idle = parts[3] + (parts[4] || 0); // idle + iowait
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function parseProcMeminfo(content: string): { usedMB: number; totalMB: number } {
  const lines = content.split('\n');
  let total = 0, available = 0;
  for (const line of lines) {
    if (line.startsWith('MemTotal:')) total = parseInt(line.split(/\s+/)[1]) || 0;
    else if (line.startsWith('MemAvailable:')) available = parseInt(line.split(/\s+/)[1]) || 0;
  }
  const totalMB = Math.round(total / 1024);
  const usedMB = Math.round((total - available) / 1024);
  return { usedMB, totalMB };
}

async function reportHeartbeat() {
  try {
    let cpuUsageStr = '0.00';
    let memUsageStr = '0/0';
    let diskUsageStr = 'N/A';

    // CPU: 读 /proc/stat (差值计算)
    try {
      const stat = await Bun.file('/proc/stat').text();
      const { idle, total } = parseProcStat(stat);
      if (prevCpuTotal > 0) {
        const idleDelta = idle - prevCpuIdle;
        const totalDelta = total - prevCpuTotal;
        const usage = totalDelta > 0 ? ((1 - idleDelta / totalDelta) * 100) : 0;
        cpuUsageStr = usage.toFixed(2);
      }
      prevCpuIdle = idle;
      prevCpuTotal = total;
    } catch { /* /proc/stat 不可用（非 Linux），降级静默 */ }

    // 内存: 读 /proc/meminfo
    try {
      const meminfo = await Bun.file('/proc/meminfo').text();
      const { usedMB, totalMB } = parseProcMeminfo(meminfo);
      memUsageStr = `${usedMB}/${totalMB}`;
    } catch { /* 非 Linux 降级 */ }

    // 磁盘: statvfs 不可用时降级用 df（仅此一个命令）
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      const { stdout } = await execAsync("df -h / | awk 'NR==2{print $5}'");
      diskUsageStr = stdout.trim();
    } catch { /* 降级 */ }

    const metrics = {
      cpu_usage: cpuUsageStr,
      memory_usage: memUsageStr,
      disk_usage: diskUsageStr,
      running_tasks: MAX_CONCURRENT - semaphore.available(),
      max_concurrent: MAX_CONCURRENT,
      timestamp: Date.now()
    };

    // 推送心跳到 Redis — C codec 零拷贝路径 (省 GC 压力)
    const activeTasks = MAX_CONCURRENT - semaphore.available();
    const [memUsed, memTotal] = memUsageStr.split('/').map(Number);

    if (fscCodec) {
      const hbEncoded = fscCodec.encodeHeartbeat({
        agentId: AGENT_ID,
        nodeId: REDIS_HOST,
        cpuPercent: parseFloat(cpuUsageStr) || 0,
        memUsedMb: memUsed || 0,
        memTotalMb: memTotal || 0,
        activeTasks,
        timestamp: Date.now(),
      });
      const b64 = fscCodec.toBase64(Buffer.from(hbEncoded));
      await redis.xAdd('fsc:heartbeats', '*', {
        payload: b64,
        encoding: 'msgpack',
        type: 'heartbeat',
      });
    } else {
      await redis.xAdd('fsc:heartbeats', '*', {
        agent: AGENT_ID,
        active_tasks: activeTasks.toString(),
        metrics: JSON.stringify(metrics),
      });
    }

    logger.debug(`[Self-Healing] Heartbeat sent: ${JSON.stringify(metrics)}`);

  } catch (error) {
    logger.error('[Self-Healing] Heartbeat report failed:', error);
  }
}

// 启动自愈引擎（每 60 秒巡检一次）
setInterval(async () => {
  if (isShuttingDown) return;
  await proactiveSelfHealing();
}, 60000);

logger.info('[Self-Healing] Proactive healing engine started (60s interval)');

// ============ 优雅退出 (SIGTERM → drain → exit) ============
async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  isShuttingDown = true;
  
  // Drain: 等待正在执行的任务完成
  const timeout = setTimeout(() => {
    logger.warn('Shutdown timeout, forcing exit');
    process.exit(1);
  }, 30000);
  
  while (drainingTasks > 0) {
    logger.info(`Draining... ${drainingTasks} tasks remaining`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  clearTimeout(timeout);
  
  // 触发最终 snapshot
  await triggerMemoVSnapshot('shutdown', 'worker_shutdown');
  
  await redis.quit();
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============ 启动 ============
mainLoop().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
