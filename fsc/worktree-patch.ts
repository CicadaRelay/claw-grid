/**
 * Git Worktree 隔离补丁
 * 添加到 fsc-worker-daemon.ts
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ============ Git Worktree 管理 ============

/**
 * 创建 Git Worktree
 */
async function createWorktree(taskId: string, repoPath: string = '/workspace'): Promise<string> {
  const worktreePath = `${repoPath}/${taskId}`;
  const branchName = taskId;
  
  try {
    // git worktree add /workspace/${task_id} -b ${task_id}
    await execAsync(`git worktree add ${worktreePath} -b ${branchName}`, {
      cwd: repoPath
    });
    
    logger.info(`[Worktree] Created: ${worktreePath}`);
    return worktreePath;
  } catch (error) {
    logger.error(`[Worktree] Failed to create: ${error}`);
    throw error;
  }
}

/**
 * 移除 Git Worktree
 */
async function removeWorktree(taskId: string, repoPath: string = '/workspace'): Promise<void> {
  const worktreePath = `${repoPath}/${taskId}`;
  
  try {
    // git worktree remove /workspace/${task_id}
    await execAsync(`git worktree remove ${worktreePath} --force`, {
      cwd: repoPath
    });
    
    logger.info(`[Worktree] Removed: ${worktreePath}`);
  } catch (error) {
    logger.error(`[Worktree] Failed to remove: ${error}`);
    // 不抛出错误，继续执行
  }
}

/**
 * 生成 Git Diff 并触发 MemoV Snapshot
 */
async function snapshotWorktreeDiff(taskId: string, repoPath: string = '/workspace'): Promise<void> {
  const branchName = taskId;
  
  try {
    // git diff main...${task_id}
    const { stdout: diff } = await execAsync(`git diff main...${branchName}`, {
      cwd: repoPath
    });
    
    if (diff.trim()) {
      // 触发 MemoV snapshot
      await redis.xAdd('fsc:mem_events', '*', {
        type: 'worktree_diff',
        task_id: taskId,
        agent_id: AGENT_ID,
        diff_size: diff.length.toString(),
        timestamp: Date.now().toString()
      });
      
      logger.info(`[Worktree] Diff generated: ${diff.length} bytes`);
    } else {
      logger.info(`[Worktree] No changes detected`);
    }
  } catch (error) {
    logger.error(`[Worktree] Failed to generate diff: ${error}`);
  }
}

// ============ 修改后的 executeTask ============

async function executeTaskWithWorktree(task: Task): Promise<TaskResult> {
  const startTime = Date.now();
  logger.info(`[Task ${task.id}] Starting execution with Worktree isolation`);
  
  let worktreePath: string | null = null;
  
  try {
    // Pre: 创建 Git Worktree
    worktreePath = await createWorktree(task.id);
    
    const docker = new DockerInstance();
    
    // 启动容器（挂载 worktree）
    const containerName = await docker.startContainer(task.image, `fsc-${task.id}`, {
      volumes: [`${worktreePath}:/workspace`]
    });
    logger.info(`[Task ${task.id}] Container started: ${containerName}`);
    
    // 执行命令
    const result = await docker.runCommands(task.commands, task.timeoutSeconds);
    
    // 清理容器
    await docker.stopContainer();
    
    const duration = Date.now() - startTime;
    logger.info(`[Task ${task.id}] Completed in ${duration}ms`);
    
    // Post: 生成 diff 并触发 MemoV snapshot
    await snapshotWorktreeDiff(task.id);
    
    return {
      taskId: task.id,
      status: result.status === 'success' ? 'success' : 
              result.status === 'timeout' ? 'timeout' : 'failure',
      output: result.output,
      error: result.error,
      timestamp: Date.now()
    };
    
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(`[Task ${task.id}] Failed after ${duration}ms:`, error);
    
    return {
      taskId: task.id,
      status: 'failure',
      error: error instanceof Error ? error.message : String(error),
      timestamp: Date.now()
    };
  } finally {
    // Post: 移除 Git Worktree
    if (worktreePath) {
      await removeWorktree(task.id);
    }
  }
}
