#!/usr/bin/env bun
/**
 * SSE Streaming Chat API — Bun.serve 版
 *
 * 代理到 llm-proxy-lite (port 3002) 的 /v1/chat/completions，
 * 将上游响应转为 SSE 流式输出。
 */

const PORT = parseInt(process.env.STREAM_PORT || '3003');
const LLM_PROXY_URL = process.env.LLM_PROXY_URL || 'http://127.0.0.1:3002';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', timestamp: Date.now() }, { headers: CORS_HEADERS });
    }

    if (url.pathname === '/api/stream/chat' && req.method === 'POST') {
      const body = await req.json();
      const { messages, model = 'doubao-pro-32k' } = body;

      // 代理到 llm-proxy-lite
      const upstream = await fetch(`${LLM_PROXY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, model, max_tokens: 4000, stream: false }),
        signal: AbortSignal.timeout(30000),
      }).catch((err: Error) => err);

      if (upstream instanceof Error) {
        return Response.json(
          { error: `LLM proxy unavailable: ${upstream.message}` },
          { status: 502, headers: CORS_HEADERS },
        );
      }

      if (!upstream.ok) {
        const errBody = await upstream.text();
        return new Response(errBody, { status: upstream.status, headers: CORS_HEADERS });
      }

      const data = await upstream.json() as any;
      const content = data.choices?.[0]?.message?.content || '';

      // SSE 流式输出 — 逐 token 发送
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          // 按句子/标点切分发送，比逐字更高效
          const chunks = content.match(/[^。！？\n]+[。！？\n]?/g) || [content];
          for (const chunk of chunks) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ content: chunk, done: false })}\n\n`));
            await new Promise(r => setTimeout(r, 30));
          }
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ content: '', done: true })}\n\n`));
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          ...CORS_HEADERS,
        },
      });
    }

    return Response.json({ error: 'Not found' }, { status: 404, headers: CORS_HEADERS });
  },
});

console.log(`[SSE Stream] Listening on http://0.0.0.0:${PORT}`);
console.log(`[SSE Stream] Upstream: ${LLM_PROXY_URL}`);
