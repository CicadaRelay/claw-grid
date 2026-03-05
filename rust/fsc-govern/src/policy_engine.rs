//! 编译式策略引擎 — 7 条规则 enum dispatch
//!
//! 替代 TypeScript 的 `new Function()` 动态求值
//! 7 条规则从 7-35ms → <1μs

use crate::protocol::{AgentInput, BudgetInput, TaskInput, ValidationResult, ViolationOutput};

/// 编译后的规则 — 启动时从配置构建
pub enum CompiledRule {
    /// CONST_001: task.estimatedTokens <= 4000
    TokenLimit { max: u32 },
    /// CONST_002: budget.hourlySpent <= budget.hourlyLimit
    HourlyCostLimit,
    /// CONST_003: agent.score >= task.requiredTrustScore
    TrustThreshold,
    /// CONST_004: context.activeTasks < context.maxConcurrent
    NodeCapacity,
    /// CONST_005: task.riskLevel != 'critical' || agent.score >= 80
    CriticalPathTrust { min_score: u32 },
    /// OPS_001: agent.consecutiveFailures < 3
    ConsecutiveFailureCooldown { threshold: u32 },
    /// OPS_002: agent.cooldownUntil <= now
    AgentCooldownCheck,
}

struct RuleMeta {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    enforcement: &'static str,
    penalty: u32,
    rule: CompiledRule,
}

/// 编译式策略引擎
pub struct PolicyEngine {
    rules: Vec<RuleMeta>,
}

impl PolicyEngine {
    pub fn new() -> Self {
        let rules = vec![
            RuleMeta {
                id: "CONST_001",
                name: "token_limit",
                description: "单任务 token 不超过 4000",
                enforcement: "hard",
                penalty: 10,
                rule: CompiledRule::TokenLimit { max: 4000 },
            },
            RuleMeta {
                id: "CONST_002",
                name: "hourly_cost_limit",
                description: "小时成本不超过 $0.50",
                enforcement: "hard",
                penalty: 0,
                rule: CompiledRule::HourlyCostLimit,
            },
            RuleMeta {
                id: "CONST_003",
                name: "trust_threshold",
                description: "Agent 信誉 >= 任务要求",
                enforcement: "hard",
                penalty: 5,
                rule: CompiledRule::TrustThreshold,
            },
            RuleMeta {
                id: "CONST_004",
                name: "node_capacity",
                description: "并发任务 <= 节点容量",
                enforcement: "hard",
                penalty: 0,
                rule: CompiledRule::NodeCapacity,
            },
            RuleMeta {
                id: "CONST_005",
                name: "critical_path_trust",
                description: "关键路径需高信誉 Agent",
                enforcement: "hard",
                penalty: 15,
                rule: CompiledRule::CriticalPathTrust { min_score: 80 },
            },
            RuleMeta {
                id: "OPS_001",
                name: "consecutive_failure_cooldown",
                description: "连续失败 3 次需冷却",
                enforcement: "soft",
                penalty: 0,
                rule: CompiledRule::ConsecutiveFailureCooldown { threshold: 3 },
            },
            RuleMeta {
                id: "OPS_002",
                name: "agent_cooldown_check",
                description: "Agent 冷却期内禁止接任务",
                enforcement: "hard",
                penalty: 0,
                rule: CompiledRule::AgentCooldownCheck,
            },
        ];

        Self { rules }
    }

    /// 校验任务是否符合所有策略规则
    pub fn validate(
        &self,
        task: &TaskInput,
        agent: &AgentInput,
        budget: &BudgetInput,
        active_tasks: u32,
        max_concurrent: u32,
    ) -> ValidationResult {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let mut violations = Vec::new();
        let mut warnings = Vec::new();

        for meta in &self.rules {
            let passed = match &meta.rule {
                CompiledRule::TokenLimit { max } => task.estimated_tokens <= *max,
                CompiledRule::HourlyCostLimit => budget.hourly_spent <= budget.hourly_limit,
                CompiledRule::TrustThreshold => agent.score >= task.required_trust_score as f64,
                CompiledRule::NodeCapacity => active_tasks < max_concurrent,
                CompiledRule::CriticalPathTrust { min_score } => {
                    task.risk_level != "critical" || agent.score >= *min_score as f64
                }
                CompiledRule::ConsecutiveFailureCooldown { threshold } => {
                    agent.consecutive_failures < *threshold
                }
                CompiledRule::AgentCooldownCheck => agent.cooldown_until <= now,
            };

            if !passed {
                let violation = ViolationOutput {
                    rule_id: meta.id.to_string(),
                    rule_name: meta.name.to_string(),
                    enforcement: meta.enforcement.to_string(),
                    penalty: meta.penalty,
                    details: format!("Rule \"{}\" violated: {}", meta.name, meta.description),
                };

                if meta.enforcement == "hard" {
                    violations.push(violation);
                } else {
                    warnings.push(violation);
                }
            }
        }

        ValidationResult {
            allowed: violations.is_empty(),
            violations,
            warnings,
        }
    }
}
