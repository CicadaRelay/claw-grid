//! HTTP API — 替代 Bun governance-api.ts (省 ~50MB Bun 运行时内存)
//!
//! 端点与 TypeScript 版完全兼容:
//! GET /health
//! GET /api/governance/trust
//! GET /api/governance/budget
//! GET /api/governance/audit
//! GET /api/governance/policies
//! GET /api/governance/quality
//! GET /api/governance/evolution
//! GET /api/governance/results
//! GET /api/governance/summary

use axum::{
    extract::{Query, State},
    http::{HeaderValue, Method},
    routing::get,
    Json, Router,
};
use fred::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tracing::{error, info};

use crate::redis_pool::RedisPool;

// ============ 查询参数 ============

#[derive(Deserialize)]
pub struct LimitParam {
    limit: Option<usize>,
}

#[derive(Deserialize)]
pub struct CountParam {
    count: Option<usize>,
}

// ============ 响应类型 ============

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    redis: bool,
    port: u16,
}

#[derive(Serialize)]
struct TrustEntry {
    #[serde(rename = "agentId")]
    agent_id: String,
    score: f64,
    #[serde(rename = "totalTasks")]
    total_tasks: u64,
    #[serde(rename = "successRate")]
    success_rate: f64,
    #[serde(rename = "avgQuality")]
    avg_quality: f64,
    cooldown: bool,
}

#[derive(Serialize)]
struct BudgetResponse {
    #[serde(rename = "hourlyUsage")]
    hourly_usage: u32,
    #[serde(rename = "dailyUsage")]
    daily_usage: u32,
    #[serde(rename = "monthlyUsage")]
    monthly_usage: u32,
    tier: String,
    model: String,
    #[serde(rename = "canAccept")]
    can_accept: bool,
    #[serde(rename = "hourlySpent")]
    hourly_spent: f64,
    #[serde(rename = "dailySpent")]
    daily_spent: f64,
    #[serde(rename = "monthlySpent")]
    monthly_spent: f64,
    #[serde(rename = "hourlyLimit")]
    hourly_limit: f64,
    #[serde(rename = "dailyLimit")]
    daily_limit: f64,
    #[serde(rename = "monthlyLimit")]
    monthly_limit: f64,
}

#[derive(Serialize)]
struct AuditEntry {
    id: String,
    timestamp: u64,
    #[serde(rename = "eventType")]
    event_type: String,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    #[serde(rename = "taskId")]
    task_id: Option<String>,
    decision: Option<String>,
    details: String,
}

#[derive(Serialize)]
struct PolicyEntry {
    id: String,
    name: String,
    level: String,
    enforcement: String,
    enabled: bool,
}

#[derive(Serialize)]
struct QualitySummary {
    total: u32,
    approved: u32,
    review: u32,
    rejected: u32,
    #[serde(rename = "avgScore")]
    avg_score: u32,
}

#[derive(Serialize)]
struct EvolutionState {
    strategy: String,
    #[serde(rename = "explorationRate")]
    exploration_rate: f64,
    #[serde(rename = "diversityIndex")]
    diversity_index: f64,
    #[serde(rename = "recentSuccessRate")]
    recent_success_rate: f64,
    #[serde(rename = "capsuleCount")]
    capsule_count: u32,
}

#[derive(Serialize)]
struct FullSummary {
    trust: Vec<TrustEntry>,
    budget: BudgetResponse,
    audit: Vec<AuditEntry>,
    policies: Vec<PolicyEntry>,
    quality: QualitySummary,
    evolution: EvolutionState,
}

// ============ 数据获取 ============

async fn get_trust_leaderboard(client: &RedisClient, limit: usize) -> Vec<TrustEntry> {
    // ZREVRANGE: 降序取 top N (score 最高的在前)
    let raw: RedisValue = client
        .zrevrange("fsc:trust:leaderboard", 0, (limit as i64) - 1, true)
        .await
        .unwrap_or(RedisValue::Null);

    // 解析 WITHSCORES 结果: [member, score, member, score, ...]
    let flat: Vec<RedisValue> = match raw {
        RedisValue::Array(v) => v,
        _ => vec![],
    };

    let mut results = Vec::new();
    let mut i = 0;
    while i + 1 < flat.len() {
        let agent_id = flat[i].as_str().unwrap_or_default().to_string();
        let score: f64 = flat[i + 1]
            .as_str()
            .and_then(|s| s.parse().ok())
            .or_else(|| flat[i + 1].as_f64())
            .unwrap_or(0.0);
        i += 2;
        let key = format!("fsc:trust:{}", agent_id);
        let profile: HashMap<String, String> = client.hgetall(&key).await.unwrap_or_default();

        let total_tasks: u64 = profile
            .get("totalTasks")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let success_count: u64 = profile
            .get("successCount")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let cooldown_until: u64 = profile
            .get("cooldownUntil")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        results.push(TrustEntry {
            agent_id,
            score,
            total_tasks,
            success_rate: if total_tasks > 0 {
                success_count as f64 / total_tasks as f64
            } else {
                0.0
            },
            avg_quality: profile
                .get("avgQualityScore")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.0),
            cooldown: cooldown_until > now_ms(),
        });
    }
    results
}

