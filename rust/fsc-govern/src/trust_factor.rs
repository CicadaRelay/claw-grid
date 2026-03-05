//! Trust Factor — 内存缓存 + write-behind 批量写
//!
//! DashMap 内存缓存 O(1) 读取，dirty set 100ms 批量 flush 到 Redis。
//! 1000 agent × ~200B/profile ≈ 200KB 缓存

use crate::cache::TtlCache;
use dashmap::DashSet;
use fred::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;
use tracing::{debug, error};

const TRUST_KEY_PREFIX: &str = "fsc:trust:";
const TRUST_LEADERBOARD: &str = "fsc:trust:leaderboard";
const DEFAULT_SCORE: f64 = 50.0;
const MAX_SCORE: f64 = 100.0;
const MIN_SCORE: f64 = 0.0;
const COOLDOWN_THRESHOLD: u32 = 3;
const COOLDOWN_DURATION_MS: u64 = 300_000;
const STREAK_BONUS_MULTIPLIER: f64 = 1.2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustProfile {
    pub agent_id: String,
    pub score: f64,
    pub success_count: u32,
    pub fail_count: u32,
    pub total_tasks: u32,
    pub avg_quality_score: f64,
    pub total_tokens_used: u64,
    pub total_cost_usd: f64,
    pub consecutive_successes: u32,
    pub consecutive_failures: u32,
    pub cooldown_until: u64,
    pub last_task_at: u64,
    pub created_at: u64,
}

impl Default for TrustProfile {
    fn default() -> Self {
        Self {
            agent_id: String::new(),
            score: DEFAULT_SCORE,
            success_count: 0,
            fail_count: 0,
            total_tasks: 0,
            avg_quality_score: 0.0,
            total_tokens_used: 0,
            total_cost_usd: 0.0,
            consecutive_successes: 0,
            consecutive_failures: 0,
            cooldown_until: 0,
            last_task_at: 0,
            created_at: 0,
        }
    }
}

pub struct TrustFactor {
    redis: Arc<RedisClient>,
    cache: TtlCache<TrustProfile>,
    dirty: DashSet<String>,
    flush_notify: Arc<Notify>,
}

