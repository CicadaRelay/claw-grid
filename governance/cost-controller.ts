/**
 * FSC-Mesh Cost Controller — 成本控制层
 *
 * 预算追踪 + 模型自动降级:
 *   < 50%  → premium (claude-sonnet)
 *   50-80% → standard (doubao)
 *   80-95% → economy (minimax)
 *   95-100% → free (openrouter/nvidia 免费模型)
 *   > 100% → paused (硬停止)
 *
 * Redis: HSET fsc:budget
 * 每小时自动重置 hourlySpent
 */

import type { RedisClientType } from 'redis';
import type { BudgetState, AuditEntry } from './types';
import { MODEL_TIERS } from './types';

const BUDGET_KEY = 'fsc:budget';
const BUDGET_CHANNEL = 'fsc:budget:alert';
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const DEFAULT_LIMITS = {
  hourlyLimit: 0.50,   // $0.50/h (CLAUDE.md 硬约束)
  dailyLimit: 10.0,    // $10/day
  monthlyLimit: 200.0, // $200/month
};

/**
 * Lua 脚本: 原子化 recordCost
 * 合并 checkReset + 3×hIncrByFloat + getState 为 1 次调用
 * 返回: [hourlySpent, hourlyLimit, dailySpent, dailyLimit, monthlySpent, monthlyLimit, modelTier, currentModel]
 */
const RECORD_COST_LUA = `
local key = KEYS[1]
local cost = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local hourMs = tonumber(ARGV[3])
local dayMs = tonumber(ARGV[4])
local defaultModel = ARGV[5]

-- checkReset: 检查是否需要重置周期
local lastHourly = tonumber(redis.call('HGET', key, 'lastResetHourly') or '0') or 0
local lastDaily = tonumber(redis.call('HGET', key, 'lastResetDaily') or '0') or 0

if now - lastHourly >= hourMs then
  redis.call('HSET', key, 'hourlySpent', '0', 'lastResetHourly', tostring(now),
    'modelTier', 'standard', 'currentModel', defaultModel)
end

if now - lastDaily >= dayMs then
  redis.call('HSET', key, 'dailySpent', '0', 'lastResetDaily', tostring(now))
end

-- 累加成本 (3×hIncrByFloat 合并)
redis.call('HINCRBYFLOAT', key, 'hourlySpent', cost)
redis.call('HINCRBYFLOAT', key, 'dailySpent', cost)
redis.call('HINCRBYFLOAT', key, 'monthlySpent', cost)

-- 返回完整状态
return {
  redis.call('HGET', key, 'hourlySpent') or '0',
  redis.call('HGET', key, 'hourlyLimit') or '0.5',
  redis.call('HGET', key, 'dailySpent') or '0',
  redis.call('HGET', key, 'dailyLimit') or '10',
  redis.call('HGET', key, 'monthlySpent') or '0',
  redis.call('HGET', key, 'monthlyLimit') or '200',
  redis.call('HGET', key, 'modelTier') or 'standard',
  redis.call('HGET', key, 'currentModel') or defaultModel
}
`;

export class CostController {
  private luaSha: string | null = null;

  constructor(private redis: RedisClientType) {}

  /** 初始化预算（首次或重置） */
  async init(): Promise<void> {
    const exists = await this.redis.exists(BUDGET_KEY);
    if (!exists) {
      await this.redis.hSet(BUDGET_KEY, {
        hourlySpent: '0',
        dailySpent: '0',
        monthlySpent: '0',
        hourlyLimit: DEFAULT_LIMITS.hourlyLimit.toString(),
        dailyLimit: DEFAULT_LIMITS.dailyLimit.toString(),
        monthlyLimit: DEFAULT_LIMITS.monthlyLimit.toString(),
        currentModel: MODEL_TIERS.standard.models[0],
        modelTier: 'standard',
        lastResetHourly: Date.now().toString(),
        lastResetDaily: Date.now().toString(),
      });
    }

    // 预加载 Lua 脚本
    this.luaSha = await this.redis.scriptLoad(RECORD_COST_LUA);
  }