async fn get_budget(client: &RedisClient) -> BudgetResponse {
    let data: HashMap<String, String> = client.hgetall("fsc:budget").await.unwrap_or_default();

    if data.is_empty() || !data.contains_key("hourlyLimit") {
        return BudgetResponse {
            hourly_usage: 0,
            daily_usage: 0,
            monthly_usage: 0,
            tier: "standard".into(),
            model: "doubao-seed-2.0-code".into(),
            can_accept: true,
            hourly_spent: 0.0,
            daily_spent: 0.0,
            monthly_spent: 0.0,
            hourly_limit: 0.5,
            daily_limit: 10.0,
            monthly_limit: 200.0,
        };
    }

    let hourly_spent = parse_f64(&data, "hourlySpent", 0.0);
    let daily_spent = parse_f64(&data, "dailySpent", 0.0);
    let monthly_spent = parse_f64(&data, "monthlySpent", 0.0);
    let hourly_limit = parse_f64(&data, "hourlyLimit", 0.5);
    let daily_limit = parse_f64(&data, "dailyLimit", 10.0);
    let monthly_limit = parse_f64(&data, "monthlyLimit", 200.0);
    let tier = data
        .get("modelTier")
        .cloned()
        .unwrap_or_else(|| "standard".into());

    BudgetResponse {
        hourly_usage: pct(hourly_spent, hourly_limit),
        daily_usage: pct(daily_spent, daily_limit),
        monthly_usage: pct(monthly_spent, monthly_limit),
        can_accept: tier != "paused",
        model: data
            .get("currentModel")
            .cloned()
            .unwrap_or_else(|| "doubao-seed-2.0-code".into()),
        tier,
        hourly_spent,
        daily_spent,
        monthly_spent,
        hourly_limit,
        daily_limit,
        monthly_limit,
    }
}

async fn get_audit_log(client: &RedisClient, count: usize) -> Vec<AuditEntry> {
    let raw: RedisValue = client
        .xrevrange("fsc:governance:audit", "+", "-", Some(count as u64))
        .await
        .unwrap_or(RedisValue::Null);

    parse_stream_entries(raw)
}

async fn get_policies(client: &RedisClient) -> Vec<PolicyEntry> {
    let mut policies = vec![
        PolicyEntry {
            id: "CONST_001".into(),
            name: "token_limit".into(),
            level: "constitutional".into(),
            enforcement: "hard".into(),
            enabled: true,
        },
        PolicyEntry {
            id: "CONST_002".into(),
            name: "hourly_cost_limit".into(),
            level: "constitutional".into(),
            enforcement: "hard".into(),
            enabled: true,
        },
        PolicyEntry {
            id: "CONST_003".into(),
            name: "trust_threshold".into(),
            level: "constitutional".into(),
            enforcement: "hard".into(),
            enabled: true,
        },
        PolicyEntry {
            id: "CONST_004".into(),
            name: "node_capacity".into(),
            level: "constitutional".into(),
            enforcement: "hard".into(),
            enabled: true,
        },
        PolicyEntry {
            id: "CONST_005".into(),
            name: "critical_path_trust".into(),
            level: "constitutional".into(),
            enforcement: "hard".into(),
            enabled: true,
        },
        PolicyEntry {
            id: "OPS_001".into(),
            name: "consecutive_failure_cooldown".into(),
            level: "operational".into(),
            enforcement: "soft".into(),
            enabled: true,
        },
        PolicyEntry {
            id: "OPS_002".into(),
            name: "agent_cooldown_check".into(),
            level: "operational".into(),
            enforcement: "hard".into(),
            enabled: true,
        },
    ];

    // Redis 自定义规则
    if let Ok(stored) = client
        .hgetall::<HashMap<String, String>, _>("fsc:policies")
        .await
    {
        for (id, json) in stored {
            if let Ok(rule) = serde_json::from_str::<serde_json::Value>(&json) {
                let entry = PolicyEntry {
                    id: rule["id"]
                        .as_str()
                        .unwrap_or(&id)
                        .to_string(),
                    name: rule["name"]
                        .as_str()
                        .unwrap_or(&id)
                        .to_string(),
                    level: rule["level"]
                        .as_str()
                        .unwrap_or("operational")
                        .to_string(),
                    enforcement: rule["enforcement"]
                        .as_str()
                        .unwrap_or("soft")
                        .to_string(),
                    enabled: rule["enabled"].as_bool().unwrap_or(true),
                };
                if let Some(pos) = policies.iter().position(|p| p.id == entry.id) {
                    policies[pos] = entry;
                } else {
                    policies.push(entry);
                }
            }
        }
    }

    policies
}

