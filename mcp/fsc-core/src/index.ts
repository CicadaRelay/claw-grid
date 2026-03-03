#!/usr/bin/env bun
/**
 * FSC Core MCP Server
 * 新增工具: batch_dispatch
 * 
 * 功能：批量任务调度
 * - Redis pipeline (multi/exec)
 * - 任务依赖管理
 * - 批次追踪
 */

import { createClient } from 'redis';

// ============ 配置 ============
const PORT = parseInt(process.env.MCP_PORT || '8081');
const REDIS_HOST = process.env.REDIS_HOST || '10.10.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');

// ============ Redis Client ============
const redis = createClient({
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT,
    reconnectStrategy: (retries) => {
      if (retries > 10) return new Error('Max reconnect attempts');
      return Math.min(retries * 100, 3000);
    }
  }
});

redis.on('error', (err) => console.error('Redis error:', err));
redis.on('connect', () => console.log(`[FSC-Core] Redis connected: ${REDIS_HOST}:${REDIS_PORT}`));

await redis.connect();

// ============ Types ============
interface Task {
  id: string;
  repo_url: string;
  commands: string[];
  depends_on?: string[];
}

interface BatchDispatchInput {
  repo_url: string;
  tasks: Task[];
  depends_on?: Record<string, string[]>;
  max_agents?: number;
  priority?: 'high' | 'normal' | 'low';
}

interface BatchDispatchResult {
  batch_id: string;
  tasks_count: number;
  tasks_dispatched: string[];
  tracking_key: string;
  timestamp: number;
}

// ============ Tool: batch_dispatch ============
async function batchDispatch(input: BatchDispatchInput): Promise<BatchDispatchResult> {
  const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const trackingKey = `fsc:batch:${batchId}`;
  
  console.log(`[batch_dispatch] Starting batch ${batchId}`);
  console.log(`[batch_dispatch] Tasks: ${input.tasks.length}`);
  console.log(`[batch_dispatch] Max agents: ${input.max_agents || 'unlimited'}`);
  console.log(`[batch_dispatch] Priority: ${input.priority || 'normal'}`);
  
  // 验证任务依赖
  const taskIds = new Set(input.tasks.map(t => t.id));
  for (const task of input.tasks) {
    if (task.depends_on) {
      for (const dep of task.depends_on) {
        if (!taskIds.has(dep)) {
          throw new Error(`Task ${task.id} depends on non-existent task ${dep}`);
        }
      }
    }
  }
  
  // 使用 Redis pipeline (multi/exec)
  const multi = redis.multi();
  
  const dispatchedTasks: string[] = [];
  
  for (const task of input.tasks) {
    const taskData = {
      id: task.id,
      batch_id: batchId,
      repo_url: input.repo_url,
      commands: JSON.stringify(task.commands),
      depends_on: task.depends_on ? JSON.stringify(task.depends_on) : '[]',
      priority: input.priority || 'normal',
      status: 'pending',
      created_at: Date.now().toString()
    };
    
    // XADD 添加任务到 stream
    multi.xAdd('fsc:tasks', '*', {
      task: JSON.stringify(taskData)
    });
    
    dispatchedTasks.push(task.id);
  }
  
  // 创建批次追踪记录
  multi.hSet(trackingKey, {
    batch_id: batchId,
    repo_url: input.repo_url,
    tasks_count: input.tasks.length.toString(),
    tasks_dispatched: JSON.stringify(dispatchedTasks),
    max_agents: (input.max_agents || 0).toString(),
    priority: input.priority || 'normal',
    status: 'dispatched',
    created_at: Date.now().toString()
  });
  
  // 设置过期时间（24小时）
  multi.expire(trackingKey, 86400);
  
  // 执行 pipeline
  await multi.exec();
  
  console.log(`[batch_dispatch] Batch ${batchId} dispatched successfully`);
  
  return {
    batch_id: batchId,
    tasks_count: input.tasks.length,
    tasks_dispatched: dispatchedTasks,
    tracking_key: trackingKey,
    timestamp: Date.now()
  };
}

// ============ Tool: get_batch_status ============
async function getBatchStatus(batchId: string) {
  const trackingKey = `fsc:batch:${batchId}`;
  
  const batchData = await redis.hGetAll(trackingKey);
  
  if (Object.keys(batchData).length === 0) {
    return {
      error: 'Batch not found',
      batch_id: batchId
    };
  }
  
  return {
    batch_id: batchId,
    ...batchData,
    tasks_dispatched: JSON.parse(batchData.tasks_dispatched || '[]')
  };
}

// ============ HTTP Server ============
const server = Bun.serve({
  port: PORT,
  
  async fetch(req) {
    const url = new URL(req.url);
    
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers });
    }
    
    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        timestamp: Date.now(),
        redis: redis.isOpen ? 'connected' : 'disconnected'
      }), { headers });
    }
    
    // Tool: batch_dispatch
    if (url.pathname === '/tools/batch_dispatch' && req.method === 'POST') {
      try {
        const input = await req.json() as BatchDispatchInput;
        
        // 验证输入
        if (!input.repo_url || !input.tasks || input.tasks.length === 0) {
          return new Response(JSON.stringify({
            error: 'Invalid input: repo_url and tasks are required'
          }), { status: 400, headers });
        }
        
        const result = await batchDispatch(input);
        return new Response(JSON.stringify(result), { headers });
      } catch (error) {
        return new Response(JSON.stringify({
          error: error instanceof Error ? error.message : String(error)
        }), { status: 500, headers });
      }
    }
    
    // Tool: get_batch_status
    if (url.pathname.startsWith('/tools/get_batch_status/')) {
      const batchId = url.pathname.split('/').pop();
      if (!batchId) {
        return new Response(JSON.stringify({
          error: 'Batch ID required'
        }), { status: 400, headers });
      }
      
      const result = await getBatchStatus(batchId);
      return new Response(JSON.stringify(result), { headers });
    }
    
    // MCP Server Info
    if (url.pathname === '/') {
      return new Response(JSON.stringify({
        name: 'fsc-core',
        version: '0.1.0',
        transport: 'http',
        port: PORT,
        tools: [
          {
            name: 'batch_dispatch',
            description: 'Dispatch batch tasks with dependencies',
            endpoint: '/tools/batch_dispatch',
            method: 'POST',
            input: {
              repo_url: 'string',
              tasks: 'Task[]',
              depends_on: 'Record<string, string[]> (optional)',
              max_agents: 'number (optional)',
              priority: 'high|normal|low (optional)'
            }
          },
          {
            name: 'get_batch_status',
            description: 'Get batch status by ID',
            endpoint: '/tools/get_batch_status/{batch_id}',
            method: 'GET'
          }
        ]
      }), { headers });
    }
    
    return new Response(JSON.stringify({
      error: 'Not found'
    }), { status: 404, headers });
  }
});

console.log(`[FSC-Core] MCP Server running on http://localhost:${PORT}`);
console.log(`[FSC-Core] Tools:`);
console.log(`  - POST /tools/batch_dispatch`);
console.log(`  - GET /tools/get_batch_status/{batch_id}`);

// ============ 优雅退出 ============
process.on('SIGTERM', async () => {
  console.log('[FSC-Core] Shutting down...');
  await redis.quit();
  server.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[FSC-Core] Shutting down...');
  await redis.quit();
  server.stop();
  process.exit(0);
});
