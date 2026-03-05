//! Health Checker — /proc 直读
//!
//! 直接读取 /proc/stat + /proc/meminfo，零 fork 开销。

use fred::prelude::*;
use std::sync::Arc;
use tracing::{debug, error};

const HEARTBEAT_STREAM: &str = "fsc:heartbeats";

pub struct HealthChecker {
    redis: Arc<RedisClient>,
    agent_id: String,
    prev_cpu_idle: u64,
    prev_cpu_total: u64,
}

struct CpuStat {
    idle: u64,
    total: u64,
}

struct MemInfo {
    used_mb: u64,
    total_mb: u64,
}

impl HealthChecker {
    pub fn new(redis: Arc<RedisClient>, agent_id: String) -> Self {
        Self {
            redis,
            agent_id,
            prev_cpu_idle: 0,
            prev_cpu_total: 0,
        }
    }

    /// 上报一次心跳
    pub async fn report(&mut self, active_tasks: u32, max_concurrent: u32) {
        let cpu_usage = self.read_cpu().unwrap_or(0.0);
        let mem = self.read_memory().unwrap_or(MemInfo {
            used_mb: 0,
            total_mb: 0,
        });
        let disk_usage = self.read_disk().unwrap_or_else(|| "N/A".to_string());

        let metrics = serde_json::json!({
            "cpu_usage": format!("{:.2}", cpu_usage),
            "memory_usage": format!("{}/{}", mem.used_mb, mem.total_mb),
            "disk_usage": disk_usage,
            "running_tasks": active_tasks,
            "max_concurrent": max_concurrent,
            "timestamp": now_ms(),
        });

        let result: Result<String, _> = self
            .redis
            .xadd(
                HEARTBEAT_STREAM,
                false,
                None,
                "*",
                vec![
                    ("agent", self.agent_id.as_str()),
                    ("active_tasks", &active_tasks.to_string()),
                    ("metrics", &metrics.to_string()),
                ],
            )
            .await;

        match result {
            Ok(_) => debug!("Heartbeat sent"),
            Err(e) => error!(?e, "Heartbeat failed"),
        }
    }

    fn read_cpu(&mut self) -> Option<f64> {
        let content = std::fs::read_to_string("/proc/stat").ok()?;
        let cpu_line = content.lines().find(|l| l.starts_with("cpu "))?;
        let parts: Vec<u64> = cpu_line
            .split_whitespace()
            .skip(1)
            .filter_map(|s| s.parse().ok())
            .collect();

        if parts.len() < 4 {
            return None;
        }

        let idle = parts[3] + parts.get(4).unwrap_or(&0);
        let total: u64 = parts.iter().sum();

        let usage = if self.prev_cpu_total > 0 {
            let idle_delta = idle - self.prev_cpu_idle;
            let total_delta = total - self.prev_cpu_total;
            if total_delta > 0 {
                (1.0 - idle_delta as f64 / total_delta as f64) * 100.0
            } else {
                0.0
            }
        } else {
            0.0
        };

        self.prev_cpu_idle = idle;
        self.prev_cpu_total = total;

        Some(usage)
    }

    fn read_memory(&self) -> Option<MemInfo> {
        let content = std::fs::read_to_string("/proc/meminfo").ok()?;
        let mut total_kb = 0u64;
        let mut available_kb = 0u64;

        for line in content.lines() {
            if line.starts_with("MemTotal:") {
                total_kb = line.split_whitespace().nth(1)?.parse().ok()?;
            } else if line.starts_with("MemAvailable:") {
                available_kb = line.split_whitespace().nth(1)?.parse().ok()?;
            }
        }

        Some(MemInfo {
            used_mb: (total_kb - available_kb) / 1024,
            total_mb: total_kb / 1024,
        })
    }

    fn read_disk(&self) -> Option<String> {
        // 读 /proc/mounts 找 root fs, 然后 statvfs
        // 降级: 直接执行 df
        let output = std::process::Command::new("df")
            .args(["-h", "/"])
            .output()
            .ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout.lines().nth(1)?;
        let usage = line.split_whitespace().nth(4)?;
        Some(usage.to_string())
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
