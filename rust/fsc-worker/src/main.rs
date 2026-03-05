//! FSC-Worker — Rust Worker for EPYC nodes
//!
//! tokio work-stealing 线程池充分利用 EPYC 多核
//! 单 worker 并发 10 → 50+ tasks

mod docker_manager;
mod health_checker;
mod task_consumer;

use docker_manager::DockerManager;
use health_checker::HealthChecker;
use task_consumer::TaskConsumer;

use fred::prelude::*;
use std::sync::Arc;
use tracing::info;

const DEFAULT_REDIS_URL: &str = "redis://:fsc-mesh-2026@10.10.0.1:6379";
const DEFAULT_MAX_CONCURRENT: usize = 50;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "fsc_worker=info".into()),
        )
        .init();

    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| DEFAULT_REDIS_URL.to_string());
    let max_concurrent: usize = std::env::var("MAX_CONCURRENT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_CONCURRENT);
    let agent_id = std::env::var("AGENT_ID")
        .unwrap_or_else(|_| format!("rust-worker-{}", hostname()));

    info!(
        redis = %redis_url,
        max_concurrent,
        agent_id = %agent_id,
        "Starting FSC Rust Worker"
    );

    // Redis
    let config = RedisConfig::from_url(&redis_url)?;
    let client = RedisClient::new(config, None, None, None);
    client.init().await?;
    let redis = Arc::new(client);

    // Docker
    let docker = Arc::new(DockerManager::new()?);

    // Task Consumer
    let consumer_name = format!("rust-{}", agent_id);
    let consumer = TaskConsumer::new(
        redis.clone(),
        consumer_name,
        agent_id.clone(),
        max_concurrent,
    );
    consumer.init().await?;

    // Health Checker (60s 间隔)
    let health_redis = redis.clone();
    let health_agent_id = agent_id.clone();
    tokio::spawn(async move {
        let mut checker = HealthChecker::new(health_redis, health_agent_id);
        loop {
            // 获取活跃任务数 (近似值)
            checker.report(0, max_concurrent as u32).await;
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });

    // 优雅关闭
    let shutdown_redis = redis.clone();
    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        info!("Shutting down...");
        let _ = shutdown_redis.quit().await;
        std::process::exit(0);
    });

    // 主消费循环 (阻塞)
    consumer.run(docker).await;

    Ok(())
}

fn hostname() -> String {
    std::env::var("HOSTNAME").unwrap_or_else(|_| {
        gethostname::gethostname()
            .to_string_lossy()
            .to_string()
    })
}
