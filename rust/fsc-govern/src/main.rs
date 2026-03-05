//! FSC-Govern — Rust 治理引擎 Sidecar
//!
//! Unix socket 服务器 (/tmp/fsc-govern.sock)
//! MessagePack 编码的请求/响应
//! 进程隔离 — crash 不传播到 Bun 主进程

mod audit_log;
mod cache;
mod cost_controller;
mod http_api;
mod policy_engine;
mod protocol;
mod quality_judge;
mod redis_pool;
mod trust_factor;

use audit_log::{AuditEntry, AuditLog};
use cost_controller::CostController;
use policy_engine::PolicyEngine;
use protocol::{
    HealthData, RecordResultData, Request, Response, ResponseData, SummaryData,
};
use redis_pool::RedisPool;
use trust_factor::TrustFactor;

use fred::interfaces::ClientLike;

use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tracing::{error, info, warn};

const DEFAULT_SOCKET_PATH: &str = "/tmp/fsc-govern.sock";
const DEFAULT_REDIS_URL: &str = "redis://:fsc-mesh-2026@10.10.0.1:6379";
const DEFAULT_HTTP_PORT: u16 = 3004;

struct AppState {
    policy: PolicyEngine,
    trust: Arc<TrustFactor>,
    cost: CostController,
    audit: Arc<AuditLog>,
    start_time: Instant,
    redis_pool: RedisPool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 初始化 tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "fsc_govern=info".into()),
        )
        .init();

    // 解析参数
    let redis_url = std::env::args()
        .skip_while(|a| a != "--redis")
        .nth(1)
        .unwrap_or_else(|| DEFAULT_REDIS_URL.to_string());

    let socket_path = std::env::args()
        .skip_while(|a| a != "--socket")
        .nth(1)
        .unwrap_or_else(|| DEFAULT_SOCKET_PATH.to_string());

    let http_port: u16 = std::env::args()
        .skip_while(|a| a != "--port")
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_HTTP_PORT);

    info!(redis = %redis_url, socket = %socket_path, http_port, "Starting fsc-govern sidecar");

    // 连接 Redis
    let pool = RedisPool::new(&redis_url).await?;

    // 初始化组件
    let policy = PolicyEngine::new();
    let trust = TrustFactor::new(pool.client.clone());
    let cost = CostController::new(pool.client.clone(), pool.cost_script_hash.clone());
    let audit = AuditLog::new(pool.client.clone());

    let state = Arc::new(AppState {
        policy,
        trust,
        cost,
        audit,
        start_time: Instant::now(),
        redis_pool: pool,
    });

    // 启动 HTTP API (替代 Bun governance-api.ts, 省 ~50MB)
    let http_pool = RedisPool::new(&redis_url).await?;
    tokio::spawn(http_api::start_http_server(http_pool, http_port));

    // 清理旧 socket
    let _ = std::fs::remove_file(&socket_path);

    // 启动 Unix socket 服务器
    let listener = UnixListener::bind(&socket_path)?;
    info!(path = %socket_path, "Unix socket listening");

    // 设置 socket 权限
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o666))?;
    }

    // 优雅关闭
    let socket_path_clone = socket_path.clone();
    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        info!("Shutting down...");
        let _ = std::fs::remove_file(&socket_path_clone);
        std::process::exit(0);
    });

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let state = state.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(stream, state).await {
                        error!(?e, "Connection handler error");
                    }
                });
            }
            Err(e) => error!(?e, "Accept error"),
        }
    }
}

