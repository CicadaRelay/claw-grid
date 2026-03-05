//! Docker Manager — bollard crate (Docker Engine API 直连)
//!
//! 用 bollard 直连 Docker Engine Unix socket 替代 shell `docker exec`。

use bollard::container::{
    Config, CreateContainerOptions, RemoveContainerOptions, StartContainerOptions,
    WaitContainerOptions,
};
use bollard::Docker;
use std::collections::HashMap;
use std::time::Duration;
use tracing::{error, info, warn};

use crate::task_consumer::Task;

pub struct ExecutionResult {
    pub status: String,
    pub output: String,
    pub error: String,
    pub failure_class: String,
}

pub struct DockerManager {
    docker: Docker,
}

impl DockerManager {
    pub fn new() -> Result<Self, bollard::errors::Error> {
        let docker = Docker::connect_with_socket_defaults()?;
        info!("Docker engine connected");
        Ok(Self { docker })
    }

    pub async fn execute_task(&self, task: &Task) -> ExecutionResult {
        let container_name = format!("fsc-{}", task.id);

        // 创建容器
        let config = Config {
            image: Some(task.image.clone()),
            cmd: Some(task.commands.iter().map(|s| s.as_str()).collect()),
            host_config: Some(bollard::service::HostConfig {
                memory: Some(200 * 1024 * 1024), // 200MB 硬限制
                memory_swap: Some(200 * 1024 * 1024),
                cpu_period: Some(100000),
                cpu_quota: Some(100000), // 1 CPU core
                ..Default::default()
            }),
            ..Default::default()
        };

        let create_opts = CreateContainerOptions {
            name: &container_name,
            platform: None,
        };

        match self.docker.create_container(Some(create_opts), config).await {
            Ok(_) => {}
            Err(e) => {
                return ExecutionResult {
                    status: "failure".into(),
                    output: String::new(),
                    error: format!("Container create failed: {}", e),
                    failure_class: classify_error(&e.to_string()),
                };
            }
        }

        // 启动容器
        if let Err(e) = self
            .docker
            .start_container(&container_name, None::<StartContainerOptions<String>>)
            .await
        {
            self.cleanup(&container_name).await;
            return ExecutionResult {
                status: "failure".into(),
                output: String::new(),
                error: format!("Container start failed: {}", e),
                failure_class: classify_error(&e.to_string()),
            };
        }

        // 等待完成 (超时控制)
        let timeout = Duration::from_secs(task.timeout_seconds);
        let wait_result = tokio::time::timeout(
            timeout,
            self.docker
                .wait_container(&container_name, None::<WaitContainerOptions<String>>)
                .next(),
        )
        .await;

        let (status, output, error_msg) = match wait_result {
            Ok(Some(Ok(exit))) => {
                let logs = self.get_logs(&container_name).await;
                let exit_code = exit.status_code;
                if exit_code == 0 {
                    ("success".to_string(), logs, String::new())
                } else {
                    let err = format!("Exit code: {}", exit_code);
                    ("failure".to_string(), logs, err)
                }
            }
            Ok(Some(Err(e))) => (
                "failure".to_string(),
                String::new(),
                format!("Wait error: {}", e),
            ),
            Ok(None) => (
                "failure".to_string(),
                String::new(),
                "No wait result".to_string(),
            ),
            Err(_) => {
                warn!(task_id = %task.id, "Task timed out");
                ("timeout".to_string(), String::new(), "Timeout".to_string())
            }
        };

        let failure_class = if status != "success" {
            classify_error(&error_msg)
        } else {
            String::new()
        };

        // 清理
        self.cleanup(&container_name).await;

        ExecutionResult {
            status,
            output,
            error: error_msg,
            failure_class,
        }
    }

    async fn get_logs(&self, container_name: &str) -> String {
        use bollard::container::LogsOptions;
        use futures_util::StreamExt;

        let opts = LogsOptions::<String> {
            stdout: true,
            stderr: true,
            ..Default::default()
        };

        let mut output = String::new();
        let mut stream = self.docker.logs(container_name, Some(opts));

        while let Some(Ok(chunk)) = stream.next().await {
            output.push_str(&chunk.to_string());
        }

        // 限制输出大小
        if output.len() > 65536 {
            output.truncate(65536);
            output.push_str("\n... (truncated)");
        }

        output
    }

    async fn cleanup(&self, container_name: &str) {
        let opts = RemoveContainerOptions {
            force: true,
            ..Default::default()
        };
        if let Err(e) = self.docker.remove_container(container_name, Some(opts)).await {
            warn!(container = container_name, ?e, "Cleanup failed");
        }
    }
}

fn classify_error(error: &str) -> String {
    if error.contains("OOM") || error.contains("out of memory") || error.contains("No space") {
        "RESOURCE".to_string()
    } else if error.contains("timeout") || error.contains("Timeout") || error.contains("ECONNREFUSED") {
        "TRANSIENT".to_string()
    } else if error.contains("permission denied") || error.contains("EACCES") {
        "PERMANENT".to_string()
    } else if error.contains("lint") || error.contains("test") || error.contains("type error") {
        "QUALITY".to_string()
    } else {
        "UNKNOWN".to_string()
    }
}

// 需要 futures_util for StreamExt
use futures_util::StreamExt;
