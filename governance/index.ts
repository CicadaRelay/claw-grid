/**
 * FSC-Mesh Governance Control Plane — 治理控制平面统一入口
 *
 * 四层治理: 宪法(PolicyEngine) → 仲裁(Arbitration) → 质量(QualityJudge) → 执行
 * 基础设施: TrustFactor(信誉) + CostController(成本) + AuditLog(审计) + Evolution(进化)
 */

export { PolicyEngine } from './policy-engine';
export { TrustFactor } from './trust-factor';
export { QualityJudge } from './quality-judge';
export { Arbitration } from './arbitration';
export { CostController } from './cost-controller';
export { AuditLog } from './audit-log';
export { Evolution } from './evolution';
export { StreamTrimmer } from './stream-trimmer';
export { GovernanceRustClient } from './rust-client';
export { decodeStreamMessage, encodeStreamMessage } from './stream-codec';

// 类型导出
export type {
  // 核心
  RiskLevel,
  GovernedTask,
  ExecutionReceipt,
  FailureClass,
  // 策略
  PolicyRule,
  PolicyLevel,
  Enforcement,
  PolicyViolation,
  PolicyCheckResult,
  // 信誉
  TrustProfile,
  TrustUpdate,
  // 质量
  QualityReport,
  QualityDetail,
  // 仲裁
  ArbitrationRequest,
  ArbitrationResult,
  Vote,
  VoteDecision,
  // 成本
  BudgetState,
  // 跨模型验证
  CrossModelVerification,
  CrossModelResult,
  // 进化
  EvolutionStrategy,
  EvolutionState,
  // 审计
  AuditEntry,
  AuditEventType,
} from './types';

export { RISK_TRUST_MAP, MODEL_TIERS } from './types';

// ============ 便捷工厂 ============

import type { RedisClientType } from 'redis';
import { PolicyEngine } from './policy-engine';
import { TrustFactor } from './trust-factor';
import { QualityJudge } from './quality-judge';
import { Arbitration } from './arbitration';
import { CostController } from './cost-controller';
import { AuditLog } from './audit-log';
import { Evolution } from './evolution';
import { GovernanceRustClient } from './rust-client';

export interface GovernanceLayer {
  policy: PolicyEngine;
  trust: TrustFactor;
  quality: QualityJudge;
  arbitration: Arbitration;
  cost: CostController;
  audit: AuditLog;
  evolution: Evolution;
  /** Rust sidecar client (可选, 可用时走高速路径) */
  rustClient?: GovernanceRustClient;
}

/** 一键初始化全部治理组件 (自动检测 Rust sidecar) */
export async function createGovernanceLayer(redis: RedisClientType): Promise<GovernanceLayer> {
  const trust = new TrustFactor(redis);
  const policy = new PolicyEngine(redis);
  const quality = new QualityJudge(redis);
  const arbitration = new Arbitration(redis, trust);
  const cost = new CostController(redis);
  const audit = new AuditLog(redis);
  const evolution = new Evolution(redis);

  // 初始化需要 Redis 读取的组件
  await Promise.all([
    policy.init(),
    cost.init(),
    evolution.init(),
  ]);

  // 尝试连接 Rust sidecar (失败则 fallback 到纯 TypeScript)
  let rustClient: GovernanceRustClient | undefined;
  try {
    if (await GovernanceRustClient.isAvailable()) {
      rustClient = new GovernanceRustClient();
      await rustClient.connect();
      console.log('[Governance] Rust sidecar connected — using high-speed path');
    }
  } catch {
    console.log('[Governance] Rust sidecar not available — using TypeScript path');
  }

  return { policy, trust, quality, arbitration, cost, audit, evolution, rustClient };
}

/** 关闭治理层（释放订阅 + Rust client） */
export async function shutdownGovernanceLayer(layer: GovernanceLayer): Promise<void> {
  await layer.policy.shutdown();
  layer.audit.shutdown();
  if (layer.rustClient) {
    layer.rustClient.disconnect();
  }
}