  /** 记录一次任务的成本 — 原子化 Lua 脚本 (5 round-trips → 1) */
  async recordCost(taskId: string, agentId: string, costUSD: number, tokensUsed: number): Promise<{
    tier: BudgetState['modelTier'];
    warning: boolean;
    paused: boolean;
  }> {
    const defaultModel = MODEL_TIERS.standard.models[0];
    const now = Date.now();

    // 原子化执行: checkReset + 累加 + 读取状态
    let result: string[];
    if (this.luaSha) {
      try {
        result = await this.redis.evalSha(this.luaSha, {
          keys: [BUDGET_KEY],
          arguments: [costUSD.toString(), now.toString(), HOUR_MS.toString(), DAY_MS.toString(), defaultModel],
        }) as string[];
      } catch {
        // SHA 丢失（Redis 重启），重新加载
        this.luaSha = await this.redis.scriptLoad(RECORD_COST_LUA);
        result = await this.redis.evalSha(this.luaSha, {
          keys: [BUDGET_KEY],
          arguments: [costUSD.toString(), now.toString(), HOUR_MS.toString(), DAY_MS.toString(), defaultModel],
        }) as string[];
      }
    } else {
      result = await this.redis.eval(RECORD_COST_LUA, {
        keys: [BUDGET_KEY],
        arguments: [costUSD.toString(), now.toString(), HOUR_MS.toString(), DAY_MS.toString(), defaultModel],
      }) as string[];
    }

    const hourlySpent = parseFloat(result[0] || '0');
    const hourlyLimit = parseFloat(result[1] || String(DEFAULT_LIMITS.hourlyLimit));
    const oldTier = (result[6] || 'standard') as BudgetState['modelTier'];
    const hourlyRatio = hourlySpent / hourlyLimit;

    // 决定模型层级
    let newTier: BudgetState['modelTier'];
    if (hourlyRatio >= 1.0) {
      newTier = 'paused';
    } else if (hourlyRatio >= 0.95) {
      newTier = 'free';
    } else if (hourlyRatio >= 0.8) {
      newTier = 'economy';
    } else if (hourlyRatio >= 0.5) {
      newTier = 'standard';
    } else {
      newTier = 'premium';
    }

    // 层级变化 → 更新 + 发布告警
    if (newTier !== oldTier) {
      const newModel = newTier === 'paused'
        ? 'none'
        : MODEL_TIERS[newTier].models[0];

      await this.redis.hSet(BUDGET_KEY, {
        modelTier: newTier,
        currentModel: newModel,
      });

      await this.redis.publish(BUDGET_CHANNEL, JSON.stringify({
        type: 'model_downgrade',
        from: oldTier,
        to: newTier,
        hourlySpent,
        hourlyLimit,
        timestamp: now,
      }));
    }

    const warning = hourlyRatio >= 0.8;
    const paused = newTier === 'paused';

    return { tier: newTier, warning, paused };
  }

  /** 获取当前预算状态 */
  async getState(): Promise<BudgetState> {
    const data = await this.redis.hGetAll(BUDGET_KEY);
    return {
      hourlySpent: parseFloat(data.hourlySpent || '0'),
      dailySpent: parseFloat(data.dailySpent || '0'),
      monthlySpent: parseFloat(data.monthlySpent || '0'),
      hourlyLimit: parseFloat(data.hourlyLimit || String(DEFAULT_LIMITS.hourlyLimit)),
      dailyLimit: parseFloat(data.dailyLimit || String(DEFAULT_LIMITS.dailyLimit)),
      monthlyLimit: parseFloat(data.monthlyLimit || String(DEFAULT_LIMITS.monthlyLimit)),
      currentModel: data.currentModel || MODEL_TIERS.standard.models[0],
      modelTier: (data.modelTier as BudgetState['modelTier']) || 'standard',
      lastResetHourly: parseInt(data.lastResetHourly || '0'),
      lastResetDaily: parseInt(data.lastResetDaily || '0'),
    };
  }

  /** 获取推荐模型（基于当前预算） */
  async getRecommendedModel(): Promise<string> {
    const state = await this.getState();
    if (state.modelTier === 'paused') return 'none';
    return MODEL_TIERS[state.modelTier].models[0];
  }

  /** 是否允许新任务（预算未用完） */
  async canAcceptTask(): Promise<boolean> {
    await this.checkReset();
    const state = await this.getState();
    return state.modelTier !== 'paused';
  }

  /** 估算一个任务的成本 */
  estimateCost(tokens: number, tier: BudgetState['modelTier']): number {
    if (tier === 'paused' || tier === 'free') return 0;
    return tokens * MODEL_TIERS[tier].costPerToken;
  }

