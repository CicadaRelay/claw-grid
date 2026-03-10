# Tailscale 网络融合完成

## 变更内容

### 1. 新增网络配置模块 (`config/network.ts`)
- 定义节点拓扑（Mac 本地、硅谷、Windows、东京）
- Tailscale IP 映射（100.x.x.x）
- 节点角色管理（master/worker）
- 动态节点发现和在线检测

### 2. 更新 Redis 配置 (`config/redis.ts`)
- 自动选择 Redis 主节点（优先硅谷节点 100.80.67.125）
- 支持本地 fallback（127.0.0.1）

### 3. 更新 MemoV Sync Daemon (`fsc/memov-sync-daemon.ts`)
- 动态获取活跃节点列表
- 自动同步到 Tailscale 网络节点

## 当前网络状态

```
✅ Mac 本地 (master)     - 100.114.56.105
✅ 硅谷节点 (worker)     - 100.80.67.125 [在线]
❌ Windows 节点 (worker) - 100.101.173.35 [已禁用]
❌ 东京节点 (worker)     - 未配置
```

## Redis 连接
- 主节点: 100.80.67.125:6379 (硅谷)
- 状态: 已连接

## MemoV 状态
- 进程 ID: 93036
- 同步节点: 100.80.67.125
- 状态: 正在监听事件流

## 添加新节点步骤

1. 确保新节点已加入 Tailscale 网络
2. 编辑 `config/network.ts`，添加节点配置
3. 设置 `enabled: true`
4. 重启 memov: `kill $(cat .memov.pid) && bun run fsc/memov-sync-daemon.ts > logs/memov-sync.log 2>&1 &`

## 测试命令

```bash
# 查看网络配置
bun run test-network.ts

# 查看 memov 日志
tail -f logs/memov-sync.log

# 检查进程
ps -p $(cat .memov.pid)
```
