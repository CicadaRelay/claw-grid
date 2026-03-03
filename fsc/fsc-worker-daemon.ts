#!/usr/bin/env bun
/**
 * FSC Worker Daemon
 * 基于 QWEN A2A_TASK_SPEC v1.0
 * 
 * 功能：
 * - 从 Redis 队列拉取任务（BLPOP）
 * - 执行 FSC Docker 实例
 * - 推送结果到 Redis
 * - 错误处理、重试、优雅退出
 */

import { createClient } from 'redis';
import { DockerInstance } from './packages/core/src/dockerInstance';
import winston from 'winston';

// ============ 配置 ============
const REDIS_HOST = process.env.REDIS_HOST || '10.10.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const TASK_QUEUE = 'fsc:task_queue';
const RESULT_QUEUE = 'fsc:result_queue';
const FAILED_QUEUE = 'fsc:failed_tasks';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '10');
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

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

// ============ 任务执行 ============
interface Task {
  id: string;
  image: string;
  commands: string[];
  timeoutSeconds?: number;
}

interface TaskResult {
  taskId: string;
  status: 'success' | 'failure' | 'timeout';
  output?: string;
  error?: string;
  timestamp: number;
}

async function executeTask(task: Task): Promise<TaskResult> {
  const startTime = Date.now();
  logger.info(`[Task ${task.id}] Starting execution`);
  
  try {
    const docker = new DockerInstance();
    
    // 启动容器
    const containerName = await docker.startContainer(task.image, `fsc-${task.id}`);
    logger.info(`[Task ${task.id}] Container started: ${containerName}`);
    
    // 执行命令
    const result = await docker.runCommands(task.commands, task.timeoutSeconds);
    
    // 清理容器
    await docker.stopContainer();
    
    const duration = Date.now() - startTime;
    logger.info(`[Task ${task.id}] Completed in ${duration}ms`);
    
    return {
      taskId: task.id,
      status: result.status === 'success' ? 'success' : 
              result.status === 'timeout' ? 'timeout' : 'failure',
      output: result.output,
      error: result.error,
      timestamp: Date.now()
    };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(`[Task ${task.id}] Failed after ${duration}ms:`, error);
    
    return {
      taskId: task.id,
      status: 'failure',
      error: error instanceof Error ? error.message : String(error),
      timestamp: Date.now()
    };
  }
}

// ============ 重试逻辑 ============
async function executeWithRetry(task: Task, attempt = 1): Promise<TaskResult> {
  const result = await executeTask(task);
  
  if (result.status === 'failure' && attempt < RETRY_ATTEMPTS) {
    logger.warn(`[Task ${task.id}] Retry ${attempt}/${RETRY_ATTEMPTS}`);
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    return executeWithRetry(task, attempt + 1);
  }
  
  return result;
}

// ============ 并发控制 ============
class WorkerPool {
  private running = 0;
  private queue: Array<() => Promise<void>> = [];
  
  async execute(fn: () => Promise<void>) {
    if (this.running >= MAX_CONCURRENT) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    
    this.running++;
    try {
      await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
  
  getRunning() {
    return this.running;
  }
}

const pool = new WorkerPool();

// ============ 主循环 ============
let isShuttingDown = false;

async function mainLoop() {
  logger.info('FSC Worker Daemon starting...');
  logger.info(`Redis: ${REDIS_HOST}:${REDIS_PORT}`);
  logger.info(`Max concurrent: ${MAX_CONCURRENT}`);
  
  await redis.connect();
  
  while (!isShuttingDown) {
    try {
      // BLPOP 阻塞等待任务（5秒超时）
      const result = await redis.blPop(TASK_QUEUE, 5);
      
      if (!result) {
        // 超时，继续循环
        continue;
      }
      
      const taskData = JSON.parse(result.element) as Task;
      logger.info(`[Task ${taskData.id}] Received`);
      
      // 异步执行任务（并发控制）
      pool.execute(async () => {
        const taskResult = await executeWithRetry(taskData);
        
        // 推送结果
        if (taskResult.status === 'success') {
          await redis.rPush(RESULT_QUEUE, JSON.stringify(taskResult));
          logger.info(`[Task ${taskData.id}] Result pushed to ${RESULT_QUEUE}`);
        } else {
          await redis.rPush(FAILED_QUEUE, JSON.stringify(taskResult));
          logger.error(`[Task ${taskData.id}] Failed, moved to ${FAILED_QUEUE}`);
        }
      });
      
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
      running: pool.getRunning(),
      maxConcurrent: MAX_CONCURRENT
    }), { EX: 60 });
  } catch (error) {
    logger.error('Health check failed:', error);
  }
}, 30000);

// ============ 优雅退出 ============
async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  isShuttingDown = true;
  
  // 等待正在执行的任务完成（最多 30 秒）
  const timeout = setTimeout(() => {
    logger.warn('Shutdown timeout, forcing exit');
    process.exit(1);
  }, 30000);
  
  while (pool.getRunning() > 0) {
    logger.info(`Waiting for ${pool.getRunning()} tasks to complete...`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  clearTimeout(timeout);
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