async fn get_quality_summary(client: &RedisClient) -> QualitySummary {
    let raw: RedisValue = client
        .xrevrange("fsc:governance:audit", "+", "-", Some(500))
        .await
        .unwrap_or(RedisValue::Null);

    let entries = parse_stream_entries(raw);
    let quality_events: Vec<&AuditEntry> = entries
        .iter()
        .filter(|e| e.event_type == "quality_checked")
        .collect();

    let mut approved = 0u32;
    let mut review = 0u32;
    let mut rejected = 0u32;
    let mut total_score = 0u32;

    for e in &quality_events {
        if let Ok(details) = serde_json::from_str::<serde_json::Value>(&e.details) {
            total_score += details["score"].as_u64().unwrap_or(0) as u32;
        }
        match e.decision.as_deref() {
            Some("APPROVE") => approved += 1,
            Some("REVIEW") => review += 1,
            Some("REJECT") => rejected += 1,
            _ => {}
        }
    }

    let total = quality_events.len() as u32;
    QualitySummary {
        total,
        approved,
        review,
        rejected,
        avg_score: if total > 0 {
            total_score / total
        } else {
            0
        },
    }
}

async fn get_evolution(client: &RedisClient) -> EvolutionState {
    let data: HashMap<String, String> = client.hgetall("fsc:evolution").await.unwrap_or_default();
    EvolutionState {
        strategy: data
            .get("strategy")
            .cloned()
            .unwrap_or_else(|| "balanced".into()),
        exploration_rate: parse_f64(&data, "explorationRate", 0.30),
        diversity_index: parse_f64(&data, "diversityIndex", 1.0),
        recent_success_rate: parse_f64(&data, "recentSuccessRate", 0.5),
        capsule_count: data
            .get("capsuleCount")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
    }
}

// ============ Stream 解析 ============

fn parse_stream_entries(raw: RedisValue) -> Vec<AuditEntry> {
    let mut entries = Vec::new();

    // XREVRANGE 返回: [[id, [field, value, ...]], ...]
    if let RedisValue::Array(arr) = raw {
        for item in arr {
            if let RedisValue::Array(pair) = item {
                if pair.len() < 2 {
                    continue;
                }
                let id = pair[0].as_str().unwrap_or_default().to_string();
                let mut fields: HashMap<String, String> = HashMap::new();

                if let RedisValue::Array(ref fv) = pair[1] {
                    let mut i = 0;
                    while i + 1 < fv.len() {
                        let k = fv[i].as_str().unwrap_or_default().to_string();
                        let v = fv[i + 1].as_str().unwrap_or_default().to_string();
                        fields.insert(k, v);
                        i += 2;
                    }
                }

                entries.push(AuditEntry {
                    id,
                    timestamp: fields
                        .get("timestamp")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0),
                    event_type: fields
                        .get("eventType")
                        .cloned()
                        .unwrap_or_else(|| "unknown".into()),
                    agent_id: fields.get("agentId").cloned(),
                    task_id: fields.get("taskId").cloned(),
                    decision: fields.get("decision").cloned(),
                    details: fields
                        .get("details")
                        .cloned()
                        .unwrap_or_else(|| "{}".into()),
                });
            }
        }
    }

    entries
}

// ============ 路由 Handlers ============

async fn health_handler(State(state): State<Arc<HttpState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: if state.pool.client.is_connected() {
            "ok"
        } else {
            "degraded"
        },
        redis: state.pool.client.is_connected(),
        port: state.port,
    })
}

async fn trust_handler(
    State(state): State<Arc<HttpState>>,
    Query(params): Query<LimitParam>,
) -> Json<Vec<TrustEntry>> {
    let limit = params.limit.unwrap_or(20);
    Json(get_trust_leaderboard(&state.pool.client, limit).await)
}

async fn budget_handler(State(state): State<Arc<HttpState>>) -> Json<BudgetResponse> {
    Json(get_budget(&state.pool.client).await)
}

