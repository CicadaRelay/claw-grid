//! FSC-Govern Protocol — MessagePack 请求/响应类型
//!
//! TypeScript thin client 通过 Unix socket 发送 MessagePack 编码的请求，
//! sidecar 处理后返回 MessagePack 响应。

use serde::{Deserialize, Serialize};

/// 请求消息
#[derive(Debug, Deserialize)]
#[serde(tag = "method")]
pub enum Request {
    /// 策略校验
    #[serde(rename = "validate_task")]
    ValidateTask {
        task: TaskInput,
        agent: AgentInput,
        budget: BudgetInput,
        active_tasks: u32,
        max_concurrent: u32,
    },
    /// 记录执行结果 (trust + cost + audit)
    #[serde(rename = "record_result")]
    RecordResult { receipt: ExecutionReceipt },
    /// 获取全量摘要
    #[serde(rename = "get_summary")]
    GetSummary,
    /// 健康检查
    #[serde(rename = "health")]
    Health,
}

/// 响应消息
#[derive(Debug, Serialize)]
#[serde(tag = "status")]
pub enum Response {
    #[serde(rename = "ok")]
    Ok { data: ResponseData },
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ResponseData {
    Validation(ValidationResult),
    RecordResult(RecordResultData),
    Summary(SummaryData),
    Health(HealthData),
}

// ============ 输入类型 ============

#[derive(Debug, Deserialize, Clone)]
pub struct TaskInput {
    pub id: String,
    pub risk_level: String,
    pub estimated_tokens: u32,
    pub required_trust_score: u32,
}

#[derive(Debug, Deserialize, Clone)]
pub struct AgentInput {
    pub agent_id: String,
    pub score: f64,
    pub consecutive_failures: u32,
    pub cooldown_until: u64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct BudgetInput {
    pub hourly_spent: f64,
    pub hourly_limit: f64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ExecutionReceipt {
    pub task_id: String,
    pub agent_id: String,
    pub duration_ms: u64,
    pub tokens_used: u32,
    pub cost_usd: f64,
    pub status: String,
    pub quality_score: u32,
    pub failure_class: Option<String>,
    pub policy_violations: Vec<ViolationInput>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ViolationInput {
    pub rule_id: String,
    pub penalty: u32,
}

// ============ 输出类型 ============

#[derive(Debug, Serialize)]
pub struct ValidationResult {
    pub allowed: bool,
    pub violations: Vec<ViolationOutput>,
    pub warnings: Vec<ViolationOutput>,
}

#[derive(Debug, Serialize)]
pub struct ViolationOutput {
    pub rule_id: String,
    pub rule_name: String,
    pub enforcement: String,
    pub penalty: u32,
    pub details: String,
}

#[derive(Debug, Serialize)]
pub struct RecordResultData {
    pub trust_delta: f64,
    pub new_trust_score: f64,
    pub budget_tier: String,
    pub budget_warning: bool,
    pub budget_paused: bool,
}

#[derive(Debug, Serialize)]
pub struct SummaryData {
    pub trust_total: u64,
    pub trust_avg_score: f64,
    pub trust_in_cooldown: u32,
    pub budget_hourly_usage: u32,
    pub budget_tier: String,
    pub audit_total: u64,
}

#[derive(Debug, Serialize)]
pub struct HealthData {
    pub uptime_secs: u64,
    pub cached_agents: u64,
    pub redis_connected: bool,
}
