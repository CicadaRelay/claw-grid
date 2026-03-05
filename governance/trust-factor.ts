/**
 * FSC-Mesh Trust Factor — Agent 信誉系统
 *
 * 基于 GaaS 论文的 Trust Factor:
 * - 成功率 ×40 + 质量 ×30 - 违规 ×20 - 成本 ×10
 * - 连续成功/失败加速奖惩
 * - 冷却期（连续失败 3 次 → 300s 禁止接任务）
 *
 * Redis 存储: HSET fsc:trust:{agentId}
 */

import { createClient, type RedisClientType } from 'redis';
import type {
  TrustProfile,
  TrustUpdate,
  ExecutionReceipt,
  RiskLevel,
  RISK_TRUST_MAP,
  AuditEntry,
} from './types';

const TRUST_KEY_PREFIX = 'fsc:trust:';
const TRUST_LEADERBOARD = 'fsc:trust:leaderboard';
const DEFAULT_SCORE = 50;
const MIN_SCORE = 0;
const MAX_SCORE = 100;
const COOLDOWN_THRESHOLD = 3;   // 连续失败 3 次触发冷却
const COOLDOWN_DURATION_MS = 300_000; // 5 分钟
const STREAK_BONUS_MULTIPLIER = 1.2;

export class TrustFactor {
  constructor(private redis: RedisClientType) {}

  // ============ 核心方法 ============

  /** 获取 Agent 信誉档案 */
  async getProfile(agentId: string): Promise<TrustProfile> {
    const key = TRUST_KEY_PREFIX + agentId;
    const data = await this.redis.hGetAll(key);

    if (!data || !data.score) {
      // 新 Agent，初始化
      const profile: TrustProfile = {
        agentId,
        score: DEFAULT_SCORE,
        successCount: 0,
        failCount: 0,
        totalTasks: 0,
        avgQualityScore: 0,
        totalTokensUsed: 0,
        totalCostUSD: 0,
        consecutiveSuccesses: 0,
        consecutiveFailures: 0,
        cooldownUntil: 0,
        lastTaskAt: 0,
        createdAt: Date.now(),
      };
      await this.saveProfile(profile);
      return profile;
    }

    return {
      agentId,
      score: parseFloat(data.score),
      successCount: parseInt(data.successCount || '0'),
      failCount: parseInt(data.failCount || '0'),
      totalTasks: parseInt(data.totalTasks || '0'),
      avgQualityScore: parseFloat(data.avgQualityScore || '0'),
      totalTokensUsed: parseInt(data.totalTokensUsed || '0'),
      totalCostUSD: parseFloat(data.totalCostUSD || '0'),
      consecutiveSuccesses: parseInt(data.consecutiveSuccesses || '0'),
      consecutiveFailures: parseInt(data.consecutiveFailures || '0'),
      cooldownUntil: parseInt(data.cooldownUntil || '0'),
      lastTaskAt: parseInt(data.lastTaskAt || '0'),
      createdAt: parseInt(data.createdAt || '0'),
    };
  }

  /** 获取实时信誉分 */
  async getScore(agentId: string): Promise<number> {
    const score = await this.redis.hGet(TRUST_KEY_PREFIX + agentId, 'score');
    return score ? parseFloat(score) : DEFAULT_SCORE;
  }

  /** Agent 是否在冷却期 */
  async isInCooldown(agentId: string): Promise<boolean> {
    const until = await this.redis.hGet(TRUST_KEY_PREFIX + agentId, 'cooldownUntil');
    return until ? parseInt(until) > Date.now() : false;
  }

  /** 根据执行回执更新信誉 */
  async updateFromReceipt(receipt: ExecutionReceipt): Promise<TrustUpdate[]> {
    const profile = await this.getProfile(receipt.agentId);
    const updates: TrustUpdate[] = [];
    const now = Date.now();

    // 更新基础统计
    profile.totalTasks++;
    profile.totalTokensUsed += receipt.tokensUsed;
    profile.totalCostUSD += receipt.costUSD;
    profile.lastTaskAt = now;

    if (receipt.status === 'success') {
      profile.successCount++;
      profile.consecutiveSuccesses++;
      profile.consecutiveFailures = 0;

      // 基础奖励 (按风险级别)
      let reward = 2;
      if (receipt.qualityScore >= 80) reward = 5;
      else if (receipt.qualityScore >= 60) reward = 3;

      // 连续成功加速
      if (profile.consecutiveSuccesses > 3) {
        reward = Math.round(reward * STREAK_BONUS_MULTIPLIER);
      }

      profile.score = Math.min(MAX_SCORE, profile.score + reward);
      updates.push({ type: 'reward', amount: reward, reason: 'task_success', taskId: receipt.taskId });

      // 质量优秀额外奖励
      if (receipt.qualityScore >= 90) {
        profile.score = Math.min(MAX_SCORE, profile.score + 3);
        updates.push({ type: 'reward', amount: 3, reason: 'quality_excellent', taskId: receipt.taskId });
      }
    } else {
      profile.failCount++;
      profile.consecutiveFailures++;
      profile.consecutiveSuccesses = 0;

      // 惩罚 (按失败类型)
      let penalty = 3;
      if (receipt.failureClass === 'PERMANENT') penalty = 10;
      else if (receipt.failureClass === 'QUALITY') penalty = 5;
      else if (receipt.failureClass === 'RESOURCE') penalty = 2; // 资源问题惩罚轻

      profile.score = Math.max(MIN_SCORE, profile.score - penalty);
      updates.push({ type: 'penalty', amount: penalty, reason: `task_failure:${receipt.failureClass || 'unknown'}`, taskId: receipt.taskId });

      // 连续失败 → 冷却
      if (profile.consecutiveFailures >= COOLDOWN_THRESHOLD) {
        profile.cooldownUntil = now + COOLDOWN_DURATION_MS;
        updates.push({ type: 'penalty', amount: 0, reason: 'cooldown_triggered' });
      }
    }

    // 策略违规扣分
    for (const violation of receipt.policyViolations) {
      profile.score = Math.max(MIN_SCORE, profile.score - violation.penalty);
      updates.push({ type: 'penalty', amount: violation.penalty, reason: `violation:${violation.ruleId}`, taskId: receipt.taskId });
    }

    // 更新质量均值
    if (receipt.qualityScore > 0) {
      const totalQuality = profile.avgQualityScore * (profile.totalTasks - 1) + receipt.qualityScore;
      profile.avgQualityScore = totalQuality / profile.totalTasks;
    }

    // saveProfile + zAdd 合并为 1 次 multi (2 round-trips → 1)
    const key = TRUST_KEY_PREFIX + profile.agentId;
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(profile)) {
      data[k] = String(v);
    }
    await this.redis.multi()
      .hSet(key, data)
      .zAdd(TRUST_LEADERBOARD, { score: profile.score, value: receipt.agentId })
      .exec();

