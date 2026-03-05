#!/usr/bin/env bun
/**
 * LLM Proxy Lite — 零依赖轻量版
 *
 * 用于 FSC Agent 容器调用廉价模型 + 结果上报到 Redis
 * 支持 Doubao / MiniMax / OpenAI-compatible / Anthropic API
 *
 * 启动: bun run api/llm-proxy-lite.ts
 *
 * 端点:
 *   POST /v1/chat/completions  — LLM 调用 (令牌桶限流)
 *   POST /v1/report            — Agent 结果上报到 Redis Streams
 *   GET  /health               — 健康检查
 *   GET  /stats                — 统计信息
 */

import { createClient, type RedisClientType } from 'redis';
import { FreeProviderPool } from './free-provider-pool';

const PORT = parseInt(process.env.LLM_PROXY_PORT || '3002');

// ============ Redis 连接 ============
const REDIS_HOST = process.env.REDIS_HOST || '10.10.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || 'fsc-mesh-2026';

let redis: RedisClientType | null = null;
let freePool: FreeProviderPool | null = null;

async function getRedis(): Promise<RedisClientType> {
  if (redis && redis.isOpen) return redis;
  redis = createClient({
    url: `redis://:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT}`,
  });
  redis.on('error', (err) => console.error('[Redis] Error:', err.message));
  await redis.connect();
  console.log('[Redis] Connected');

  // 初始化 FreeProviderPool
  freePool = new FreeProviderPool(redis as any);
  await freePool.init();

  return redis;
}

// 异步初始化 Redis (不阻塞启动)
getRedis().catch((e) => console.error('[Redis] Init failed:', e.message));

// ============ Provider 配置 ============
interface Provider {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  api: 'openai' | 'anthropic';
  _freeId?: string;  // 标记来自 FreeProviderPool 的 endpoint ID
}

function loadProvidersSync(): Provider[] {
  const providers: Provider[] = [];

  if (process.env.DOUBAO_API_KEY) {
    providers.push({
      name: 'volcengine',
      baseUrl: process.env.DOUBAO_ENDPOINT || 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: process.env.DOUBAO_API_KEY,
      models: ['doubao-seed-2.0-code', 'doubao-pro-32k', 'doubao-lite-32k'],
      api: 'openai',
    });
  }

  if (process.env.MINIMAX_API_KEY) {
    providers.push({
      name: 'minimax',
      baseUrl: process.env.MINIMAX_ENDPOINT || 'https://api.minimax.chat/v1',
      apiKey: process.env.MINIMAX_API_KEY,
      models: ['minimax-2.5', 'abab6.5s-chat'],
      api: 'openai',
    });
  }

  const home = process.env.HOME || '/root';
  const configPath = `${home}/.openclaw/openclaw.json`;

  try {
    const { readFileSync } = require('node:fs');
    const text = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(text);
    const modelsSection = config.models || {};
    const ocProviders = modelsSection.providers || config.providers || {};

    for (const [name, p] of Object.entries(ocProviders) as any) {
      if (p.apiKey && !providers.find(x => x.name === name)) {
        const rawModels = p.models || [];
        const modelIds = rawModels.map((m: any) => typeof m === 'string' ? m : m.id).filter(Boolean);
        providers.push({
          name,
          baseUrl: p.baseUrl || '',
          apiKey: p.apiKey,
          models: modelIds,
          api: p.api?.includes('anthropic') ? 'anthropic' : 'openai',
        });
      }
    }
    console.log(`[LLM Proxy] Loaded ${Object.keys(ocProviders).length} providers from ${configPath}`);
  } catch (e: any) {
    console.error(`[LLM Proxy] Config load error: ${e.message} (path: ${configPath})`);
  }

  return providers;
}

const providers = loadProvidersSync();
console.log(`[LLM Proxy] Loaded ${providers.length} providers: ${providers.map(p => p.name).join(', ')}`);