  /** 更新限额 */
  async setLimits(limits: Partial<Pick<BudgetState, 'hourlyLimit' | 'dailyLimit' | 'monthlyLimit'>>): Promise<void> {
    const fields: Record<string, string> = {};
    if (limits.hourlyLimit !== undefined) fields.hourlyLimit = limits.hourlyLimit.toString();
    if (limits.dailyLimit !== undefined) fields.dailyLimit = limits.dailyLimit.toString();
    if (limits.monthlyLimit !== undefined) fields.monthlyLimit = limits.monthlyLimit.toString();
    if (Object.keys(fields).length > 0) {
      await this.redis.hSet(BUDGET_KEY, fields);
    }
  }

  /** 获取预算利用率摘要 */
  async getSummary(): Promise<{
    hourlyUsage: number;
    dailyUsage: number;
    monthlyUsage: number;
    tier: string;
    model: string;
    canAccept: boolean;
  }> {
    const state = await this.getState();
    return {
      hourlyUsage: Math.round((state.hourlySpent / state.hourlyLimit) * 100),
      dailyUsage: Math.round((state.dailySpent / state.dailyLimit) * 100),
      monthlyUsage: Math.round((state.monthlySpent / state.monthlyLimit) * 100),
      tier: state.modelTier,
      model: state.currentModel,
      canAccept: state.modelTier !== 'paused',
    };
  }

  /**
   * 任务级模型选择 — 根据任务风险+token量选最优 tier
   *
   * 策略:
   * - critical/high → 尽量 premium，预算不够则 standard
   * - medium → standard 优先
   * - low → 当前全局 tier
   * - 跨模型验证任务 → 强制 economy（省钱，多模型量取胜）
   */
  async getModelForTask(task: {
    riskLevel: string;
    estimatedTokens: number;
    crossModelVerify?: boolean;
  }): Promise<{ model: string; tier: BudgetState['modelTier']; estimatedCost: number }> {
    const state = await this.getState();

    if (state.modelTier === 'paused') {
      return { model: 'none', tier: 'paused', estimatedCost: 0 };
    }

    // 跨模型验证 → 用廉价模型（要跑多次）
    if (task.crossModelVerify) {
      const tier = 'economy' as const;
      return {
        model: MODEL_TIERS[tier].models[0],
        tier,
        estimatedCost: this.estimateCost(task.estimatedTokens, tier),
      };
    }

    // 高风险 → 尝试 premium
    if (task.riskLevel === 'critical' || task.riskLevel === 'high') {
      const premiumCost = this.estimateCost(task.estimatedTokens, 'premium');
      const headroom = state.hourlyLimit - state.hourlySpent;

      if (premiumCost <= headroom * 0.5) {
        // 还有足够预算（不超过剩余的 50%）→ premium
        return { model: MODEL_TIERS.premium.models[0], tier: 'premium', estimatedCost: premiumCost };
      }
      // 预算紧张 → standard
      const standardCost = this.estimateCost(task.estimatedTokens, 'standard');
      return { model: MODEL_TIERS.standard.models[0], tier: 'standard', estimatedCost: standardCost };
    }

    // medium → standard
    if (task.riskLevel === 'medium') {
      let tier: BudgetState['modelTier'] = state.modelTier === 'premium' ? 'standard' : state.modelTier;
      if (tier === 'paused') tier = 'economy';
      return {
        model: MODEL_TIERS[tier].models[0],
        tier,
        estimatedCost: this.estimateCost(task.estimatedTokens, tier),
      };
    }

    // low → 跟全局 tier
    return {
      model: state.currentModel,
      tier: state.modelTier,
      estimatedCost: this.estimateCost(task.estimatedTokens, state.modelTier),
    };
  }

  // ============ 内部方法 ============

  /** 检查并执行周期重置 */
  private async checkReset(): Promise<void> {
    const data = await this.redis.hGetAll(BUDGET_KEY);
    const now = Date.now();
    const lastHourly = parseInt(data.lastResetHourly || '0');
    const lastDaily = parseInt(data.lastResetDaily || '0');

    const fields: Record<string, string> = {};

    if (now - lastHourly >= HOUR_MS) {
      fields.hourlySpent = '0';
      fields.lastResetHourly = now.toString();
      // 重置后恢复模型层级
      fields.modelTier = 'standard';
      fields.currentModel = MODEL_TIERS.standard.models[0];
    }

    if (now - lastDaily >= DAY_MS) {
      fields.dailySpent = '0';
      fields.lastResetDaily = now.toString();
    }

    if (Object.keys(fields).length > 0) {
      await this.redis.hSet(BUDGET_KEY, fields);
    }
  }
}
