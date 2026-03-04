/**
 * Policy Engine 集成测试
 *
 * 覆盖: 内置规则验证、token 限制、信誉门槛、容量限制、热更新、规则管理
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RedisClientType } from 'redis';
import { PolicyEngine } from '../policy-engine';
import { getTestRedis, disconnectTestRedis } from './setup';

describe('PolicyEngine', () => {
  let redis: RedisClientType;
  let engine: PolicyEngine;

  beforeAll(async () => {
    redis = await getTestRedis();
    engine = new PolicyEngine(redis);
    // 不调 init() 避免订阅——只测纯验证逻辑
  });

  afterAll(async () => {
    await engine.shutdown().catch(() => {});
    // 清理自定义规则
    await redis.del('fsc:policies');
    await disconnectTestRedis();
  });

  it('should have 7 built-in rules', () => {
    const rules = engine.listRules();
    expect(rules.length).toBe(7);
    expect(rules.filter(r => r.level === 'constitutional').length).toBe(5);
    expect(rules.filter(r => r.level === 'operational').length).toBe(2);
  });

  it('should allow valid task', () => {
    const result = engine.validate(
      { estimatedTokens: 2000, riskLevel: 'low', requiredTrustScore: 30 },
      { score: 60, consecutiveFailures: 0, cooldownUntil: 0 },
      { hourlySpent: 0.10, hourlyLimit: 0.50 },
      3, // activeTasks
      10, // maxConcurrent
    );

    expect(result.allowed).toBe(true);
    expect(result.violations.length).toBe(0);
  });

  it('should block task exceeding token limit', () => {
    const result = engine.validate(
      { estimatedTokens: 5000, riskLevel: 'low', requiredTrustScore: 20 },
      { score: 60, consecutiveFailures: 0, cooldownUntil: 0 },
      { hourlySpent: 0.10, hourlyLimit: 0.50 },
      3, 10,
    );

    expect(result.allowed).toBe(false);
    const tokenViolation = result.violations.find(v => v.ruleId === 'CONST_001');
    expect(tokenViolation).toBeDefined();
    expect(tokenViolation!.ruleName).toBe('token_limit');
  });

  it('should block task when hourly budget exceeded', () => {
    const result = engine.validate(
      { estimatedTokens: 1000, riskLevel: 'low', requiredTrustScore: 20 },
      { score: 60, consecutiveFailures: 0, cooldownUntil: 0 },
      { hourlySpent: 0.60, hourlyLimit: 0.50 },
      1, 10,
    );

    expect(result.allowed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'CONST_002')).toBe(true);
  });

  it('should block low-trust agent from high-trust task', () => {
    const result = engine.validate(
      { estimatedTokens: 1000, riskLevel: 'high', requiredTrustScore: 60 },
      { score: 30, consecutiveFailures: 0, cooldownUntil: 0 },
      { hourlySpent: 0.10, hourlyLimit: 0.50 },
      1, 10,
    );

    expect(result.allowed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'CONST_003')).toBe(true);
  });

  it('should block when node capacity full', () => {
    const result = engine.validate(
      { estimatedTokens: 1000, riskLevel: 'low', requiredTrustScore: 20 },
      { score: 60, consecutiveFailures: 0, cooldownUntil: 0 },
      { hourlySpent: 0.10, hourlyLimit: 0.50 },
      10, 10, // full capacity
    );

    expect(result.allowed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'CONST_004')).toBe(true);
  });

  it('should block critical task with low-trust agent', () => {
    const result = engine.validate(
      { estimatedTokens: 1000, riskLevel: 'critical', requiredTrustScore: 20 },
      { score: 50, consecutiveFailures: 0, cooldownUntil: 0 },
      { hourlySpent: 0.10, hourlyLimit: 0.50 },
      1, 10,
    );

    expect(result.allowed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'CONST_005')).toBe(true);
  });

  it('should warn (not block) on consecutive failures < 3', () => {
    const result = engine.validate(
      { estimatedTokens: 1000, riskLevel: 'low', requiredTrustScore: 20 },
      { score: 60, consecutiveFailures: 2, cooldownUntil: 0 },
      { hourlySpent: 0.10, hourlyLimit: 0.50 },
      1, 10,
    );

    // OPS_001 连续失败 < 3 → 通过
    expect(result.allowed).toBe(true);
  });

  it('should block agent in cooldown', () => {
    const result = engine.validate(
      { estimatedTokens: 1000, riskLevel: 'low', requiredTrustScore: 20 },
      { score: 60, consecutiveFailures: 0, cooldownUntil: Date.now() + 60000 },
      { hourlySpent: 0.10, hourlyLimit: 0.50 },
      1, 10,
    );

    expect(result.allowed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'OPS_002')).toBe(true);
  });

  it('should support adding custom rules', async () => {
    await engine.upsertRule({
      id: 'CUSTOM_001',
      name: 'test_rule',
      description: 'Test custom rule',
      level: 'operational',
      condition: 'task.estimatedTokens <= 3000',
      enforcement: 'soft',
      penalty: 2,
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    });

    const rules = engine.listRules();
    expect(rules.some(r => r.id === 'CUSTOM_001')).toBe(true);

    // 验证规则生效
    const result = engine.validate(
      { estimatedTokens: 3500, riskLevel: 'low', requiredTrustScore: 20 },
      { score: 60, consecutiveFailures: 0, cooldownUntil: 0 },
      { hourlySpent: 0.10, hourlyLimit: 0.50 },
      1, 10,
    );

    // soft enforcement → warning, not violation
    expect(result.warnings.some(w => w.ruleId === 'CUSTOM_001')).toBe(true);
    expect(result.allowed).toBe(true); // soft 不阻止

    // 清理
    await engine.removeRule('CUSTOM_001');
  });

  it('should not allow deleting constitutional rules', async () => {
    await engine.removeRule('CONST_001');
    const rules = engine.listRules();
    expect(rules.some(r => r.id === 'CONST_001')).toBe(true);
  });
});
