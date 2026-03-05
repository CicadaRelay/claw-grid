//! Task Consumer — XREADGROUP + backpressure
//!
//! 从 Redis Stream 消费任务，tokio semaphore 控制并发。

use fred::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Semaphore;
use tracing::{error, info, warn};

const STREAM_KEY: &str = "fsc:tasks";
const CONSUMER_GROUP: &str = "fsc-workers";
const RESULT_STREAM: &str = "fsc:results";
const DLQ_STREAM: &str = "fsc:dlq";

#[derive(Debug, Deserialize)]
pub struct Task {
    pub id: String,
    pub image: String,
    pub commands: Vec<String>,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    pub risk_level: Option<String>,
    pub estimated_tokens: Option<u32>,
}

fn default_timeout() -> u64 {
    300
}

#[derive(Debug, Serialize)]
pub struct TaskResult {
    pub task_id: String,
    pub agent_id: String,
    pub status: String,
    pub output: String,
    pub error: String,
    pub failure_class: String,
    pub duration_ms: u64,
    pub timestamp: u64,
}

pub struct TaskConsumer {
    redis: Arc<RedisClient>,
    consumer_name: String,
    agent_id: String,
    semaphore: Arc<Semaphore>,
    max_concurrent: usize,
}

impl TaskConsumer {
    pub fn new(
        redis: Arc<RedisClient>,
        consumer_name: String,
        agent_id: String,
        max_concurrent: usize,
    ) -> Self {
        Self {
            redis,
            consumer_name,
            agent_id,
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
            max_concurrent,
        }
    }

    /// 初始化 consumer group
    pub async fn init(&self) -> Result<(), RedisError> {
        match self
            .redis
            .xgroup_create(STREAM_KEY, CONSUMER_GROUP, "$", true)
            .await
        {
            Ok(()) => info!("Consumer group created: {}", CONSUMER_GROUP),
            Err(e) if e.to_string().contains("BUSYGROUP") => {
                info!("Consumer group already exists: {}", CONSUMER_GROUP)
            }
            Err(e) => return Err(e),
        }
        Ok(())
    }

    /// 主消费循环
    pub async fn run(&self, docker_manager: Arc<super::docker_manager::DockerManager>) {
        info!(
            consumer = %self.consumer_name,
            max_concurrent = self.max_concurrent,
            "Task consumer started"
        );

        loop {
            // Backpressure: 等待可用 permit
            let permit = self.semaphore.clone().acquire_owned().await.unwrap();

            // XREADGROUP 阻塞读取
            let messages: Vec<(String, Vec<(String, std::collections::HashMap<String, String>)>)> =
                match self
                    .redis
                    .xreadgroup::<Vec<(String, Vec<(String, std::collections::HashMap<String, String>)>)>>(
                        CONSUMER_GROUP,
                        &self.consumer_name,
                        Some(1),
                        Some(5000),
                        false,
                        STREAM_KEY,
                        ">",
                    )
                    .await
                {
                    Ok(msgs) => msgs,
                    Err(e) => {
                        drop(permit);
                        error!(?e, "XREADGROUP error");
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        continue;
                    }
                };

            if messages.is_empty() {
                drop(permit);
                continue;
            }

            for (_stream, entries) in messages {
                for (message_id, fields) in entries {
                    let task_json = match fields.get("task") {
                        Some(t) => t.clone(),
                        None => {
                            warn!(message_id = %message_id, "Missing task field");
                            drop(permit);
                            continue;
                        }
                    };

                    let task: Task = match serde_json::from_str(&task_json) {
                        Ok(t) => t,
                        Err(e) => {
                            error!(?e, "Failed to parse task");
                            drop(permit);
                            continue;
                        }
                    };

                    info!(task_id = %task.id, "Task received");

                    // 分布式锁
                    let lock_key = format!("lock:task:{}", message_id);
                    let locked: Option<String> = self
                        .redis
                        .set(
                            &lock_key,
                            &self.consumer_name,
                            Some(Expiration::EX(300)),
                            Some(SetOptions::NX),
                            false,
                        )
                        .await
                        .unwrap_or(None);

                    if locked.is_none() {
                        warn!(task_id = %task.id, "Lock held by another worker");
                        let _: () = self
                            .redis
                            .xack(STREAM_KEY, CONSUMER_GROUP, &message_id)
                            .await
                            .unwrap_or_default();
                        drop(permit);
                        continue;
                    }

                    // 异步执行任务
                    let redis = self.redis.clone();
                    let agent_id = self.agent_id.clone();
                    let docker = docker_manager.clone();
                    let msg_id = message_id.clone();

                    tokio::spawn(async move {
                        let _permit = permit; // permit 在 task 完成后释放

                        let start = std::time::Instant::now();
                        let result = docker.execute_task(&task).await;
                        let duration_ms = start.elapsed().as_millis() as u64;

                        let task_result = TaskResult {
                            task_id: task.id.clone(),
                            agent_id: agent_id.clone(),
                            status: result.status.clone(),
                            output: result.output.clone(),
                            error: result.error.clone(),
                            failure_class: result.failure_class.clone(),
                            duration_ms,
                            timestamp: now_ms(),
                        };

                        // MessagePack 编码推送结果
                        let payload = rmp_serde::to_vec_named(&task_result).unwrap_or_default();
                        let encoded = base64_encode(&payload);

                        let _: () = redis
                            .xadd(
                                RESULT_STREAM,
                                false,
                                None,
                                "*",
                                vec![
                                    ("payload", encoded.as_str()),
                                    ("encoding", "msgpack"),
                                ],
                            )
                            .await
                            .unwrap_or_default();

                        // XACK
                        let _: () = redis
                            .xack(STREAM_KEY, CONSUMER_GROUP, &msg_id)
                            .await
                            .unwrap_or_default();

                        // 释放锁
                        let _: () = redis.del(&lock_key).await.unwrap_or_default();

                        info!(
                            task_id = %task.id,
                            status = %result.status,
                            duration_ms,
                            "Task completed"
                        );
                    });
                }
            }
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn base64_encode(data: &[u8]) -> String {
    use std::io::Write;
    let mut buf = Vec::with_capacity(data.len() * 4 / 3 + 4);
    // Simple base64 encoding
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut i = 0;
    while i + 2 < data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | (data[i + 2] as u32);
        buf.push(CHARS[((n >> 18) & 0x3f) as usize]);
        buf.push(CHARS[((n >> 12) & 0x3f) as usize]);
        buf.push(CHARS[((n >> 6) & 0x3f) as usize]);
        buf.push(CHARS[(n & 0x3f) as usize]);
        i += 3;
    }
    let remaining = data.len() - i;
    if remaining == 1 {
        let n = (data[i] as u32) << 16;
        buf.push(CHARS[((n >> 18) & 0x3f) as usize]);
        buf.push(CHARS[((n >> 12) & 0x3f) as usize]);
        buf.push(b'=');
        buf.push(b'=');
    } else if remaining == 2 {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
        buf.push(CHARS[((n >> 18) & 0x3f) as usize]);
        buf.push(CHARS[((n >> 12) & 0x3f) as usize]);
        buf.push(CHARS[((n >> 6) & 0x3f) as usize]);
        buf.push(b'=');
    }
    String::from_utf8(buf).unwrap()
}
