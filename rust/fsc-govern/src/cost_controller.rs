//! Cost Controller — 原子 Lua 脚本 + 内存状态机
//!
//! 5 次 Redis round-trip → 1 次 Lua EVALSHA

use fred::prelude::*;

use std::sync::Arc;

const BUDGET_KEY: &str = "fsc:budget";
const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 86_400_000;

pub struct CostController {
    redis: Arc<RedisClient>,
    script_hash: String,
}

pub struct CostResult {
    pub tier: String,
    pub warning: bool,
    pub paused: bool,
    pub hourly_spent: f64,
    pub hourly_limit: f64,
}

impl CostController {
    pub fn new(redis: Arc<RedisClient>, script_hash: String) -> Self {
        Self { redis, script_hash }
    }

    /// 记录成本 — 单次 Lua EVALSHA
    pub async fn record_cost(&self, cost_usd: f64) -> Result<CostResult, RedisError> {
        let now = now_ms();
        let default_model = "doubao-seed-2.0-code";

        let result: Vec<String> = self
            .redis
            .evalsha(
                &self.script_hash,
                vec![BUDGET_KEY],
                vec![
                    cost_usd.to_string(),
                    now.to_string(),
                    HOUR_MS.to_string(),
                    DAY_MS.to_string(),
                    default_model.to_string(),
                ],
            )
            .await?;

        let hourly_spent: f64 = result.get(0).and_then(|v| v.parse().ok()).unwrap_or(0.0);
        let hourly_limit: f64 = result.get(1).and_then(|v| v.parse().ok()).unwrap_or(0.5);
        let ratio = if hourly_limit > 0.0 {
            hourly_spent / hourly_limit
        } else {
            0.0
        };

        let tier = if ratio >= 1.0 {
            "paused"
        } else if ratio >= 0.95 {
            "free"
        } else if ratio >= 0.8 {
            "economy"
        } else if ratio >= 0.5 {
            "standard"
        } else {
            "premium"
        };

        Ok(CostResult {
            tier: tier.to_string(),
            warning: ratio >= 0.8,
            paused: tier == "paused",
            hourly_spent,
            hourly_limit,
        })
    }

    /// 获取当前预算利用率
    pub async fn get_hourly_usage(&self) -> Result<u32, RedisError> {
        let data: std::collections::HashMap<String, String> =
            self.redis.hgetall(BUDGET_KEY).await?;
        let spent: f64 = data
            .get("hourlySpent")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.0);
        let limit: f64 = data
            .get("hourlyLimit")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.5);
        Ok(if limit > 0.0 {
            ((spent / limit) * 100.0).round() as u32
        } else {
            0
        })
    }

    /// 获取当前模型层级
    pub async fn get_tier(&self) -> Result<String, RedisError> {
        let tier: Option<String> = self.redis.hget(BUDGET_KEY, "modelTier").await?;
        Ok(tier.unwrap_or_else(|| "standard".to_string()))
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
