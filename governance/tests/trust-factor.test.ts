/**
 * Trust Factor 集成测试
 *
 * 覆盖: 初始化、成功奖励、失败惩罚、连续失败冷却、排行榜、手动调整
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { RedisClientType } from 'redis';
import { TrustFactor } from '../trust-factor';
import { getTestRedis, cleanTestKeys, disconnectTestRedis } from './setup';

// 用自定义前缀隔离测试——直接操纵 Redis key
const TEST_PREFIX = 'fsc:trust:test-';
const LEADERBOARD = 'fsc:trust:test-leaderboard';

describe('TrustFactor', () => {
  let redis: RedisClientType;
  let trust: TrustFactor;

  beforeAll(async () => {
    redis = await getTestRedis();
    trust = new TrustFactor(redis);
  });

  afterAll(async () => {
    // 清理测试数据
    for await (const key of redis.scanIterator({ MATCH: 'fsc:trust:e2e-*', COUNT: 100 })) {
      await redis.del(String(key));
    }
    await redis.del('fsc:trust:leaderboard');
    // 不要清掉 seed 数据，只清 e2e- 前缀
    await disconnectTestRedis();
  });

  beforeEach(async () => {
    // 清理 e2e 测试 agent 数据
    for await (const key of redis.scanIterator({ MATCH: 'fsc:trust:e2e-*', COUNT: 100 })) {
      await redis.del(String(key));
    }
    await redis.zRem('fsc:trust:leaderboard', 'e2e-agent-1');
    await redis.zRem('fsc:trust:leaderboard', 'e2e-agent-2');
    await redis.zRem('fsc:trust:leaderboard', 'e2e-agent-3');
  });

  it('should create default profile for new agent', async () => {
    const profile = await trust.getProfile('e2e-agent-1');
    expect(profile.agentId).toBe('e2e-agent-1');
    expect(profile.score).toBe(50);
    expect(profile.totalTasks).toBe(0);
    expect(profile.consecutiveFailures).toBe(0);
  });

  it('should increase score on task success', async () => {
    const updates = await trust.updateFromReceipt({
      taskId: 'task-e2e-1',
      agentId: 'e2e-agent-1',
      startTime: Date.now() - 5000,
      endTime: Date.now(),
      durationMs: 5000,
      tokensUsed: 1000,
      costUSD: 0.01,
      status: 'success',
      qualityScore: 85,
      policyViolations: [],
      trustDelta: 0,
    });

    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0].type).toBe('reward');

    const profile = await trust.getProfile('e2e-agent-1');
    expect(profile.score).toBeGreaterThan(50);
    expect(profile.successCount).toBe(1);
    expect(profile.totalTasks).toBe(1);
  });

  it('should decrease score on task failure', async () => {
    // 先初始化
    await trust.getProfile('e2e-agent-2');

    const updates = await trust.updateFromReceipt({
      taskId: 'task-e2e-2',
      agentId: 'e2e-agent-2',
      startTime: Date.now() - 3000,
      endTime: Date.now(),
      durationMs: 3000,
      tokensUsed: 500,
      costUSD: 0.005,
      status: 'failure',
      qualityScore: 0,
      policyViolations: [],
      trustDelta: 0,
      failureClass: 'QUALITY',
    });

    expect(updates.some(u => u.type === 'penalty')).toBe(true);

    const profile = await trust.getProfile('e2e-agent-2');
    expect(profile.score).toBeLessThan(50);
    expect(profile.failCount).toBe(1);
    expect(profile.consecutiveFailures).toBe(1);
  });

  it('should trigger cooldown after 3 consecutive failures', async () => {
    await trust.getProfile('e2e-agent-3');

    for (let i = 0; i < 3; i++) {
      await trust.updateFromReceipt({
        taskId: `task-e2e-fail-${i}`,
        agentId: 'e2e-agent-3',
        startTime: Date.now() - 1000,
        endTime: Date.now(),
        durationMs: 1000,
        tokensUsed: 100,
        costUSD: 0.001,
        status: 'failure',
        qualityScore: 0,
        policyViolations: [],
        trustDelta: 0,
        failureClass: 'PERMANENT',
      });
    }

    const inCooldown = await trust.isInCooldown('e2e-agent-3');
    expect(inCooldown).toBe(true);

    const profile = await trust.getProfile('e2e-agent-3');
    expect(profile.consecutiveFailures).toBe(3);
    expect(profile.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it('should quality excellent bonus on score >= 90', async () => {
    await trust.getProfile('e2e-agent-1');
    const scoreBefore = await trust.getScore('e2e-agent-1');

    await trust.updateFromReceipt({
      taskId: 'task-e2e-excellent',
      agentId: 'e2e-agent-1',
      startTime: Date.now() - 2000,
      endTime: Date.now(),
      durationMs: 2000,
      tokensUsed: 800,
      costUSD: 0.008,
      status: 'success',
      qualityScore: 95,
      policyViolations: [],
      trustDelta: 0,
    });

    const scoreAfter = await trust.getScore('e2e-agent-1');
    // 基础奖励 5 + 质量优秀 3 = 至少 +8
    expect(scoreAfter - scoreBefore).toBeGreaterThanOrEqual(8);
  });

  it('should populate leaderboard', async () => {
    // 确保至少有 e2e-agent-1 在排行榜
    await trust.getProfile('e2e-agent-1');
    await trust.updateFromReceipt({
      taskId: 'task-e2e-lb',
      agentId: 'e2e-agent-1',
      startTime: Date.now(),
      endTime: Date.now(),
      durationMs: 100,
      tokensUsed: 10,
      costUSD: 0.0001,
      status: 'success',
      qualityScore: 70,
      policyViolations: [],
      trustDelta: 0,
    });

    const top = await trust.getTopAgents(10);
    expect(top.length).toBeGreaterThan(0);
    // 每个 entry 应有 agentId 和 score
    expect(top[0]).toHaveProperty('agentId');
    expect(top[0]).toHaveProperty('score');
  });

  it('should apply policy violation penalty', async () => {
    await trust.getProfile('e2e-agent-1');
    const before = await trust.getScore('e2e-agent-1');

    await trust.updateFromReceipt({
      taskId: 'task-e2e-violation',
      agentId: 'e2e-agent-1',
      startTime: Date.now(),
      endTime: Date.now(),
      durationMs: 100,
      tokensUsed: 5000, // 超过 4000 限制
      costUSD: 0.05,
      status: 'success',
      qualityScore: 60,
      policyViolations: [{
        ruleId: 'CONST_001',
        ruleName: 'token_limit',
        enforcement: 'hard' as const,
        penalty: 10,
        details: 'Token limit exceeded',
        timestamp: Date.now(),
      }],
      trustDelta: 0,
    });

    const after = await trust.getScore('e2e-agent-1');
    // 成功 +3, 违规 -10 → 净 -7
    expect(after).toBeLessThan(before);
  });
});
