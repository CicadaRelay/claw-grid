/**
 * 端到端治理流水线测试
 *
 * 完整链路: 策略检查 → 任务执行(模拟) → 质量评估 → 信誉更新 → 审计记录 → 成本追踪
 * 验证所有治理组件协同工作
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RedisClientType } from 'redis';
import { createGovernanceLayer, shutdownGovernanceLayer, type GovernanceLayer } from '../index';
import { getTestRedis, disconnectTestRedis } from './setup';

describe('E2E Governance Pipeline', () => {
  let redis: RedisClientType;
  let gov: GovernanceLayer;

  beforeAll(async () => {
    redis = await getTestRedis();
    gov = await createGovernanceLayer(redis);
  });

  afterAll(async () => {
    await shutdownGovernanceLayer(gov);
    // 清理 e2e 测试数据
    const keysToClean = [
      'fsc:budget',
      'fsc:evolution',
      'fsc:review_queue',
      'fsc:governance:audit',
    ];
    for (const k of keysToClean) {
      await redis.del(k).catch(() => {});
    }
    for await (const key of redis.scanIterator({ MATCH: 'fsc:trust:e2e-pipe-*', COUNT: 100 })) {
      await redis.del(String(key));
    }
    await redis.zRem('fsc:trust:leaderboard', 'e2e-pipe-agent');
    await disconnectTestRedis();
  });

  it('should run full governance pipeline for a successful task', async () => {
    const agentId = 'e2e-pipe-agent';
    const taskId = 'e2e-pipe-task-001';

    // Step 1: 初始化 Agent
    const profile = await gov.trust.getProfile(agentId);
    expect(profile.score).toBe(50);

    // Step 2: 策略检查 — 应该通过
    const policyCheck = gov.policy.validate(
      { estimatedTokens: 2000, riskLevel: 'low', requiredTrustScore: 20 },
      { score: profile.score, consecutiveFailures: 0, cooldownUntil: 0 },
      { hourlySpent: 0, hourlyLimit: 0.50 },
      1, 10,
    );
    expect(policyCheck.allowed).toBe(true);

    // Step 3: 审计记录 — 策略检查通过
    await gov.audit.logPolicyCheck(taskId, agentId, true, []);

    // Step 4: 质量评估 — 模拟好代码
    const qualityReport = await gov.quality.evaluate({
      taskId,
      agentId,
      gitDiff: 'diff --git a/src/new.ts b/src/new.ts\n+export const x = 42;',
      testOutput: 'Tests: 10 passed, 0 failed',
      lintOutput: 'No issues',
      typecheckOutput: 'OK',
      riskLevel: 'low',
      touchedFiles: ['src/new.ts'],
      commitMessage: 'feat: add x constant for configuration',
    });
    expect(qualityReport.decision).toBe('APPROVE');
    expect(qualityReport.totalScore).toBeGreaterThanOrEqual(70);

    // Step 5: 审计记录 — 质量检查
    await gov.audit.logQualityCheck(taskId, agentId, qualityReport.totalScore, qualityReport.decision);

    // Step 6: 成本记录
    const costResult = await gov.cost.recordCost(taskId, agentId, 0.01, 1500);
    expect(costResult.paused).toBe(false);

    // Step 7: 信誉更新
    const trustUpdates = await gov.trust.updateFromReceipt({
      taskId,
      agentId,
      startTime: Date.now() - 5000,
      endTime: Date.now(),
      durationMs: 5000,
      tokensUsed: 1500,
      costUSD: 0.01,
      status: 'success',
      qualityScore: qualityReport.totalScore,
      policyViolations: [],
      trustDelta: 0,
    });

    expect(trustUpdates.length).toBeGreaterThan(0);
    expect(trustUpdates[0].type).toBe('reward');

    // Step 8: 验证信誉提升
    const updatedProfile = await gov.trust.getProfile(agentId);
    expect(updatedProfile.score).toBeGreaterThan(50);
    expect(updatedProfile.successCount).toBe(1);
    expect(updatedProfile.totalTasks).toBe(1);

    // Step 9: 验证审计日志
    const auditEntries = await gov.audit.getByTask(taskId);
    expect(auditEntries.length).toBeGreaterThanOrEqual(2); // policy_check + quality_check
  });

  it('should block and penalize a bad task', async () => {
    const agentId = 'e2e-pipe-agent';
    const taskId = 'e2e-pipe-task-002';

    // Step 1: 质量评估 — 模拟差代码
    const qualityReport = await gov.quality.evaluate({
      taskId,
      agentId,
      gitDiff: 'diff --git a/src/bad.ts b/src/bad.ts\n+eval("rm -rf /")',
      testOutput: 'Tests: 0 passed, 5 failed',
      lintOutput: 'error: no-eval detected',
      typecheckOutput: 'error TS1005: unexpected token',
      riskLevel: 'low',
      touchedFiles: ['src/bad.ts'],
      commitMessage: 'x',
    });
    expect(qualityReport.decision).toBe('REJECT');
    expect(qualityReport.totalScore).toBeLessThan(40);

    // Step 2: 信誉扣分
    const scoreBefore = await gov.trust.getScore(agentId);
    await gov.trust.updateFromReceipt({
      taskId,
      agentId,
      startTime: Date.now() - 2000,
      endTime: Date.now(),
      durationMs: 2000,
      tokensUsed: 500,
      costUSD: 0.005,
      status: 'failure',
      qualityScore: qualityReport.totalScore,
      policyViolations: [],
      trustDelta: 0,
      failureClass: 'QUALITY',
    });

    const scoreAfter = await gov.trust.getScore(agentId);
    expect(scoreAfter).toBeLessThan(scoreBefore);
  });

  it('should block policy-violating task with all checks', async () => {
    const agentId = 'e2e-pipe-agent';
    const taskId = 'e2e-pipe-task-003';

    // 超 token 限制
    const policyCheck = gov.policy.validate(
      { estimatedTokens: 5000, riskLevel: 'critical', requiredTrustScore: 80 },
      { score: 40, consecutiveFailures: 0, cooldownUntil: 0 },
      { hourlySpent: 0.10, hourlyLimit: 0.50 },
      1, 10,
    );

    expect(policyCheck.allowed).toBe(false);
    // 应该有多个违规: token_limit + trust_threshold + critical_path_trust
    expect(policyCheck.violations.length).toBeGreaterThanOrEqual(2);

    // 审计记录违规
    await gov.audit.logPolicyCheck(
      taskId,
      agentId,
      false,
      policyCheck.violations.map(v => ({ ruleId: v.ruleId, ruleName: v.ruleName })),
    );

    const auditEntries = await gov.audit.getByTask(taskId);
    expect(auditEntries.some(e => e.eventType === 'task_rejected')).toBe(true);
  });

  it('should track evolution and detect strategy changes', async () => {
    // 记录一些任务结果
    for (let i = 0; i < 12; i++) {
      await gov.evolution.recordOutcome({
        taskId: `e2e-evo-${i}`,
        agentId: 'e2e-pipe-agent',
        success: i < 9, // 75% 成功率
        qualityScore: i < 9 ? 80 : 20,
        touchedFiles: [`src/module-${i % 4}.ts`],
        approach: `approach-${i % 3}`,
        timestamp: Date.now(),
      });
    }

    const state = await gov.evolution.getState();
    expect(state.recentSuccessRate).toBeGreaterThan(0);
    expect(state.diversityIndex).toBeGreaterThan(0);
    expect(state.capsuleCount).toBeGreaterThanOrEqual(0);
  });

  it('should produce consistent budget summary', async () => {
    const summary = await gov.cost.getSummary();
    expect(summary).toHaveProperty('hourlyUsage');
    expect(summary).toHaveProperty('tier');
    expect(summary).toHaveProperty('canAccept');
    expect(typeof summary.hourlyUsage).toBe('number');
  });

  it('should produce consistent audit summary', async () => {
    const summary = await gov.audit.getSummary();
    expect(summary).toHaveProperty('total');
    expect(summary).toHaveProperty('violations');
    expect(summary).toHaveProperty('recentHour');
    expect(summary.total).toBeGreaterThanOrEqual(0);
  });
});
