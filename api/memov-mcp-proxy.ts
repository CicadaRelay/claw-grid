#!/usr/bin/env bun
/**
 * MemoV MCP Proxy Server
 * 
 * 功能：
 * - 转发前端请求到 MemoV MCP 服务器
 * - WebSocket 实时推送 MemoV 事件
 * - 提供 RESTful API 接口
 */

import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import express from 'express';
import cors from 'cors';
import { createClient } from 'redis';

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ============ 配置 ============
const PORT = parseInt(process.env.PORT || '3001');
const REDIS_HOST = process.env.REDIS_HOST || '10.10.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const MEMOV_PATH = process.env.MEMOV_PATH || '/opt/claw-mesh/.mem';

// ============ Redis 客户端 ============
const redis = createClient({
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT
  }
});

redis.on('error', (err) => console.error('Redis error:', err));
redis.on('connect', () => console.log('Redis connected'));

// ============ 中间件 ============
app.use(cors());
app.use(express.json());

// ============ API 路由 ============

// 获取 Mesh 拓扑
app.get('/api/mesh/topology', async (req, res) => {
  try {
    // 从 Redis 获取所有 Worker 心跳
    const heartbeats = await redis.xRead(
      [{ key: 'fsc:heartbeats', id: '0' }],
      { COUNT: 100 }
    );
    
    const nodes = [];
    if (heartbeats) {
      for (const { messages } of heartbeats) {
        for (const { message } of messages) {
          const metrics = JSON.parse(message.metrics);
          nodes.push({
            id: message.agent,
            ...metrics
          });
        }
      }
    }
    
    res.json({ nodes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取 MemoV 时间线
app.get('/api/memov/timeline', async (req, res) => {
  try {
    const { since = '0', limit = 50 } = req.query;
    
    const events = await redis.xRead(
      [{ key: 'fsc:mem_events', id: since as string }],
      { COUNT: parseInt(limit as string) }
    );
    
    const timeline = [];
    if (events) {
      for (const { messages } of events) {
        for (const { id, message } of messages) {
          timeline.push({
            id,
            ...message,
            timestamp: parseInt(message.timestamp)
          });
        }
      }
    }
    
    res.json({ timeline });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 全局搜索
app.post('/api/search', async (req, res) => {
  try {
    const { query, limit = 10 } = req.body;
    
    // TODO: 集成 Qdrant 向量搜索
    // 目前返回模拟数据
    const results = [
      {
        pointer: 'ptr://test/demo/example@v1',
        score: 0.95,
        content: 'Example search result',
        timestamp: Date.now()
      }
    ];
    
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 因果调试
app.post('/api/causal/debug', async (req, res) => {
  try {
    const { pointer, mode } = req.body;
    
    // TODO: 调用 causal.js 进行因果分析
    const analysis = {
      pointer,
      mode,
      issues: [],
      suggestions: []
    };
    
    res.json(analysis);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 时光回滚
app.post('/api/memov/rollback', async (req, res) => {
  try {
    const { timestamp, target } = req.body;
    
    // TODO: 实现 MemoV 回滚逻辑
    res.json({
      success: true,
      message: `Rolled back to ${new Date(timestamp).toISOString()}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    redis: redis.isOpen ? 'connected' : 'disconnected'
  });
});

// ============ WebSocket 实时推送 ============
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // 订阅 Redis Streams
  const subscriber = redis.duplicate();
  
  subscriber.connect().then(async () => {
    // 监听 MemoV 事件
    while (true) {
      try {
        const events = await subscriber.xRead(
          [{ key: 'fsc:mem_events', id: '$' }],
          { BLOCK: 1000 }
        );
        
        if (events) {
          for (const { messages } of events) {
            for (const { id, message } of messages) {
              socket.emit('memov:event', {
                id,
                ...message,
                timestamp: parseInt(message.timestamp)
              });
            }
          }
        }
      } catch (error) {
        console.error('Stream read error:', error);
        break;
      }
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    subscriber.quit();
  });
});

// ============ 启动服务器 ============
async function start() {
  await redis.connect();
  
  server.listen(PORT, () => {
    console.log(`MemoV MCP Proxy listening on port ${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
