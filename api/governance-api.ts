#!/usr/bin/env bun
/**
 * FSC-Mesh Governance API — Bun.serve
 * Port: 3004
 *
 * 为 Dashboard 提供治理数据:
 * GET /api/governance/trust       — 信誉排行
 * GET /api/governance/budget      — 预算状态
 * GET /api/governance/audit       — 审计日志
 * GET /api/governance/policies    — 策略规则
 * GET /api/governance/quality     — 质量统计
 * GET /api/governance/evolution   — 进化状态
 * GET /api/governance/summary     — 全量摘要 (一次拿所有)
 * GET /health                     — 健康检查
 */

import { createClient } from 'redis';

const PORT = parseInt(process.env.GOVERNANCE_PORT || '3004');
const REDIS_HOST = process.env.REDIS_HOST || '10.10.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || 'fsc-mesh-2026';

// ============ Redis ============
const redis = createClient({
  socket: { host: REDIS_HOST, port: REDIS_PORT },
  password: REDIS_PASSWORD,
});

redis.on('error', (err) => console.error('[Redis]', err.message));
await redis.connect();
console.log(`[Governance API] Redis connected: ${REDIS_HOST}:${REDIS_PORT}`);

// ============ 数据获取函数 ============

async function getTrustLeaderboard(limit = 20) {
  const entries = await redis.zRangeWithScores('fsc:trust:leaderboard', 0, -1);
  const results = [];

  for (const entry of entries.reverse().slice(0, limit)) {
    const profile = await redis.hGetAll(`fsc:trust:${entry.value}`);
    const totalTasks = parseInt(profile.totalTasks || '0');
    const successCount = parseInt(profile.successCount || '0');

    results.push({
      agentId: entry.value,
      score: entry.score,
      totalTasks,
      successRate: totalTasks > 0 ? successCount / totalTasks : 0,
      avgQuality: parseFloat(profile.avgQualityScore || '0'),
      cooldown: parseInt(profile.cooldownUntil || '0') > Date.now(),
    });
  }

  return results;
}

async function getBudget() {
  const data = await redis.hGetAll('fsc:budget');
  if (!data || !data.hourlyLimit) {
    return {
      hourlyUsage: 0, dailyUsage: 0, monthlyUsage: 0,
      tier: 'standard', model: 'doubao-seed-2.0-code', canAccept: true,
    };
  }

  const hourlySpent = parseFloat(data.hourlySpent || '0');
  const dailySpent = parseFloat(data.dailySpent || '0');
  const monthlySpent = parseFloat(data.monthlySpent || '0');
  const hourlyLimit = parseFloat(data.hourlyLimit || '0.50');
  const dailyLimit = parseFloat(data.dailyLimit || '10');
  const monthlyLimit = parseFloat(data.monthlyLimit || '200');

  return {
    hourlyUsage: hourlyLimit > 0 ? Math.round((hourlySpent / hourlyLimit) * 100) : 0,
    dailyUsage: dailyLimit > 0 ? Math.round((dailySpent / dailyLimit) * 100) : 0,
    monthlyUsage: monthlyLimit > 0 ? Math.round((monthlySpent / monthlyLimit) * 100) : 0,
    tier: data.modelTier || 'standard',
    model: data.currentModel || 'doubao-seed-2.0-code',
    canAccept: (data.modelTier || 'standard') !== 'paused',
    hourlySpent, dailySpent, monthlySpent,
    hourlyLimit, dailyLimit, monthlyLimit,
  };
}

async function getAuditLog(count = 50) {
  try {
    const results = await redis.xRevRange('fsc:governance:audit', '+', '-', { COUNT: count });
    return results.map((r) => ({
      id: r.id,
      timestamp: parseInt(r.message.timestamp || '0'),
      eventType: r.message.eventType || 'unknown',
      agentId: r.message.agentId,
      taskId: r.message.taskId,
      decision: r.message.decision,
      details: r.message.details || '{}',
    }));
  } catch {
    return [];
  }
}

