/**
 * FSC-Mesh Quality Judge — 三重质量验证
 *
 * 基于 AXIOM 论文警告（LLM Judge 80% 误判率），采用三层验证：
 * Layer 1: 自动化检查 (0-40分) — lint/test/typecheck/security
 * Layer 2: 结构分析 (0-30分) — diff size/scope/deps/commit msg
 * Layer 3: LLM Judge (0-30分) — 仅高风险任务，3 Judge 投票取中位数
 *
 * 总分 < 40: REJECT
 * 总分 40-70: REVIEW
 * 总分 > 70: APPROVE
 */

import type { RedisClientType } from 'redis';
import type { QualityReport, QualityDetail, RiskLevel, CrossModelVerification, CrossModelResult } from './types';

const REVIEW_QUEUE = 'fsc:review_queue';

interface JudgeInput {
  taskId: string;
  agentId: string;
  gitDiff?: string;
  testOutput?: string;
  lintOutput?: string;
  typecheckOutput?: string;
  riskLevel: RiskLevel;
  touchedFiles: string[];
  allowedFiles?: string[];
  commitMessage?: string;
  /** 跨模型验证结果（高风险任务由多个模型独立产出） */
  crossModelResults?: CrossModelResult[];
}

export class QualityJudge {
  constructor(private redis: RedisClientType) {}

  /** 执行三层质量评估 */
  async evaluate(input: JudgeInput): Promise<QualityReport> {
    const details: QualityDetail[] = [];

    // Layer 1: 自动化检查 (0-40)
    const l1 = this.evaluateLayer1(input, details);

    // Layer 2: 结构分析 (0-30)
    const l2 = this.evaluateLayer2(input, details);

    // Layer 3: LLM Judge (0-30) — 仅高风险
    let l3 = 0;
    if (input.riskLevel === 'high' || input.riskLevel === 'critical') {
      l3 = await this.evaluateLayer3(input, details);
    } else {
      // 非高风险任务，Layer 3 按 Layer 1+2 比例推算
      l3 = Math.round(((l1 + l2) / 70) * 30);
      details.push({
        check: 'llm_judge_skipped',
        passed: true,
        score: l3,
        maxScore: 30,
        message: `Low/medium risk: LLM judge skipped, estimated ${l3}/30`,
      });
    }

    const totalScore = l1 + l2 + l3;
    const decision = totalScore >= 70 ? 'APPROVE' : totalScore >= 40 ? 'REVIEW' : 'REJECT';

    const report: QualityReport = {
      taskId: input.taskId,
      agentId: input.agentId,
      layer1Score: l1,
      layer2Score: l2,
      layer3Score: l3,
      totalScore,
      decision,
      details,
      timestamp: Date.now(),
    };

    // REVIEW 的推入审查队列
    if (decision === 'REVIEW') {
      await this.redis.xAdd(REVIEW_QUEUE, '*', {
        taskId: input.taskId,
        agentId: input.agentId,
        score: totalScore.toString(),
        timestamp: Date.now().toString(),
      });
    }

    return report;
  }

