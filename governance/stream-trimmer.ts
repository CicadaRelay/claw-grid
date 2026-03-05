/**
 * FSC-Mesh Stream Trimmer — Redis Stream 定期修剪 + 内存回收
 *
 * 防止 fsc:tasks, fsc:results, fsc:heartbeats 等无限增长逼近 256MB maxmem。
 * 每 5 分钟 XTRIM 主要 stream + 清理已决议投票流。
 * 预计回收 20-30MB Redis 内存。
 */

import type { RedisClientType } from 'redis';

const TRIM_INTERVAL_MS = 5 * 60_000; // 5 分钟

const STREAM_LIMITS: Record<string, number> = {
  'fsc:tasks': 5000,
  'fsc:results': 5000,
  'fsc:heartbeats': 1000,
  'fsc:mem_events': 2000,
  'fsc:dlq': 500,
  'fsc:review_queue': 1000,
};

// 已决议投票流前缀
const VOTE_STREAM_PREFIX = 'fsc:votes:';

export class StreamTrimmer {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private redis: RedisClientType) {}

  /** 启动定期修剪 */
  start(): void {
    // 启动时立即执行一次
    this.trim();

    this.timer = setInterval(() => this.trim(), TRIM_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  /** 停止修剪 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 执行一次修剪 */
  async trim(): Promise<{ trimmed: Record<string, number>; votesCleared: number }> {
    const trimmed: Record<string, number> = {};
    let votesCleared = 0;

    // 1. 修剪主要 stream
    const pipeline = this.redis.multi();
    for (const [stream, maxLen] of Object.entries(STREAM_LIMITS)) {
      pipeline.xTrim(stream, 'MAXLEN', maxLen);
    }

    try {
      const results = await pipeline.exec();
      let i = 0;
      for (const stream of Object.keys(STREAM_LIMITS)) {
        const removed = results[i] as unknown as number;
        if (removed > 0) trimmed[stream] = removed;
        i++;
      }
    } catch { /* 部分 stream 可能不存在 */ }

    // 2. 清理已决议的投票流 (fsc:votes:*)
    try {
      const voteKeys: string[] = [];
      for await (const key of this.redis.scanIterator({ MATCH: `${VOTE_STREAM_PREFIX}*`, COUNT: 100 })) {
        voteKeys.push(String(key));
      }

      for (const voteKey of voteKeys) {
        // 检查投票流是否已有决议结果
        const len = await this.redis.xLen(voteKey);
        if (len === 0) {
          // 空流，直接删除
          await this.redis.del(voteKey);
          votesCleared++;
          continue;
        }

        // 检查是否有对应的决议记录 (超过 deadline 的投票流可以清理)
        const entries = await this.redis.xRange(voteKey, '-', '+', { COUNT: 1 });
        if (entries.length > 0) {
          const firstTs = parseInt(entries[0].message.timestamp || '0');
          // 超过 1 小时的投票流清理
          if (firstTs > 0 && Date.now() - firstTs > 3_600_000) {
            await this.redis.del(voteKey);
            votesCleared++;
          }
        }
      }
    } catch { /* 清理失败不阻塞 */ }

    return { trimmed, votesCleared };
  }
}
