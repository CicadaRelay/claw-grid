//! Audit Log — 写缓冲, 100ms/50条 批量 flush
//!
//! 当前每条审计 = 1 xAdd。Rust 版 buffer 50 条或 100ms 周期 flush。

use fred::prelude::*;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, error};

const AUDIT_STREAM: &str = "fsc:governance:audit";
const FLUSH_INTERVAL_MS: u64 = 100;
const MAX_BUFFER_SIZE: usize = 50;

pub struct AuditEntry {
    pub event_type: String,
    pub agent_id: Option<String>,
    pub task_id: Option<String>,
    pub decision: Option<String>,
    pub trust_before: Option<f64>,
    pub trust_after: Option<f64>,
    pub details: String,
}

pub struct AuditLog {
    redis: Arc<RedisClient>,
    buffer: Arc<Mutex<Vec<AuditEntry>>>,
}

impl AuditLog {
    pub fn new(redis: Arc<RedisClient>) -> Arc<Self> {
        let log = Arc::new(Self {
            redis,
            buffer: Arc::new(Mutex::new(Vec::with_capacity(MAX_BUFFER_SIZE))),
        });

        // 启动定时 flush 协程
        let log_clone = log.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(FLUSH_INTERVAL_MS)).await;
                log_clone.flush().await;
            }
        });

        log
    }

    /// 追加审计事件到缓冲
    pub async fn record(&self, entry: AuditEntry) {
        let mut buffer = self.buffer.lock().await;
        buffer.push(entry);

        // 缓冲满则立即 flush
        if buffer.len() >= MAX_BUFFER_SIZE {
            let entries: Vec<AuditEntry> = buffer.drain(..).collect();
            drop(buffer);
            self.flush_entries(entries).await;
        }
    }

    /// 获取审计日志总数
    pub async fn total_entries(&self) -> u64 {
        self.redis.xlen(AUDIT_STREAM).await.unwrap_or(0)
    }

    /// flush 当前缓冲
    async fn flush(&self) {
        let mut buffer = self.buffer.lock().await;
        if buffer.is_empty() {
            return;
        }
        let entries: Vec<AuditEntry> = buffer.drain(..).collect();
        drop(buffer);
        self.flush_entries(entries).await;
    }

    /// 批量写入 Redis Stream
    async fn flush_entries(&self, entries: Vec<AuditEntry>) {
        let pipeline = self.redis.pipeline();

        for entry in &entries {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
                .to_string();

            let mut fields: Vec<(&str, String)> = vec![
                ("timestamp", now),
                ("eventType", entry.event_type.clone()),
                ("details", entry.details.clone()),
            ];

            if let Some(ref id) = entry.agent_id {
                fields.push(("agentId", id.clone()));
            }
            if let Some(ref id) = entry.task_id {
                fields.push(("taskId", id.clone()));
            }
            if let Some(ref d) = entry.decision {
                fields.push(("decision", d.clone()));
            }
            if let Some(tb) = entry.trust_before {
                fields.push(("trustBefore", tb.to_string()));
            }
            if let Some(ta) = entry.trust_after {
                fields.push(("trustAfter", ta.to_string()));
            }

            let _: () = pipeline
                .xadd(AUDIT_STREAM, false, None, "*", fields)
                .await
                .unwrap_or_default();
        }

        match pipeline.all::<Vec<RedisValue>>().await {
            Ok(_) => debug!(count = entries.len(), "Audit entries flushed"),
            Err(e) => error!(?e, "Failed to flush audit entries"),
        }
    }
}