    return updates;
  }

  /** 手动调整信誉（纪委熔断） */
  async manualAdjust(agentId: string, update: TrustUpdate): Promise<void> {
    const profile = await this.getProfile(agentId);
    if (update.type === 'reward') {
      profile.score = Math.min(MAX_SCORE, profile.score + update.amount);
    } else {
      profile.score = Math.max(MIN_SCORE, profile.score - update.amount);
    }
    // saveProfile + zAdd 合并为 multi
    const key = TRUST_KEY_PREFIX + profile.agentId;
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(profile)) {
      data[k] = String(v);
    }
    await this.redis.multi()
      .hSet(key, data)
      .zAdd(TRUST_LEADERBOARD, { score: profile.score, value: agentId })
      .exec();
  }

  /** 强制冷却（降权） */
  async demote(agentId: string, durationMs: number, reason: string): Promise<void> {
    const key = TRUST_KEY_PREFIX + agentId;
    await this.redis.hSet(key, 'cooldownUntil', (Date.now() + durationMs).toString());
  }

  // ============ 查询方法 ============

  /** 信誉排行 Top N */
  async getTopAgents(n: number): Promise<Array<{ agentId: string; score: number }>> {
    const results = await this.redis.zRangeWithScores(TRUST_LEADERBOARD, -n, -1);
    return results.reverse().map(r => ({ agentId: r.value, score: r.score }));
  }

  /** 为任务选择最优 Agent（信誉 >= requiredTrust，不在冷却期） */
  async bestAgentsFor(requiredTrust: number, limit = 5): Promise<string[]> {
    const candidates = await this.redis.zRangeByScoreWithScores(
      TRUST_LEADERBOARD,
      requiredTrust,
      MAX_SCORE,
    );

    if (candidates.length === 0) return [];

    // Pipeline 批量查询 cooldownUntil (O(N) round-trips → 1)
    const reversed = candidates.reverse();
    const pipeline = this.redis.multi();
    for (const c of reversed) {
      pipeline.hGet(TRUST_KEY_PREFIX + c.value, 'cooldownUntil');
    }
    const cooldowns = await pipeline.exec() as unknown as (string | null)[];

    const now = Date.now();
    const eligible: string[] = [];
    for (let i = 0; i < reversed.length && eligible.length < limit; i++) {
      const cd = cooldowns[i];
      if (!cd || parseInt(cd) <= now) {
        eligible.push(reversed[i].value);
      }
    }

    return eligible;
  }

  /** 获取所有 Agent 的信誉统计摘要 */
  async getSummary(): Promise<{
    total: number;
    avgScore: number;
    inCooldown: number;
    topAgent: string | null;
  }> {
    const total = await this.redis.zCard(TRUST_LEADERBOARD);
    if (total === 0) return { total: 0, avgScore: 0, inCooldown: 0, topAgent: null };

    const all = await this.redis.zRangeWithScores(TRUST_LEADERBOARD, 0, -1);
    const avgScore = all.reduce((sum, r) => sum + r.score, 0) / all.length;
    const topAgent = all.length > 0 ? all[all.length - 1].value : null;

    // Pipeline 批量查询 cooldownUntil (O(N) round-trips → 1)
    const pipeline = this.redis.multi();
    for (const a of all) {
      pipeline.hGet(TRUST_KEY_PREFIX + a.value, 'cooldownUntil');
    }
    const cooldowns = await pipeline.exec() as unknown as (string | null)[];

    const now = Date.now();
    let inCooldown = 0;
    for (const cd of cooldowns) {
      if (cd && parseInt(cd) > now) inCooldown++;
    }

    return { total, avgScore: Math.round(avgScore * 100) / 100, inCooldown, topAgent };
  }

  // ============ 内部方法 ============

  private async saveProfile(profile: TrustProfile): Promise<void> {
    const key = TRUST_KEY_PREFIX + profile.agentId;
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(profile)) {
      data[k] = String(v);
    }
    await this.redis.hSet(key, data);
  }
}
