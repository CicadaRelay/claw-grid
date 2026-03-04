/**
 * Cost Controller 集成测试
 *
 * 覆盖: 初始化、成本记录、模型降级、预算重置、任务准入
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { RedisClientType } from 'redis';
import { CostController } from '../cost-controller';
import { getTestRedis, disconnectTestRedis } from './setup';

describe('CostController', () => {
  let redis: RedisClientType;
  let cost: CostController;

  beforeAll(async () => {
    redis = await getTestRedis();
    cost = new CostController(redis);
  });

  afterAll(async () => {
    await redis.del('fsc:budget');
    await disconnectTestRedis();
  });

  beforeEach(async () => {
    await redis.del('fsc:budget');
    await cost.init();
  });

  it('should initialize with default limits', async () => {
    const state = await cost.getState();
    expect(state.hourlyLimit).toBe(0.50);
    expect(state.dailyLimit).toBe(10);
    expect(state.monthlyLimit).toBe(200);
    expect(state.modelTier).toBe('standard');
    expect(state.hourlySpent).toBe(0);
  });

  it('should record cost and update spent', async () => {
    const result = await cost.recordCost('task-1', 'agent-1', 0.05, 500);
    expect(result.warning).toBe(false);
    expect(result.paused).toBe(false);

    const state = await cost.getState();
    expect(state.hourlySpent).toBeCloseTo(0.05, 2);
    expect(state.dailySpent).toBeCloseTo(0.05, 2);
  });

  it('should downgrade to economy when hourly > 80%', async () => {
    // 花到 80%+
    await cost.recordCost('task-a', 'agent-1', 0.42, 4000);

    const result = await cost.recordCost('task-b', 'agent-1', 0.02, 200);
    // 0.42 + 0.02 = 0.44 → 88% → economy
    expect(result.tier).toBe('economy');
    expect(result.warning).toBe(true);
  });

  it('should pause when hourly >= 100%', async () => {
    await cost.recordCost('task-x', 'agent-1', 0.50, 5000);

    const result = await cost.recordCost('task-y', 'agent-1', 0.01, 100);
    expect(result.tier).toBe('paused');
    expect(result.paused).toBe(true);

    const canAccept = await cost.canAcceptTask();
    expect(canAccept).toBe(false);
  });

  it('should allow tasks when under budget', async () => {
    const canAccept = await cost.canAcceptTask();
    expect(canAccept).toBe(true);
  });

  it('should estimate cost correctly', () => {
    const premiumCost = cost.estimateCost(1000, 'premium');
    const standardCost = cost.estimateCost(1000, 'standard');
    const economyCost = cost.estimateCost(1000, 'economy');

    expect(premiumCost).toBe(3); // 1000 * 0.003
    expect(standardCost).toBe(0.3); // 1000 * 0.0003
    expect(economyCost).toBe(0.1); // 1000 * 0.0001
    expect(premiumCost).toBeGreaterThan(standardCost);
    expect(standardCost).toBeGreaterThan(economyCost);
  });

  it('should update limits', async () => {
    await cost.setLimits({ hourlyLimit: 1.0, dailyLimit: 20 });

    const state = await cost.getState();
    expect(state.hourlyLimit).toBe(1.0);
    expect(state.dailyLimit).toBe(20);
    expect(state.monthlyLimit).toBe(200); // unchanged
  });

  it('should return correct summary percentages', async () => {
    await cost.recordCost('task-s', 'agent-1', 0.25, 2500);

    const summary = await cost.getSummary();
    expect(summary.hourlyUsage).toBe(50); // 0.25/0.50 = 50%
    expect(summary.canAccept).toBe(true);
    expect(summary.tier).toBe('standard');
  });
});
