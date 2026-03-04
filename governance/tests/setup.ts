/**
 * 测试辅助 — Redis 连接 + 清理
 *
 * 使用 fsc:test:* 前缀隔离测试数据，每次测试后清理
 */

import { createClient, type RedisClientType } from 'redis';

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '16379');
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || 'fsc-mesh-2026';

let _redis: RedisClientType | null = null;

export async function getTestRedis(): Promise<RedisClientType> {
  if (_redis && _redis.isOpen) return _redis;

  _redis = createClient({
    socket: { host: REDIS_HOST, port: REDIS_PORT },
    password: REDIS_PASSWORD,
  }) as RedisClientType;

  _redis.on('error', () => {}); // suppress in tests
  await _redis.connect();
  return _redis;
}

export async function cleanTestKeys(redis: RedisClientType, prefix = 'fsc:test:'): Promise<void> {
  for await (const key of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
    await redis.del(String(key));
  }
}

export async function disconnectTestRedis(): Promise<void> {
  if (_redis && _redis.isOpen) {
    await _redis.quit();
    _redis = null;
  }
}