async fn audit_handler(
    State(state): State<Arc<HttpState>>,
    Query(params): Query<CountParam>,
) -> Json<Vec<AuditEntry>> {
    let count = params.count.unwrap_or(50);
    Json(get_audit_log(&state.pool.client, count).await)
}

async fn policies_handler(State(state): State<Arc<HttpState>>) -> Json<Vec<PolicyEntry>> {
    Json(get_policies(&state.pool.client).await)
}

async fn quality_handler(State(state): State<Arc<HttpState>>) -> Json<QualitySummary> {
    Json(get_quality_summary(&state.pool.client).await)
}

async fn evolution_handler(State(state): State<Arc<HttpState>>) -> Json<EvolutionState> {
    Json(get_evolution(&state.pool.client).await)
}

async fn results_handler(
    State(state): State<Arc<HttpState>>,
    Query(params): Query<CountParam>,
) -> Json<Vec<serde_json::Value>> {
    let count = params.count.unwrap_or(20);
    let raw: RedisValue = state
        .pool
        .client
        .xrevrange("fsc:results", "+", "-", Some(count as u64))
        .await
        .unwrap_or(RedisValue::Null);

    let mut results = Vec::new();
    if let RedisValue::Array(arr) = raw {
        for item in arr {
            if let RedisValue::Array(pair) = item {
                if pair.len() < 2 {
                    continue;
                }
                let id = pair[0].as_str().unwrap_or_default().to_string();
                let mut fields: HashMap<String, String> = HashMap::new();

                if let RedisValue::Array(ref fv) = pair[1] {
                    let mut i = 0;
                    while i + 1 < fv.len() {
                        let k = fv[i].as_str().unwrap_or_default().to_string();
                        let v = fv[i + 1].as_str().unwrap_or_default().to_string();
                        fields.insert(k, v);
                        i += 2;
                    }
                }

                // msgpack 双格式解码
                let decoded = if fields.get("encoding").map(|s| s.as_str()) == Some("msgpack") {
                    if let Some(payload) = fields.get("payload") {
                        use base64::Engine;
                        let bytes = base64::engine::general_purpose::STANDARD
                            .decode(payload)
                            .unwrap_or_default();
                        let val: serde_json::Value =
                            rmp_serde::from_slice(&bytes).unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                        let mut map = match val {
                            serde_json::Value::Object(m) => m,
                            _ => serde_json::Map::new(),
                        };
                        map.insert("id".into(), serde_json::Value::String(id));
                        serde_json::Value::Object(map)
                    } else {
                        let mut map = serde_json::Map::new();
                        map.insert("id".into(), serde_json::Value::String(id));
                        serde_json::Value::Object(map)
                    }
                } else {
                    let mut map = serde_json::Map::new();
                    map.insert("id".into(), serde_json::Value::String(id));
                    for (k, v) in &fields {
                        map.insert(k.clone(), serde_json::Value::String(v.clone()));
                    }
                    serde_json::Value::Object(map)
                };

                results.push(decoded);
            }
        }
    }
    Json(results)
}

async fn summary_handler(State(state): State<Arc<HttpState>>) -> Json<FullSummary> {
    let client = &state.pool.client;
    let (trust, budget, audit, policies, quality, evolution) = tokio::join!(
        get_trust_leaderboard(client, 20),
        get_budget(client),
        get_audit_log(client, 100),
        get_policies(client),
        get_quality_summary(client),
        get_evolution(client),
    );
    Json(FullSummary {
        trust,
        budget,
        audit,
        policies,
        quality,
        evolution,
    })
}

// ============ 工具函数 ============

fn parse_f64(data: &HashMap<String, String>, key: &str, default: f64) -> f64 {
    data.get(key)
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn pct(spent: f64, limit: f64) -> u32 {
    if limit > 0.0 {
        ((spent / limit) * 100.0).round() as u32
    } else {
        0
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

// ============ HTTP Server ============

pub struct HttpState {
    pub pool: RedisPool,
    pub port: u16,
}

pub async fn start_http_server(pool: RedisPool, port: u16) {
    let state = Arc::new(HttpState { pool, port });

    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE, Method::OPTIONS])
        .allow_headers(tower_http::cors::Any);

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/api/governance/summary", get(summary_handler))
        .route("/api/governance/trust", get(trust_handler))
        .route("/api/governance/budget", get(budget_handler))
        .route("/api/governance/audit", get(audit_handler))
        .route("/api/governance/policies", get(policies_handler))
        .route("/api/governance/quality", get(quality_handler))
        .route("/api/governance/evolution", get(evolution_handler))
        .route("/api/governance/results", get(results_handler))
        .layer(cors)
        .with_state(state);

    let addr = format!("0.0.0.0:{}", port);
    info!(port, "HTTP API listening");

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