// ============ 令牌桶限流 (适配 100+ 并发) ============
let tokens = 100;
const MAX_TOKENS = 100;
const REFILL_RATE = 20; // 每秒补 20
setInterval(() => { tokens = Math.min(MAX_TOKENS, tokens + REFILL_RATE); }, 1000);

// ============ 统计 ============
let totalRequests = 0;
let totalErrors = 0;
let totalReports = 0;

// ============ Provider 路由 ============
function findProvider(model: string): Provider | null {
  const ml = model.toLowerCase();

  // 免费模型: ":free" 后缀 或 "openrouter/free" 标识
  if (freePool && (ml.includes(':free') || ml === 'openrouter/free')) {
    const ep = freePool.getNextEndpoint();
    if (ep) {
      return {
        name: `free:${ep.provider}`,
        baseUrl: ep.baseUrl,
        apiKey: ep.apiKey,
        models: [ep.model],
        api: 'openai',
        _freeId: ep.id,
      };
    }
    // 无可用 free endpoint，降级到普通 provider
  }

  // 精确匹配 (大小写不敏感)
  for (const p of providers) {
    if (p.models.some(m => m.toLowerCase() === ml)) return p;
  }
  // 模糊匹配 (大小写不敏感)
  for (const p of providers) {
    if (p.models.some(m => ml.includes(m.toLowerCase()) || m.toLowerCase().includes(ml))) return p;
  }
  return providers[0] || null;
}