impl TrustFactor {
    pub fn new(redis: Arc<RedisClient>) -> Arc<Self> {
        let tf = Arc::new(Self {
            redis,
            cache: TtlCache::new(Duration::from_secs(60)),
            dirty: DashSet::new(),
            flush_notify: Arc::new(Notify::new()),
        });

        // 启动 write-behind flush 协程 (100ms 周期)
        let tf_clone = tf.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                tf_clone.flush_dirty().await;
            }
        });

        tf
    }

    /// 获取 profile (内存优先, miss 从 Redis 加载)
    pub async fn get_profile(&self, agent_id: &str) -> TrustProfile {
        // 缓存命中
        if let Some(profile) = self.cache.get(agent_id) {
            return profile;
        }

        // 从 Redis 加载
        let key = format!("{}{}", TRUST_KEY_PREFIX, agent_id);
        let data: std::collections::HashMap<String, String> =
            self.redis.hgetall(&key).await.unwrap_or_default();

        if data.is_empty() || !data.contains_key("score") {
            let now = now_ms();
            let profile = TrustProfile {
                agent_id: agent_id.to_string(),
                created_at: now,
                ..Default::default()
            };
            self.cache.set(agent_id.to_string(), profile.clone());
            self.dirty.insert(agent_id.to_string());
            return profile;
        }

        let profile = TrustProfile {
            agent_id: agent_id.to_string(),
            score: parse_f64(&data, "score", DEFAULT_SCORE),
            success_count: parse_u32(&data, "successCount", 0),
            fail_count: parse_u32(&data, "failCount", 0),
            total_tasks: parse_u32(&data, "totalTasks", 0),
            avg_quality_score: parse_f64(&data, "avgQualityScore", 0.0),
            total_tokens_used: parse_u64(&data, "totalTokensUsed", 0),
            total_cost_usd: parse_f64(&data, "totalCostUSD", 0.0),
            consecutive_successes: parse_u32(&data, "consecutiveSuccesses", 0),
            consecutive_failures: parse_u32(&data, "consecutiveFailures", 0),
            cooldown_until: parse_u64(&data, "cooldownUntil", 0),
            last_task_at: parse_u64(&data, "lastTaskAt", 0),
            created_at: parse_u64(&data, "createdAt", 0),
        };

        self.cache.set(agent_id.to_string(), profile.clone());
        profile
    }

    /// 根据执行回执更新信誉 (内存计算, 异步批量写回)
    pub async fn update_from_receipt(
        &self,
        agent_id: &str,
        status: &str,
        quality_score: u32,
        tokens_used: u32,
        cost_usd: f64,
        failure_class: Option<&str>,
        violations: &[(String, u32)],
        _task_id: &str,
    ) -> (f64, f64) {
        let mut profile = self.get_profile(agent_id).await;
        let old_score = profile.score;
        let now = now_ms();

        profile.total_tasks += 1;
        profile.total_tokens_used += tokens_used as u64;
        profile.total_cost_usd += cost_usd;
        profile.last_task_at = now;

        if status == "success" {
            profile.success_count += 1;
            profile.consecutive_successes += 1;
            profile.consecutive_failures = 0;

            let mut reward: f64 = if quality_score >= 80 {
                5.0
            } else if quality_score >= 60 {
                3.0
            } else {
                2.0
            };

            if profile.consecutive_successes > 3 {
                reward = (reward * STREAK_BONUS_MULTIPLIER).round();
            }

            profile.score = (profile.score + reward).min(MAX_SCORE);

            if quality_score >= 90 {
                profile.score = (profile.score + 3.0).min(MAX_SCORE);
            }
        } else {
            profile.fail_count += 1;
            profile.consecutive_failures += 1;
            profile.consecutive_successes = 0;

            let penalty: f64 = match failure_class {
                Some("PERMANENT") => 10.0,
                Some("QUALITY") => 5.0,
                Some("RESOURCE") => 2.0,
                _ => 3.0,
            };

            profile.score = (profile.score - penalty).max(MIN_SCORE);

            if profile.consecutive_failures >= COOLDOWN_THRESHOLD {
                profile.cooldown_until = now + COOLDOWN_DURATION_MS;
            }
        }

        // 策略违规扣分
        for (_, penalty) in violations {
            profile.score = (profile.score - *penalty as f64).max(MIN_SCORE);
        }

        // 更新质量均值
        if quality_score > 0 && profile.total_tasks > 0 {
            let total_quality =
                profile.avg_quality_score * (profile.total_tasks - 1) as f64 + quality_score as f64;
            profile.avg_quality_score = total_quality / profile.total_tasks as f64;
        }

        let new_score = profile.score;
        let delta = new_score - old_score;

        // 写入缓存 + 标记 dirty
        self.cache.set(agent_id.to_string(), profile);
        self.dirty.insert(agent_id.to_string());

        (new_score, delta)
    }

    /// 获取缓存 agent 数量
    pub fn cached_count(&self) -> u64 {
        self.cache.len() as u64
    }

    /// 批量 flush dirty profiles 到 Redis
    async fn flush_dirty(&self) {
        let dirty_agents: Vec<String> = self.dirty.iter().map(|r| r.clone()).collect();
        if dirty_agents.is_empty() {
            return;
        }

        for agent_id in &dirty_agents {
            self.dirty.remove(agent_id);
        }

        let pipeline = self.redis.pipeline();
        for agent_id in &dirty_agents {
            if let Some(profile) = self.cache.get(agent_id) {
                let key = format!("{}{}", TRUST_KEY_PREFIX, agent_id);
                let fields: Vec<(String, String)> = vec![
                    ("agentId".into(), profile.agent_id.clone()),
                    ("score".into(), profile.score.to_string()),
                    ("successCount".into(), profile.success_count.to_string()),
                    ("failCount".into(), profile.fail_count.to_string()),
                    ("totalTasks".into(), profile.total_tasks.to_string()),
                    ("avgQualityScore".into(), profile.avg_quality_score.to_string()),
                    ("totalTokensUsed".into(), profile.total_tokens_used.to_string()),
                    ("totalCostUSD".into(), profile.total_cost_usd.to_string()),
                    (
                        "consecutiveSuccesses".into(),
                        profile.consecutive_successes.to_string(),
                    ),
                    (
                        "consecutiveFailures".into(),
                        profile.consecutive_failures.to_string(),
                    ),
                    ("cooldownUntil".into(), profile.cooldown_until.to_string()),
                    ("lastTaskAt".into(), profile.last_task_at.to_string()),
                    ("createdAt".into(), profile.created_at.to_string()),
                ];
                let _: () = pipeline.hset(&key, fields).await.unwrap_or_default();
                let _: () = pipeline
                    .zadd(
                        TRUST_LEADERBOARD,
                        None,
                        None,
                        false,
                        false,
                        (profile.score, agent_id.as_str()),
                    )
                    .await
                    .unwrap_or_default();
            }
        }

        match pipeline.all::<Vec<RedisValue>>().await {
            Ok(_) => debug!(count = dirty_agents.len(), "Trust profiles flushed"),
            Err(e) => error!(?e, "Failed to flush trust profiles"),
        }
    }
}

// ============ 工具函数 ============

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn parse_f64(data: &std::collections::HashMap<String, String>, key: &str, default: f64) -> f64 {
    data.get(key)
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(default)
}

fn parse_u32(data: &std::collections::HashMap<String, String>, key: &str, default: u32) -> u32 {
    data.get(key)
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(default)
}

fn parse_u64(data: &std::collections::HashMap<String, String>, key: &str, default: u64) -> u64 {
    data.get(key)
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default)
}
