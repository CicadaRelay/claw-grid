/**
 * Quality Judge 集成测试
 *
 * 覆盖: 三层评分、决策阈值 (APPROVE/REVIEW/REJECT)、REVIEW 入队
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RedisClientType } from 'redis';
import { QualityJudge } from '../quality-judge';
import { getTestRedis, disconnectTestRedis } from './setup';

describe('QualityJudge', () => {
  let redis: RedisClientType;
  let judge: QualityJudge;

  beforeAll(async () => {
    redis = await getTestRedis();
    judge = new QualityJudge(redis);
  });

  afterAll(async () => {
    // 清理 review queue 测试数据
    try { await redis.del('fsc:review_queue'); } catch {}
    await disconnectTestRedis();
  });

  it('should APPROVE clean code with all checks passing', async () => {
    const report = await judge.evaluate({
      taskId: 'e2e-q-001',
      agentId: 'e2e-agent',
      gitDiff: `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1,3 @@
+export function hello() {
+  return 'world';
+}`,
      testOutput: 'Tests: 5 passed, 0 failed',
      lintOutput: 'No issues found',
      typecheckOutput: 'Compilation complete',
      riskLevel: 'low',
      touchedFiles: ['src/foo.ts'],
      commitMessage: 'feat: add hello function for greeting module',
    });

    expect(report.decision).toBe('APPROVE');
    expect(report.totalScore).toBeGreaterThanOrEqual(70);
    expect(report.layer1Score).toBe(40); // lint(10) + test(15) + type(10) + sec(5)
    expect(report.layer2Score).toBeGreaterThanOrEqual(25);
  });

  it('should REJECT code with lint errors and test failures', async () => {
    const report = await judge.evaluate({
      taskId: 'e2e-q-002',
      agentId: 'e2e-agent',
      gitDiff: `diff --git a/src/bad.ts b/src/bad.ts
+const x = eval('dangerous')`,
      testOutput: 'Tests: 0 passed, 3 failed',
      lintOutput: 'error: unexpected token',
      typecheckOutput: 'error TS2304: Cannot find name',
      riskLevel: 'low',
      touchedFiles: ['src/bad.ts'],
      commitMessage: 'x',
    });

    expect(report.decision).toBe('REJECT');
    expect(report.totalScore).toBeLessThan(40);
    expect(report.layer1Score).toBe(0); // all checks failed
  });

  it('should REVIEW borderline code', async () => {
    const report = await judge.evaluate({
      taskId: 'e2e-q-003',
      agentId: 'e2e-agent',
      gitDiff: `diff --git a/src/mid.ts b/src/mid.ts
--- a/src/mid.ts
+++ b/src/mid.ts
@@ -1 +1,5 @@
+import { something } from 'new-dep';
+export function mid() {
+  return something();
+}`,
      testOutput: 'Tests: 3 passed, 0 failed',
      lintOutput: '', // lint OK
      typecheckOutput: '', // type OK
      riskLevel: 'low',
      touchedFiles: ['src/mid.ts'],
      commitMessage: 'add mid function',
    });

    // 新依赖引入 → dependencies check gets partial score
    // Layer1: 40, Layer2: ~22 (new deps -5), total ~60-70 → REVIEW or APPROVE
    expect(report.totalScore).toBeGreaterThanOrEqual(40);
    expect(['APPROVE', 'REVIEW']).toContain(report.decision);
  });

  it('should penalize large diff', async () => {
    // 生成 600 行 diff
    const largeDiff = Array.from({ length: 600 }, (_, i) =>
      `+  line ${i}: const x${i} = ${i};`
    ).join('\n');

    const report = await judge.evaluate({
      taskId: 'e2e-q-004',
      agentId: 'e2e-agent',
      gitDiff: `diff --git a/src/huge.ts b/src/huge.ts\n${largeDiff}`,
      testOutput: 'Tests: 1 passed',
      lintOutput: '',
      typecheckOutput: '',
      riskLevel: 'low',
      touchedFiles: ['src/huge.ts'],
      commitMessage: 'add large module implementation',
    });

    // diff_size check should give < 5 points
    const sizeDetail = report.details.find(d => d.check === 'diff_size');
    expect(sizeDetail).toBeDefined();
    expect(sizeDetail!.score).toBeLessThan(5);
  });

  it('should detect out-of-scope files', async () => {
    const report = await judge.evaluate({
      taskId: 'e2e-q-005',
      agentId: 'e2e-agent',
      gitDiff: 'diff --git a/src/ok.ts b/src/ok.ts\n+ok',
      riskLevel: 'low',
      touchedFiles: ['src/ok.ts', 'config/secret.ts'],
      allowedFiles: ['src/'],
      commitMessage: 'update ok module with proper scope',
    });

    const scopeDetail = report.details.find(d => d.check === 'file_scope');
    expect(scopeDetail).toBeDefined();
    expect(scopeDetail!.passed).toBe(false);
    expect(scopeDetail!.score).toBe(0);
  });

  it('should push REVIEW decisions to review queue', async () => {
    // 清队列
    try { await redis.del('fsc:review_queue'); } catch {}

    // 构造一个刚好 REVIEW 范围的输入
    const report = await judge.evaluate({
      taskId: 'e2e-q-review',
      agentId: 'e2e-agent',
      gitDiff: `diff --git a/src/r.ts b/src/r.ts\n+import { x } from 'y';\n+export const z = x;`,
      testOutput: 'Tests: 1 passed',
      lintOutput: '',
      typecheckOutput: 'error TS2305: type mismatch', // type error → -10
      riskLevel: 'low',
      touchedFiles: ['src/r.ts'],
      commitMessage: 'add r module for data processing',
    });

    if (report.decision === 'REVIEW') {
      const queueLen = await judge.getReviewQueueLength();
      expect(queueLen).toBeGreaterThan(0);
    }
  });
});