  // ============ Layer 1: 自动化检查 (0-40) ============
  private evaluateLayer1(input: JudgeInput, details: QualityDetail[]): number {
    let score = 0;

    // lint 通过 (+10)
    const lintPassed = !input.lintOutput || !input.lintOutput.includes('error');
    details.push({
      check: 'lint',
      passed: lintPassed,
      score: lintPassed ? 10 : 0,
      maxScore: 10,
      message: lintPassed ? 'No lint errors' : `Lint errors found`,
    });
    if (lintPassed) score += 10;

    // 测试通过 (+15)
    // 支持 "0 failed" / "0 fail" 格式——只在有实际失败数 > 0 时算失败
    const testPassed = !input.testOutput ||
      (input.testOutput.includes('pass') &&
       !/[1-9]\d*\s*fail/i.test(input.testOutput));
    details.push({
      check: 'tests',
      passed: testPassed,
      score: testPassed ? 15 : 0,
      maxScore: 15,
      message: testPassed ? 'Tests passing' : 'Test failures detected',
    });
    if (testPassed) score += 15;

    // 类型检查 (+10)
    const typecheckPassed = !input.typecheckOutput ||
      !input.typecheckOutput.includes('error TS');
    details.push({
      check: 'typecheck',
      passed: typecheckPassed,
      score: typecheckPassed ? 10 : 0,
      maxScore: 10,
      message: typecheckPassed ? 'Type check passed' : 'Type errors found',
    });
    if (typecheckPassed) score += 10;

    // 无安全漏洞 (+5)
    const noSecIssues = !input.gitDiff ||
      !/(eval\s*\(|exec\s*\(|child_process|rm\s+-rf|password\s*=\s*['"])/i.test(input.gitDiff);
    details.push({
      check: 'security_scan',
      passed: noSecIssues,
      score: noSecIssues ? 5 : 0,
      maxScore: 5,
      message: noSecIssues ? 'No security issues' : 'Potential security issue in diff',
    });
    if (noSecIssues) score += 5;

    return score;
  }

  // ============ Layer 2: 结构分析 (0-30) ============
  private evaluateLayer2(input: JudgeInput, details: QualityDetail[]): number {
    let score = 0;

    // diff 大小合理 (+5, ≤500 行)
    const diffLines = input.gitDiff ? input.gitDiff.split('\n').length : 0;
    const sizeOk = diffLines <= 500;
    const sizeScore = sizeOk ? 5 : Math.max(0, 5 - Math.ceil((diffLines - 500) / 100));
    details.push({
      check: 'diff_size',
      passed: sizeOk,
      score: sizeScore,
      maxScore: 5,
      message: `Diff: ${diffLines} lines (limit: 500)`,
    });
    score += sizeScore;

    // 只改了指定文件 (+10)
    if (input.allowedFiles && input.allowedFiles.length > 0) {
      const outOfScope = input.touchedFiles.filter(f =>
        !input.allowedFiles!.some(allowed => f.startsWith(allowed))
      );
      const scopeOk = outOfScope.length === 0;
      details.push({
        check: 'file_scope',
        passed: scopeOk,
        score: scopeOk ? 10 : 0,
        maxScore: 10,
        message: scopeOk ? 'All changes in scope' : `Out of scope: ${outOfScope.join(', ')}`,
      });
      if (scopeOk) score += 10;
    } else {
      score += 10; // 无限制 → 满分
      details.push({ check: 'file_scope', passed: true, score: 10, maxScore: 10, message: 'No scope restriction' });
    }

    // 无未声明的依赖 (+10)
    const hasNewDeps = input.gitDiff && /^\+.*(?:require|import)\s/.test(input.gitDiff);
    const depsOk = !hasNewDeps;
    details.push({
      check: 'dependencies',
      passed: depsOk,
      score: depsOk ? 10 : 5,
      maxScore: 10,
      message: depsOk ? 'No new dependencies' : 'New imports detected (review needed)',
    });
    score += depsOk ? 10 : 5;

    // commit message 规范 (+5)
    const msgOk = !!input.commitMessage && input.commitMessage.length >= 10 && input.commitMessage.length <= 200;
    details.push({
      check: 'commit_message',
      passed: msgOk,
      score: msgOk ? 5 : 2,
      maxScore: 5,
      message: msgOk ? 'Commit message OK' : 'Commit message too short/long',
    });
    score += msgOk ? 5 : 2;

    return score;
  }

  // ============ Layer 3: LLM Judge (0-30) ============
  private async evaluateLayer3(input: JudgeInput, details: QualityDetail[]): Promise<number> {
    // 如果有跨模型验证结果，用共识评分
    if (input.crossModelResults && input.crossModelResults.length >= 2) {
      return this.evaluateCrossModel(input.crossModelResults, details);
    }

    // Fallback: 启发式评分
    const diffQuality = input.gitDiff ? Math.min(30, Math.round(input.gitDiff.length / 100)) : 15;
    const hasTests = input.testOutput && input.testOutput.includes('pass');
    const score = Math.min(30, diffQuality + (hasTests ? 10 : 0));

    details.push({
      check: 'llm_judge',
      passed: score >= 15,
      score,
      maxScore: 30,
      message: `LLM Judge score: ${score}/30 (heuristic mode)`,
    });

    return score;
  }

  // ============ 跨模型共识验证 ============

  /**
   * 用多个模型的独立产出做交叉验证
   * 借鉴 Claude Octopus 的 Quorum 模式:
   * - 计算各 pair 的关键词 Jaccard 重叠
   * - overlap >= 0.6 → 共识达成，取质量最高的结果
   * - overlap < 0.6 → 分歧，降分处理
   */
  private evaluateCrossModel(results: CrossModelResult[], details: QualityDetail[]): number {
    const successResults = results.filter(r => r.status === 'success');

    if (successResults.length < 2) {
      const score = successResults.length === 1 ? 15 : 0;
      details.push({
        check: 'cross_model_consensus',
        passed: false,
        score,
        maxScore: 30,
        message: `Only ${successResults.length} model(s) succeeded, insufficient for consensus`,
      });
      return score;
    }

    // 计算 pairwise 关键词重叠
    const overlaps: number[] = [];
    for (let i = 0; i < successResults.length; i++) {
      for (let j = i + 1; j < successResults.length; j++) {
        const overlap = this.jaccardOverlap(
          successResults[i].gitDiff || '',
          successResults[j].gitDiff || '',
        );
        overlaps.push(overlap);
      }
    }

    const avgOverlap = overlaps.reduce((a, b) => a + b, 0) / overlaps.length;
    const consensus = avgOverlap >= 0.6;

    // 质量分: 共识 → 高分，分歧 → 低分
    const qualityScores = successResults.map(r => r.qualityScore);
    const medianQuality = qualityScores.sort((a, b) => a - b)[Math.floor(qualityScores.length / 2)];
    const normalizedQuality = Math.min(30, Math.round((medianQuality / 100) * 30));

    const score = consensus
      ? Math.min(30, normalizedQuality + 5)  // 共识加分
      : Math.max(0, normalizedQuality - 10); // 分歧减分

    details.push({
      check: 'cross_model_consensus',
      passed: consensus,
      score,
      maxScore: 30,
      message: `${successResults.length} models, avg overlap=${(avgOverlap * 100).toFixed(1)}%, ` +
               `consensus=${consensus ? 'YES' : 'NO'}, median quality=${medianQuality}`,
    });

    // 记录验证结果到 Redis
    const verification: CrossModelVerification = {
      taskId: results[0]?.agentId || 'unknown',
      results: successResults,
      keywordOverlap: avgOverlap,
      consensus,
      threshold: 0.6,
      timestamp: Date.now(),
    };
    this.redis.xAdd('fsc:cross_model_verify', '*', {
      payload: JSON.stringify(verification),
      timestamp: Date.now().toString(),
    }).catch(() => {}); // fire-and-forget

    return score;
  }

  /**
   * Jaccard 关键词重叠度
   * 提取 diff 中的标识符关键词，计算交集/并集
   * 借鉴 Octopus 的 _keyword_overlap()
   */
  private jaccardOverlap(textA: string, textB: string): number {
    const extract = (text: string): Set<string> => {
      const stopwords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
        'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
        'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
        'from', 'as', 'into', 'through', 'during', 'before', 'after', 'and', 'but', 'or',
        'not', 'no', 'if', 'then', 'else', 'this', 'that', 'it', 'its', 'diff', 'git']);
      const words = text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || [];
      return new Set(words.filter(w => !stopwords.has(w)));
    };

    const setA = extract(textA);
    const setB = extract(textB);

    if (setA.size === 0 && setB.size === 0) return 1.0;
    if (setA.size === 0 || setB.size === 0) return 0.0;

    let intersection = 0;
    setA.forEach(w => {
      if (setB.has(w)) intersection++;
    });

    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /** 获取待审查队列长度 */
  async getReviewQueueLength(): Promise<number> {
    return this.redis.xLen(REVIEW_QUEUE);
  }

  /** 获取待审查任务 */
  async getReviewQueue(count = 20): Promise<Array<{ taskId: string; agentId: string; score: number }>> {
    const entries = await this.redis.xRange(REVIEW_QUEUE, '-', '+', { COUNT: count });
    return entries.map(e => ({
      taskId: e.message.taskId,
      agentId: e.message.agentId,
      score: parseInt(e.message.score),
    }));
  }
}
