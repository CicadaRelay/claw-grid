#!/usr/bin/env bun
/**
 * LLM Proxy Lite — 零依赖轻量版
 *
 * 用于 FSC Agent 容器调用廉价模型
 * 支持 Doubao / MiniMax / OpenAI-compatible API
 *
 * 启动: bun run api/llm-proxy-lite.ts
 * 调用: POST http://10.10.0.1:3002/v1/chat/completions
 */

const PORT = parseInt(Bun.env.LLM_PROXY_PORT || '3002');

// 模型提供商配置 (从环境变量或 openclaw.json 读取)
interface Provider {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  api: 'openai' | 'anthropic';
}

// 从 openclaw.json 加载提供商 (如果存在)
function loadProviders(): Provider[] {
  const providers: Provider[] = [];

  // 1. 环境变量优先
  if (Bun.env.DOUBAO_API_KEY) {
    providers.push({
      name: 'volcengine',
      baseUrl: Bun.env.DOUBAO_ENDPOINT || 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: Bun.env.DOUBAO_API_KEY,
      models: ['doubao-seed-2.0-code', 'doubao-pro-32k', 'doubao-lite-32k'],
      api: 'openai',
    });
  }

  if (Bun.env.MINIMAX_API_KEY) {
    providers.push({
      name: 'minimax',
      baseUrl: Bun.env.MINIMAX_ENDPOINT || 'https://api.minimax.chat/v1',
      apiKey: Bun.env.MINIMAX_API_KEY,
      models: ['minimax-2.5', 'abab6.5s-chat'],
      api: 'openai',
    });
  }

  // 2. 从 openclaw.json 补充
  try {
    const configPath = `${Bun.env.HOME}/.openclaw/openclaw.json`;
    const config = JSON.parse(require('fs').readFileSync(configPath, 'utf-8'));
    const ocProviders = config.providers || {};

    for (const [name, p] of Object.entries(ocProviders) as any) {
      if (p.apiKey && !providers.find(x => x.name === name)) {
        providers.push({
          name,
          baseUrl: p.baseUrl || '',
          apiKey: p.apiKey,
          models: p.models || [],
          api: p.api?.includes('anthropic') ? 'anthropic' : 'openai',
        });
      }
    }
  } catch { /* no config file */ }

  return providers;
}

const providers = loadProviders();
console.log(`[LLM Proxy] Loaded ${providers.length} providers: ${providers.map(p => p.name).join(', ')}`);

// 简单令牌桶
let tokens = 30;
const MAX_TOKENS = 30;
const REFILL_RATE = 5; // 每秒
setInterval(() => { tokens = Math.min(MAX_TOKENS, tokens + REFILL_RATE); }, 1000);

// 请求计数
let totalRequests = 0;
let totalErrors = 0;

// 找到支持指定模型的提供商
function findProvider(model: string): Provider | null {
  // 精确匹配
  for (const p of providers) {
    if (p.models.includes(model)) return p;
  }
  // 模糊匹配
  for (const p of providers) {
    if (p.models.some(m => model.includes(m) || m.includes(model))) return p;
  }
  // 返回第一个可用的
  return providers[0] || null;
}

// 转发请求到上游
async function proxyRequest(provider: Provider, body: any): Promise<Response> {
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

const server = Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',

  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        providers: providers.length,
        tokens_remaining: tokens,
        total_requests: totalRequests,
        total_errors: totalErrors,
      });
    }

    // Stats
    if (url.pathname === '/stats') {
      return Response.json({
        providers: providers.map(p => ({ name: p.name, models: p.models })),
        rate_limit: { tokens, max: MAX_TOKENS, refill_per_sec: REFILL_RATE },
        requests: { total: totalRequests, errors: totalErrors },
      });
    }

    // Chat completions
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      totalRequests++;

      // 限流
      if (tokens <= 0) {
        totalErrors++;
        return Response.json({ error: 'Rate limited, retry later' }, { status: 429 });
      }
      tokens--;

      try {
        const body = await req.json();
        const model = body.model || 'doubao-lite-32k';
        const provider = findProvider(model);

        if (!provider) {
          totalErrors++;
          return Response.json({ error: 'No provider available' }, { status: 503 });
        }

        // 强制 token 上限
        const maxTokens = Math.min(body.max_tokens || 4000, 4000);
        body.max_tokens = maxTokens;

        const resp = await proxyRequest(provider, body);
        const data = await resp.json();

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

    return Response.json({ error: 'Not found' }, { status: 404 });
  },
});

console.log(`[LLM Proxy Lite] Running on http://0.0.0.0:${PORT}`);
console.log(`[LLM Proxy Lite] Endpoints:`);
console.log(`  POST /v1/chat/completions`);
console.log(`  GET  /health`);
console.log(`  GET  /stats`);
