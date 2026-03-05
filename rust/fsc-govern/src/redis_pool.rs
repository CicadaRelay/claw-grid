//! Redis 连接池 + Lua 脚本管理
//!
//! 使用 fred crate 连接 Redis，预加载 Lua 脚本。

use fred::prelude::*;

use std::sync::Arc;
use tracing::info;

/// Lua 脚本: 原子化 recordCost (与 TypeScript 版 Lua 一致)
pub const RECORD_COST_LUA: &str = r#"
local key = KEYS[1]
local cost = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local hourMs = tonumber(ARGV[3])
local dayMs = tonumber(ARGV[4])
local defaultModel = ARGV[5]

local lastHourly = tonumber(redis.call('HGET', key, 'lastResetHourly') or '0') or 0
local lastDaily = tonumber(redis.call('HGET', key, 'lastResetDaily') or '0') or 0

if now - lastHourly >= hourMs then
  redis.call('HSET', key, 'hourlySpent', '0', 'lastResetHourly', tostring(now),
    'modelTier', 'standard', 'currentModel', defaultModel)
end

if now - lastDaily >= dayMs then
  redis.call('HSET', key, 'dailySpent', '0', 'lastResetDaily', tostring(now))
end

redis.call('HINCRBYFLOAT', key, 'hourlySpent', cost)
redis.call('HINCRBYFLOAT', key, 'dailySpent', cost)
redis.call('HINCRBYFLOAT', key, 'monthlySpent', cost)

return {
  redis.call('HGET', key, 'hourlySpent') or '0',
  redis.call('HGET', key, 'hourlyLimit') or '0.5',
  redis.call('HGET', key, 'dailySpent') or '0',
  redis.call('HGET', key, 'dailyLimit') or '10',
  redis.call('HGET', key, 'monthlySpent') or '0',
  redis.call('HGET', key, 'monthlyLimit') or '200',
  redis.call('HGET', key, 'modelTier') or 'standard',
  redis.call('HGET', key, 'currentModel') or defaultModel
}
"#;

/// Lua 脚本: 原子化 trust update (profile save + leaderboard update)
pub const TRUST_UPDATE_LUA: &str = r#"
local profileKey = KEYS[1]
local leaderboard = KEYS[2]
local agentId = ARGV[1]
local score = tonumber(ARGV[2])

-- 批量写入 profile fields (ARGV[3..] = field, value 交替)
local i = 3
while i <= #ARGV do
  redis.call('HSET', profileKey, ARGV[i], ARGV[i+1])
  i = i + 2
end

-- 更新排行榜
redis.call('ZADD', leaderboard, score, agentId)

return 1
"#;

pub struct RedisPool {
    pub client: Arc<RedisClient>,
    pub cost_script_hash: String,
    pub trust_script_hash: String,
}

impl RedisPool {
    pub async fn new(redis_url: &str) -> Result<Self, RedisError> {
        let config = RedisConfig::from_url(redis_url)?;
        let client = RedisClient::new(config, None, None, None);
        client.init().await?;

        info!("Redis connected");

        // 预加载 Lua 脚本
        let cost_script_hash: String = client.script_load(RECORD_COST_LUA).await?;
        let trust_script_hash: String = client.script_load(TRUST_UPDATE_LUA).await?;

        info!(cost_sha = %cost_script_hash, trust_sha = %trust_script_hash, "Lua scripts loaded");

        Ok(Self {
            client: Arc::new(client),
            cost_script_hash,
            trust_script_hash,
        })
    }
}
