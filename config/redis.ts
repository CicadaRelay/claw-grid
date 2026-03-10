/**
 * Redis 连接配置 — 集中管理，避免 6 处硬编码
 * v2: 支持 Tailscale 网络
 */
import { getRedisMasterIp } from './network';

export const REDIS_HOST = process.env.REDIS_HOST || getRedisMasterIp();
export const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
export const REDIS_PASSWORD = process.env.REDIS_PASSWORD || ''; // 从环境变量读取

export const REDIS_URL = `redis://:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT}`;

export function redisConfig() {
  return {
    url: REDIS_URL,
    socket: { connectTimeout: 5000, reconnectStrategy: (retries: number) => Math.min(retries * 500, 5000) },
  };
}