async fn handle_connection(
    mut stream: tokio::net::UnixStream,
    state: Arc<AppState>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut len_buf = [0u8; 4];

    loop {
        // 读取消息长度 (4 bytes big-endian)
        match stream.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e.into()),
        }

        let msg_len = u32::from_be_bytes(len_buf) as usize;
        if msg_len > 1_048_576 {
            // 1MB 上限
            warn!(msg_len, "Message too large, closing connection");
            break;
        }

        // 读取消息体
        let mut msg_buf = vec![0u8; msg_len];
        stream.read_exact(&mut msg_buf).await?;

        // 解码 MessagePack 请求
        let response = match rmp_serde::from_slice::<Request>(&msg_buf) {
            Ok(req) => handle_request(req, &state).await,
            Err(e) => Response::Error {
                message: format!("Decode error: {}", e),
            },
        };

        // 编码响应
        let resp_bytes = rmp_serde::to_vec_named(&response)?;
        let resp_len = (resp_bytes.len() as u32).to_be_bytes();
        stream.write_all(&resp_len).await?;
        stream.write_all(&resp_bytes).await?;
    }

    Ok(())
}

async fn handle_request(req: Request, state: &AppState) -> Response {
    match req {
        Request::ValidateTask {
            task,
            agent,
            budget,
            active_tasks,
            max_concurrent,
        } => {
            let result = state.policy.validate(
                &task,
                &agent,
                &budget,
                active_tasks,
                max_concurrent,
            );
            Response::Ok {
                data: ResponseData::Validation(result),
            }
        }

        Request::RecordResult { receipt } => {
            // Trust 更新
            let violations: Vec<(String, u32)> = receipt
                .policy_violations
                .iter()
                .map(|v| (v.rule_id.clone(), v.penalty))
                .collect();

            let (new_score, delta) = state
                .trust
                .update_from_receipt(
                    &receipt.agent_id,
                    &receipt.status,
                    receipt.quality_score,
                    receipt.tokens_used,
                    receipt.cost_usd,
                    receipt.failure_class.as_deref(),
                    &violations,
                    &receipt.task_id,
                )
                .await;

            // Cost 更新
            let cost_result = state.cost.record_cost(receipt.cost_usd).await;
            let (tier, warning, paused) = match cost_result {
                Ok(r) => (r.tier, r.warning, r.paused),
                Err(_) => ("standard".to_string(), false, false),
            };

            // Audit 记录
            state
                .audit
                .record(AuditEntry {
                    event_type: if receipt.status == "success" {
                        "task_validated".to_string()
                    } else {
                        "task_rejected".to_string()
                    },
                    agent_id: Some(receipt.agent_id.clone()),
                    task_id: Some(receipt.task_id.clone()),
                    decision: Some(receipt.status.clone()),
                    trust_before: Some(new_score - delta),
                    trust_after: Some(new_score),
                    details: serde_json::json!({
                        "duration_ms": receipt.duration_ms,
                        "tokens_used": receipt.tokens_used,
                        "cost_usd": receipt.cost_usd,
                    })
                    .to_string(),
                })
                .await;

            Response::Ok {
                data: ResponseData::RecordResult(RecordResultData {
                    trust_delta: delta,
                    new_trust_score: new_score,
                    budget_tier: tier,
                    budget_warning: warning,
                    budget_paused: paused,
                }),
            }
        }

        Request::GetSummary => {
            let hourly_usage = state.cost.get_hourly_usage().await.unwrap_or(0);
            let tier = state.cost.get_tier().await.unwrap_or_default();
            let audit_total = state.audit.total_entries().await;

            Response::Ok {
                data: ResponseData::Summary(SummaryData {
                    trust_total: state.trust.cached_count(),
                    trust_avg_score: 0.0, // 需要从 Redis 读取
                    trust_in_cooldown: 0,
                    budget_hourly_usage: hourly_usage,
                    budget_tier: tier,
                    audit_total,
                }),
            }
        }

        Request::Health => {
            let uptime = state.start_time.elapsed().as_secs();
            Response::Ok {
                data: ResponseData::Health(HealthData {
                    uptime_secs: uptime,
                    cached_agents: state.trust.cached_count(),
                    redis_connected: state.redis_pool.client.is_connected(),
                }),
            }
        }
    }
}