async function getPolicies() {
  // 内置规则
  const builtin = [
    { id: 'CONST_001', name: 'token_limit', level: 'constitutional', enforcement: 'hard', enabled: true },
    { id: 'CONST_002', name: 'hourly_cost_limit', level: 'constitutional', enforcement: 'hard', enabled: true },
    { id: 'CONST_003', name: 'trust_threshold', level: 'constitutional', enforcement: 'hard', enabled: true },
    { id: 'CONST_004', name: 'node_capacity', level: 'constitutional', enforcement: 'hard', enabled: true },
    { id: 'CONST_005', name: 'critical_path_trust', level: 'constitutional', enforcement: 'hard', enabled: true },
    { id: 'OPS_001', name: 'consecutive_failure_cooldown', level: 'operational', enforcement: 'soft', enabled: true },
    { id: 'OPS_002', name: 'agent_cooldown_check', level: 'operational', enforcement: 'hard', enabled: true },
  ];

  // Redis 自定义规则
  try {
    const stored = await redis.hGetAll('fsc:policies');
    for (const [id, json] of Object.entries(stored)) {
      try {
        const rule = JSON.parse(json as string);
        // 覆盖或追加
        const idx = builtin.findIndex((r) => r.id === id);
        const entry = {
          id: rule.id || id,
          name: rule.name || id,
          level: rule.level || 'operational',
          enforcement: rule.enforcement || 'soft',
          enabled: rule.enabled !== false,
        };
        if (idx >= 0) builtin[idx] = entry;
        else builtin.push(entry);
      } catch { /* skip */ }
    }
  } catch { /* no custom rules */ }

  return builtin;
}

async function getQualitySummary() {
  // 从审计日志中统计质量检查结果
  try {
    const results = await redis.xRevRange('fsc:governance:audit', '+', '-', { COUNT: 500 });
    const qualityEvents = results.filter((r) => r.message.eventType === 'quality_checked');

    let approved = 0, review = 0, rejected = 0, totalScore = 0;
    for (const e of qualityEvents) {
      const details = JSON.parse(e.message.details || '{}');
      const score = details.score || 0;
      totalScore += score;
      const decision = e.message.decision || '';
      if (decision === 'APPROVE') approved++;
      else if (decision === 'REVIEW') review++;
      else if (decision === 'REJECT') rejected++;
    }

    const total = qualityEvents.length;
    return {
      total,
      approved,
      review,
      rejected,
      avgScore: total > 0 ? Math.round(totalScore / total) : 0,
    };
  } catch {
    return { total: 0, approved: 0, review: 0, rejected: 0, avgScore: 0 };
  }
}

async function getEvolution() {
  const data = await redis.hGetAll('fsc:evolution');
  return {
    strategy: data.strategy || 'balanced',
    explorationRate: parseFloat(data.explorationRate || '0.30'),
    diversityIndex: parseFloat(data.diversityIndex || '1.0'),
    recentSuccessRate: parseFloat(data.recentSuccessRate || '0.5'),
    capsuleCount: parseInt(data.capsuleCount || '0'),
  };
}

async function getFullSummary() {
  const [trust, budget, audit, policies, quality, evolution] = await Promise.all([
    getTrustLeaderboard(),
    getBudget(),
    getAuditLog(100),
    getPolicies(),
    getQualitySummary(),
    getEvolution(),
  ]);

  return { trust, budget, audit, policies, quality, evolution };
}

// ============ HTTP Server ============

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // ============ Routes ============
      if (path === '/health') {
        const redisOk = redis.isOpen;
        return json({ status: redisOk ? 'ok' : 'degraded', redis: redisOk, port: PORT });
      }

      if (path === '/api/governance/summary') {
        return json(await getFullSummary());
      }

      if (path === '/api/governance/trust') {
        const limit = parseInt(url.searchParams.get('limit') || '20');
        return json(await getTrustLeaderboard(limit));
      }

      if (path === '/api/governance/budget') {
        return json(await getBudget());
      }

      if (path === '/api/governance/audit') {
        const count = parseInt(url.searchParams.get('count') || '50');
        return json(await getAuditLog(count));
      }

      if (path === '/api/governance/policies') {
        return json(await getPolicies());
      }

      if (path === '/api/governance/quality') {
        return json(await getQualitySummary());
      }

      if (path === '/api/governance/evolution') {
        return json(await getEvolution());
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error(`[${path}] Error:`, err);
      return json({ error: String(err) }, 500);
    }
  },
});

console.log(`[Governance API] Listening on http://0.0.0.0:${server.port}`);
