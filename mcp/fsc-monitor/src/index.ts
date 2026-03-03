#!/usr/bin/env bun
/**
 * FSC Monitor MCP Server
 * HTTP Transport, Port 8080
 * 
 * Tools:
 * - get_queue_depth: 获取 Redis 队列深度
 * - get_worker_load: 获取 Worker 负载
 * - get_alerts: 获取告警信息
 */

import { createClient } from 'redis';

// ============ 配置 ============
const PORT = parseInt(process.env.MCP_PORT || '8080');
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
redis.on('connect', () => console.log(`[MCP] Redis connected: ${REDIS_HOST}:${REDIS_PORT}`));

await redis.connect();

// ============ MCP Tools ============

/**
 * Tool: get_queue_depth
 * 获取 Redis 队列深度
 */
async function getQueueDepth() {
  try {
    const tasksLen = await redis.xLen('fsc:tasks');
    const resultsLen = await redis.xLen('fsc:results');
    const dlqLen = await redis.xLen('fsc:dlq');
    
    return {
      tasks: tasksLen,
      results: resultsLen,
      dlq: dlqLen,
      total: tasksLen + resultsLen + dlqLen
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Tool: get_worker_load
 * 获取 Worker 负载
 */
async function getWorkerLoad() {
  try {
    const workers = await redis.hGetAll('fsc:workers');
    const workerStats = [];
    
    for (const [workerId, data] of Object.entries(workers)) {
      try {
        const stats = JSON.parse(data);
        workerStats.push({
          id: workerId,
          ...stats
        });
      } catch {
        workerStats.push({
          id: workerId,
          error: 'Invalid JSON'
        });
      }
    }
    
    return {
      workers: workerStats,
      count: workerStats.length
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Tool: get_alerts
 * 获取告警信息
 */
async function getAlerts() {
  try {
    const queueDepth = await getQueueDepth();
    const workerLoad = await getWorkerLoad();
    
    const alerts = [];
    
    // 告警规则：queue>100 → warn
    if (queueDepth.tasks && queueDepth.tasks > 100) {
      alerts.push({
        level: 'warn',
        type: 'queue_depth',
        message: `Task queue depth ${queueDepth.tasks} exceeds threshold 100`,
        value: queueDepth.tasks,
        threshold: 100
      });
    }
    
    // 告警规则：dlq>0 → crit
    if (queueDepth.dlq && queueDepth.dlq > 0) {
      alerts.push({
        level: 'crit',
        type: 'dead_letter_queue',
        message: `Dead letter queue has ${queueDepth.dlq} failed tasks`,
        value: queueDepth.dlq,
        threshold: 0
      });
    }
    
    // 告警规则：wg_handshake>180s → crit
    // (需要从 WireGuard 获取，暂时跳过)
    
    // 告警规则：无可用 Worker
    if (workerLoad.count === 0) {
      alerts.push({
        level: 'crit',
        type: 'no_workers',
        message: 'No workers available',
        value: 0,
        threshold: 1
      });
    }
    
    return {
      alerts,
      count: alerts.length,
      timestamp: Date.now()
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// ============ HTTP Server ============

const server = Bun.serve({
  port: PORT,
  
  async fetch(req) {
    const url = new URL(req.url);
    
    // CORS
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
    
    // Prometheus metrics
    if (url.pathname === '/metrics') {
      const queueDepth = await getQueueDepth();
      const workerLoad = await getWorkerLoad();
      const alerts = await getAlerts();
      
      const metrics = [
        `# HELP fsc_queue_depth FSC queue depth`,
        `# TYPE fsc_queue_depth gauge`,
        `fsc_queue_depth{queue="tasks"} ${queueDepth.tasks || 0}`,
        `fsc_queue_depth{queue="results"} ${queueDepth.results || 0}`,
        `fsc_queue_depth{queue="dlq"} ${queueDepth.dlq || 0}`,
        ``,
        `# HELP fsc_workers_count FSC workers count`,
        `# TYPE fsc_workers_count gauge`,
        `fsc_workers_count ${workerLoad.count || 0}`,
        ``,
        `# HELP fsc_alerts_count FSC alerts count`,
        `# TYPE fsc_alerts_count gauge`,
        `fsc_alerts_count ${alerts.count || 0}`,
        ``
      ].join('\n');
      
      return new Response(metrics, {
        headers: {
          'Content-Type': 'text/plain; version=0.0.4'
        }
      });
    }
    
    // MCP Tools API
    if (url.pathname === '/tools/get_queue_depth') {
      const result = await getQueueDepth();
      return new Response(JSON.stringify(result), { headers });
    }
    
    if (url.pathname === '/tools/get_worker_load') {
      const result = await getWorkerLoad();
      return new Response(JSON.stringify(result), { headers });
    }
    
    if (url.pathname === '/tools/get_alerts') {
      const result = await getAlerts();
      return new Response(JSON.stringify(result), { headers });
    }
    
    // MCP Server Info
    if (url.pathname === '/') {
      return new Response(JSON.stringify({
        name: 'fsc-monitor',
        version: '0.1.0',
        transport: 'http',
        port: PORT,
        tools: [
          {
            name: 'get_queue_depth',
            description: 'Get Redis queue depth',
            endpoint: '/tools/get_queue_depth'
          },
          {
            name: 'get_worker_load',
            description: 'Get worker load statistics',
            endpoint: '/tools/get_worker_load'
          },
          {
            name: 'get_alerts',
            description: 'Get alert information',
            endpoint: '/tools/get_alerts'
          }
        ],
        endpoints: {
          health: '/health',
          metrics: '/metrics'
        }
      }), { headers });
    }
    
    return new Response(JSON.stringify({
      error: 'Not found'
    }), {
      status: 404,
      headers
    });
  }
});

console.log(`[MCP] FSC Monitor Server running on http://localhost:${PORT}`);
console.log(`[MCP] Health: http://localhost:${PORT}/health`);
console.log(`[MCP] Metrics: http://localhost:${PORT}/metrics`);
console.log(`[MCP] Tools:`);
console.log(`  - GET /tools/get_queue_depth`);
console.log(`  - GET /tools/get_worker_load`);
console.log(`  - GET /tools/get_alerts`);

// ============ 优雅退出 ============
process.on('SIGTERM', async () => {
  console.log('[MCP] Shutting down...');
  await redis.quit();
  server.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[MCP] Shutting down...');
  await redis.quit();
  server.stop();
  process.exit(0);
});
