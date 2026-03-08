/**
 * FSC-Mesh Governance Control Plane — Type Definitions
 *
 * 四层治理类型系统：宪法→仲裁→汇总→执行
 * 基于 GaaS (Trust Factor) + ECON (BNE) + RGD (三重质量)
 */

// ============ 风险级别 ============
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const RISK_TRUST_MAP: Record<RiskLevel, number> = {
  low: 20,
  medium: 40,
  high: 60,
  critical: 80,
};

// ============ 治理任务扩展 ============
export interface GovernedTask {
  id: string;
  title: string;
  description: string;
  priority: number;               // 1-5
  riskLevel: RiskLevel;
  estimatedTokens: number;
  estimatedCostUSD: number;
  dependsOn: string[];
  requiredTrustScore: number;
  maxRetries: number;
  slaDeadlineMs: number;
  assignedAgent?: string;
  createdAt: number;
}

// ============ 执行回执 ============
export interface ExecutionReceipt {
  taskId: string;
  agentId: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  tokensUsed: number;
  costUSD: number;
  status: 'success' | 'failure' | 'timeout' | 'rejected';
  qualityScore: number;           // 0-100
  policyViolations: PolicyViolation[];
  trustDelta: number;
  failureClass?: FailureClass;
  output?: string;
  error?: string;
}

// ============ 失败分类 ============
export type FailureClass =
  | 'RESOURCE'     // OOM/磁盘满 → 重试+升配
  | 'TRANSIENT'    // 网络/超时 → 指数退避重试
  | 'PERMANENT'    // 权限/配置 → 不重试
  | 'QUALITY'      // lint/test 失败 → 换 Agent 重试
  | 'UNKNOWN';     // 未知 → 标准重试 + causal.js

// ============ 策略规则 ============
export type PolicyLevel = 'constitutional' | 'operational';
export type Enforcement = 'hard' | 'soft';

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  level: PolicyLevel;
  condition: string;              // 安全沙箱执行的表达式
  enforcement: Enforcement;
  penalty: number;                // 信誉扣分
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PolicyViolation {
  ruleId: string;
  ruleName: string;
  enforcement: Enforcement;
  penalty: number;
  details: string;
  timestamp: number;
}

export interface PolicyCheckResult {
  allowed: boolean;
  violations: PolicyViolation[];
  warnings: PolicyViolation[];    // soft enforcement
}

// ============ 信誉系统 ============
export interface TrustProfile {
  agentId: string;
  score: number;                  // 0-100
  successCount: number;
  failCount: number;
  totalTasks: number;
  avgQualityScore: number;
  totalTokensUsed: number;
  totalCostUSD: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  cooldownUntil: number;          // 冷却期截止时间
  lastTaskAt: number;
  createdAt: number;
}

export interface TrustUpdate {
  type: 'reward' | 'penalty';
  amount: number;
  reason: string;
  taskId?: string;
}

// ============ 质量评估 ============
export interface QualityReport {
  taskId: string;
  agentId: string;
  layer1Score: number;            // 自动化检查 (0-40)
  layer2Score: number;            // 结构分析 (0-30)
  layer3Score: number;            // LLM Judge (0-30)
  totalScore: number;             // 0-100
  decision: 'APPROVE' | 'REVIEW' | 'REJECT';
  details: QualityDetail[];
  timestamp: number;
}

export interface QualityDetail {
  check: string;
  passed: boolean;
  score: number;
  maxScore: number;
  message?: string;
}

// ============ 仲裁 ============
export type VoteDecision = 'approve' | 'reject' | 'abstain';

export interface ArbitrationRequest {
  taskId: string;
  type: 'merge' | 'dispute' | 'policy_change';
  riskLevel: RiskLevel;
  requiredVotes: number;
  threshold: number;              // 通过比例 (0-1)
  deadline: number;               // 超时时间戳
  initiator: string;
}

export interface Vote {
  voterId: string;
  voterTrust: number;
  decision: VoteDecision;
  reason?: string;
  timestamp: number;
}

export interface ArbitrationResult {
  taskId: string;
  decision: 'approved' | 'rejected' | 'escalated';
  votes: Vote[];
  approvalRate: number;
  timestamp: number;
}

// ============ 成本控制 ============
export interface BudgetState {
  hourlySpent: number;
  dailySpent: number;
  monthlySpent: number;
  hourlyLimit: number;
  dailyLimit: number;
  monthlyLimit: number;
  currentModel: string;
  modelTier: 'premium' | 'standard' | 'economy' | 'free' | 'paused';
  lastResetHourly: number;
  lastResetDaily: number;
}

export const MODEL_TIERS: Record<string, { models: string[]; costPerToken: number }> = {
  premium:  { models: ['claude-sonnet-4'], costPerToken: 0.003 },
  standard: { models: ['doubao-seed-2.0-code'], costPerToken: 0.0003 },
  economy:  { models: ['minimax-2.5'], costPerToken: 0.0001 },
  free:     { models: ['openrouter/free'], costPerToken: 0 },
  paused:   { models: [], costPerToken: 0 },
};

// ============ 跨模型验证 ============
export interface CrossModelVerification {
  taskId: string;
  /** 每个模型独立产出的结果 */
  results: CrossModelResult[];
  /** 关键词重叠度 (Jaccard 系数, 0-1) */
  keywordOverlap: number;
  /** 是否达成共识 (overlap >= threshold) */
  consensus: boolean;
  /** 共识阈值 */
  threshold: number;
  timestamp: number;
}

export interface CrossModelResult {
  modelTier: string;          // 'claude' | 'codex' | 'gemini'
  agentId: string;
  gitDiff?: string;
  qualityScore: number;
  status: 'success' | 'failure' | 'timeout';
  durationMs: number;
}

// ============ 进化策略 ============
export type EvolutionStrategy = 'balanced' | 'innovate' | 'harden' | 'repair-only' | 'auto';

export interface EvolutionState {
  strategy: EvolutionStrategy;
  explorationRate: number;        // 0-1
  diversityIndex: number;         // Shannon diversity
  recentSuccessRate: number;      // 最近 100 任务
  capsuleCount: number;
  lastEvaluatedAt: number;
}

// ============ 审计日志 ============
export type AuditEventType =
  | 'task_validated'
  | 'task_rejected'
  | 'policy_violation'
  | 'trust_updated'
  | 'quality_checked'
  | 'vote_cast'
  | 'arbitration_decided'
  | 'budget_warning'
  | 'budget_exceeded'
  | 'model_downgraded'
  | 'agent_cooldown'
  | 'strategy_changed';

export interface AuditEntry {
  timestamp: number;
  eventType: AuditEventType;
  agentId?: string;
  taskId?: string;
  policyId?: string;
  decision?: string;
  trustBefore?: number;
  trustAfter?: number;
  details: Record<string, unknown>;
}