// ============ 上游请求 ============
async function proxyRequest(provider: Provider, body: any): Promise<Response> {
  if (provider.api === 'anthropic') {
    const url = `${provider.baseUrl}/v1/messages`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body.model,
        max_tokens: body.max_tokens || 4000,
        messages: body.messages || [],
      }),
    });
    const data: any = await resp.json();
    if (data.content) {
      // 提取 text 类型内容块 (跳过 thinking 块)
      const textBlock = data.content.find((c: any) => c.type === 'text');
      const content = textBlock?.text || data.content[0]?.text || '';
      return Response.json({
        choices: [{ message: { role: 'assistant', content } }],
        model: data.model,
        usage: data.usage,
      });
    }
    return Response.json(data, { status: resp.status });
  }

  const url = `${provider.baseUrl}/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  return resp;
}

// ============ HTTP Server ============
const server = Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',

  async fetch(req) {
    const url = new URL(req.url);

    // --- Health ---
    if (url.pathname === '/health') {
      const redisOk = redis?.isOpen ?? false;
      return Response.json({
        status: 'ok',
        providers: providers.length,
        redis: redisOk,
        tokens_remaining: tokens,
        total_requests: totalRequests,
        total_errors: totalErrors,
        total_reports: totalReports,
      });
    }

    // --- Stats ---
    if (url.pathname === '/stats') {
      return Response.json({
        providers: providers.map(p => ({ name: p.name, models: p.models })),
        rate_limit: { tokens, max: MAX_TOKENS, refill_per_sec: REFILL_RATE },
        requests: { total: totalRequests, errors: totalErrors, reports: totalReports },
      });
    }

    // --- Agent 结果上报 ---
    if (url.pathname === '/v1/report' && req.method === 'POST') {
      totalReports++;
      try {
        const body = await req.json();
        const r = await getRedis();

        // 写入 fsc:results
        await r.xAdd('fsc:results', '*', {
          task_id: body.task_id || 'unknown',
          agent_id: body.agent_id || 'unknown',
          status: body.status || 'unknown',
          exit_code: String(body.exit_code ?? -1),
          model: body.model || '',
          result_preview: String(body.result_preview || '').slice(0, 500),
          duration_ms: String(body.duration_ms ?? 0),
        });

        // 写入 fsc:events
        await r.xAdd('fsc:events', '*', {
          type: body.status === 'success' ? 'task_complete' : 'task_failed',
          agent_id: body.agent_id || 'unknown',
          task_id: body.task_id || 'unknown',
          model: body.model || '',
        });

        return Response.json({ ok: true });
      } catch (err: any) {
        totalErrors++;
        console.error(`[Report] Error: ${err.message}`);
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // --- Chat Completions ---
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      totalRequests++;

      if (tokens <= 0) {
        totalErrors++;
        return Response.json({ error: 'Rate limited, retry later' }, { status: 429 });
      }
      tokens--;

      try {
        const body = await req.json();
        const model = body.model || 'doubao-lite-32k';
        let provider = findProvider(model);

        if (!provider) {
          totalErrors++;
          return Response.json({ error: 'No provider available' }, { status: 503 });
        }

        body.max_tokens = Math.min(body.max_tokens || 4000, 4000);

        // Free endpoint: 用实际模型名替换请求中的模型
        if (provider._freeId) {
          body.model = provider.models[0];
        }

        let resp = await proxyRequest(provider, body);
        let data: any = await resp.json();

        // Free endpoint 失败 → 报告 + 重试一次
        if (!resp.ok && provider._freeId && freePool) {
          freePool.reportFailure(provider._freeId);
          console.log(`[LLM Proxy] Free endpoint failed (${provider._freeId}), retrying...`);

          const retryProvider = findProvider(model);
          if (retryProvider && retryProvider._freeId !== provider._freeId) {
            if (retryProvider._freeId) {
              body.model = retryProvider.models[0];
            }
            resp = await proxyRequest(retryProvider, body);
            data = await resp.json();
            provider = retryProvider;

            if (!resp.ok && retryProvider._freeId) {
              freePool.reportFailure(retryProvider._freeId);
            } else if (resp.ok && retryProvider._freeId) {
              freePool.reportSuccess(retryProvider._freeId);
            }
          }
        } else if (resp.ok && provider._freeId && freePool) {
          freePool.reportSuccess(provider._freeId);
        }

        if (!resp.ok) {
          totalErrors++;
          console.log(`[LLM Proxy] ${provider.name} error ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
        }

        return Response.json(data, { status: resp.status });
      } catch (err: any) {
        totalErrors++;
        console.error(`[LLM Proxy] Error: ${err.message}`);
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // --- Free Provider CRUD ---
    if (url.pathname === '/free-providers') {
      if (req.method === 'GET') {
        if (!freePool) return Response.json({ endpoints: [], summary: { total: 0, healthy: 0, open: 0, halfOpen: 0 } });
        return Response.json({ endpoints: freePool.getStatus(), summary: freePool.getSummary() });
      }

      if (req.method === 'POST') {
        if (!freePool) return Response.json({ error: 'Free pool not initialized' }, { status: 503 });
        try {
          const body = await req.json();
          const ep = await freePool.addEndpoint({
            provider: body.provider || 'custom',
            baseUrl: body.baseUrl,
            apiKey: body.apiKey || '',
            model: body.model,
            enabled: body.enabled !== false,
          });
          return Response.json({ ok: true, endpoint: ep });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 400 });
        }
      }
    }

    // DELETE/PATCH /free-providers/:id
    if (url.pathname.startsWith('/free-providers/')) {
      const id = decodeURIComponent(url.pathname.slice('/free-providers/'.length));

      if (req.method === 'DELETE') {
        if (!freePool) return Response.json({ error: 'Free pool not initialized' }, { status: 503 });
        const ok = await freePool.removeEndpoint(id);
        return Response.json({ ok });
      }

      if (req.method === 'PATCH') {
        if (!freePool) return Response.json({ error: 'Free pool not initialized' }, { status: 503 });
        try {
          const body = await req.json();
          const ok = await freePool.setEnabled(id, body.enabled);
          return Response.json({ ok });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 400 });
        }
      }
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  },
});

console.log(`[LLM Proxy Lite] Running on http://0.0.0.0:${PORT}`);
console.log(`  POST /v1/chat/completions  — LLM 调用`);
console.log(`  POST /v1/report            — Agent 结果上报`);
console.log(`  GET  /health | /stats`);
