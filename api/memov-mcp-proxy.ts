#!/usr/bin/env bun
/**
 * MemoV MCP Proxy Server — Bun.serve 版
 *
 * - RESTful API: mesh 拓扑, memov 时间线, 搜索, 因果调试, 回滚
 * - WebSocket 实时推送 (原生 Bun WebSocket, 替代 socket.io)
 */

import { createClient, type RedisClientType } from 'redis';
import { execSync } from 'child_process';
import { REDIS_URL } from '../config/redis';

// Memory modules
const causal = require('../memory/causal');
const { PointerSystem } = require('../memory/pointer');
const { QdrantPointerStore } = require('../memory/qdrant-pointer');

const PORT = parseInt(process.env.MEMOV_PORT || process.env.PORT || '3001');
const MEMOV_PATH = process.env.MEMOV_PATH || '/opt/claw-mesh/.mem';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ============ State ============
let redis: RedisClientType;
const pointerSystem = new PointerSystem();
let qdrantStore: any = null;

// WebSocket 订阅者集合
const wsClients = new Set<any>();
let streamPolling = false;

// ============ Redis Stream → WebSocket 推送 ============
async function startStreamPolling() {
  if (streamPolling) return;
  streamPolling = true;

  let lastId = '$';
  while (streamPolling) {
    try {
      if (wsClients.size === 0) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      const events = await redis.xRead(
        [{ key: 'fsc:mem_events', id: lastId }],
        { BLOCK: 2000, COUNT: 50 },
      );

      if (events) {
        for (const { messages } of events) {
          for (const { id, message } of messages) {
            lastId = id;
            const payload = JSON.stringify({
              type: 'memov:event',
              id,
              ...message,
              timestamp: parseInt(message.timestamp || '0'),
            });
            for (const ws of wsClients) {
              try { ws.send(payload); } catch { wsClients.delete(ws); }
            }
          }
        }
      }
    } catch (err: any) {
      console.error('[Stream] Poll error:', err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ============ Route handlers ============

async function handleTopology() {
  const heartbeats = await redis.xRead(
    [{ key: 'fsc:heartbeats', id: '0' }],
    { COUNT: 100 },
  );

  const nodes: any[] = [];
  if (heartbeats) {
    for (const { messages } of heartbeats) {
      for (const { message } of messages) {
        try {
          const metrics = JSON.parse(message.metrics || '{}');
          nodes.push({ id: message.agent, ...metrics });
        } catch { /* skip malformed */ }
      }
    }
  }
  return json({ nodes });
}

async function handleTimeline(url: URL) {
  const since = url.searchParams.get('since') || '0';
  const limit = parseInt(url.searchParams.get('limit') || '50');

  const events = await redis.xRead(
    [{ key: 'fsc:mem_events', id: since }],
    { COUNT: limit },
  );

  const timeline: any[] = [];
  if (events) {
    for (const { messages } of events) {
      for (const { id, message } of messages) {
        timeline.push({ id, ...message, timestamp: parseInt(message.timestamp || '0') });
      }
    }
  }
  return json({ timeline });
}

async function handleSearch(body: any) {
  const { query, limit = 10 } = body;

  const keywords = query.split(/\s+/).filter(Boolean);
  const keywordResults = pointerSystem.searchByKeywords(keywords);

  let qdrantResults: any[] = [];
  if (qdrantStore) {
    try {
      qdrantResults = await qdrantStore.filterPointers(
        { must: [{ key: 'status', match: { value: 'active' } }] },
        limit,
      );
    } catch { /* Qdrant unavailable */ }
  }

  const seen = new Set<string>();
  const results: any[] = [];

  for (const item of keywordResults) {
    const ptr = item.pointer;
    if (!seen.has(ptr)) {
      seen.add(ptr);
      results.push({
        pointer: ptr, score: 1.0,
        content: item.content || item.topic || '',
        timestamp: item.updated_at || item.created_at || Date.now(),
      });
    }
  }

  for (const item of qdrantResults) {
    const ptr = item.pointer;
    if (ptr && !seen.has(ptr)) {
      seen.add(ptr);
      results.push({
        pointer: ptr, score: 0.8,
        content: item.content || item.topic || '',
        timestamp: item.updated_at || item.created_at || Date.now(),
      });
    }
  }

  return json({ results: results.slice(0, limit) });
}

async function handleCausalDebug(body: any) {
  const { pointer, mode, errorLog } = body;

  if (mode === 'trace') {
    const chain = causal.getCausalChain(pointer);
    return json({ pointer, mode, chain, issues: [], suggestions: [] });
  }

  if (mode === 'learn') {
    const entity = causal.learnFromSuccess(pointer, errorLog || '');
    return json({ pointer, mode, entity, issues: [], suggestions: [] });
  }

  const finding = causal.diagnoseFailure(pointer, errorLog || mode || '');
  return json({
    pointer, mode: 'diagnose', finding,
    issues: finding.cause ? [{ cause: finding.cause, confidence: finding.confidence }] : [],
    suggestions: finding.fix ? [finding.fix] : [],
  });
}

async function handleRollback(body: any) {
  const { timestamp, target } = body;

  if (target && target !== 'all' && !/^[a-zA-Z0-9_-]+$/.test(target)) {
    return json({ success: false, message: 'Invalid target format' }, 400);
  }

  const isoTime = new Date(timestamp).toISOString();

  const commitHash = execSync(
    `git -C "${MEMOV_PATH}" log --before="${isoTime}" --format="%H" -1`,
    { encoding: 'utf-8' },
  ).trim();

  if (!commitHash) {
    return json({ success: false, message: 'No commit found before timestamp' }, 404);
  }

  if (!target || target === 'all') {
    execSync(`git -C "${MEMOV_PATH}" checkout ${commitHash} -- .`);
  } else {
    execSync(`git -C "${MEMOV_PATH}" checkout ${commitHash} -- agents/${target}/`);
  }

  await redis.xAdd('fsc:mem_events', '*', {
    type: 'rollback',
    timestamp: String(Date.now()),
    rollback_to: String(timestamp),
    target: target || 'all',
    commit_hash: commitHash,
  });

  return json({ success: true, message: `Rolled back to ${isoTime}`, commitHash, target: target || 'all' });
}

// ============ Bun.serve ============

async function init() {
  redis = createClient({ url: REDIS_URL }) as RedisClientType;
  redis.on('error', (err) => console.error('[Redis]', err.message));
  await redis.connect();
  console.log('[Redis] Connected');

  try {
    qdrantStore = new QdrantPointerStore(process.env.QDRANT_URL || 'http://localhost:6333');
    await qdrantStore.initialize();
    console.log('[Qdrant] Connected');
  } catch {
    qdrantStore = null;
    console.log('[Qdrant] Unavailable, keyword search only');
  }

  startStreamPolling();
}

await init();

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // WebSocket upgrade
    if (path === '/ws' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const success = server.upgrade(req);
      if (success) return undefined as any;
      return json({ error: 'WebSocket upgrade failed' }, 400);
    }

    try {
      if (path === '/health') {
        return json({ status: 'ok', timestamp: Date.now(), redis: redis.isOpen ? 'connected' : 'disconnected', wsClients: wsClients.size });
      }

      if (path === '/api/mesh/topology' && req.method === 'GET') return await handleTopology();
      if (path === '/api/memov/timeline' && req.method === 'GET') return await handleTimeline(url);

      if (req.method === 'POST') {
        const body = await req.json();
        if (path === '/api/search') return await handleSearch(body);
        if (path === '/api/causal/debug') return await handleCausalDebug(body);
        if (path === '/api/memov/rollback') return await handleRollback(body);
      }

      return json({ error: 'Not found' }, 404);
    } catch (err: any) {
      console.error(`[${path}] Error:`, err.message);
      return json({ error: err.message }, 500);
    }
  },

  websocket: {
    open(ws) {
      wsClients.add(ws);
      console.log(`[WS] Client connected (${wsClients.size} total)`);
    },
    close(ws) {
      wsClients.delete(ws);
      console.log(`[WS] Client disconnected (${wsClients.size} total)`);
    },
    message(_ws, _message) {
      // Client messages not needed for now
    },
  },
});

console.log(`[MemoV MCP Proxy] Listening on http://0.0.0.0:${server.port}`);
console.log(`[MemoV MCP Proxy] WebSocket: ws://0.0.0.0:${server.port}/ws`);
