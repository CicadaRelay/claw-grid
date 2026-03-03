# MemoV Multi-Node Sync Strategy
**来源**: Perplexity
**时间**: 2026-03-03 12:19

## 同步方案

### 核心策略
**混合方案**: Git 分支 + Redis Streams 事件

### 同步方法
1. **Git 分支管理**
   - 每个 Agent 独立分支
   - Master 分支只写，Workers 只读

2. **Redis Streams 事件**
   - 实时任务结果推送
   - 事件驱动的 Git push

3. **冲突解决**
   - CAS (Compare-And-Swap) + SHA256 内容寻址
   - 基于内容哈希的冲突检测

### 同步时间表
```json
{
  "task_result": "realtime-redis-streams",
  "context_snapshot": "periodic-30s",
  "prompt_version": "event-driven-git-push"
}
```

### 目录结构
```
.mem/
├── shared/           # Master 写，Workers 只读
├── agents/<id>/      # 每个容器独占
└── results/          # Master 在 Redis 事件时合并
```

### WireGuard Mesh 复制
```bash
rsync --checksum shared/ <node>:.mem/shared/
```
仅在 shared/ 变更时触发

## 实现步骤

### Step 1: 初始化 .mem 结构
```bash
mkdir -p .mem/{shared,agents,results}
cd .mem && git init
git config user.name "FSC-Cluster"
git config user.email "fsc@cluster.local"
```

### Step 2: Redis Streams 配置
```typescript
// 创建 Stream
await redis.xadd('fsc:mem_events', '*', 
  'type', 'context_update',
  'agent_id', agentId,
  'sha256', contentHash
)

// 消费 Stream
const events = await redis.xread(
  'BLOCK', 5000,
  'STREAMS', 'fsc:mem_events', lastId
)
```

### Step 3: 同步 Daemon
```typescript
// 每 30 秒快照
setInterval(async () => {
  await git.add('.mem/agents/*')
  await git.commit(`snapshot ${Date.now()}`)
}, 30000)

// 监听 Redis 事件
redis.xread('fsc:mem_events', (event) => {
  if (event.type === 'context_update') {
    syncToNodes(event.agent_id)
  }
})
```

### Step 4: WireGuard 复制
```bash
# 在 shared/ 变更时触发
inotifywait -m .mem/shared/ -e modify,create,delete |
while read path action file; do
  for node in 10.10.0.{2,3,4}; do
    rsync -avz --checksum .mem/shared/ root@$node:.mem/shared/
  done
done
```

## 冲突解决机制

### CAS + SHA256
```typescript
async function writeWithCAS(path: string, content: string) {
  const currentHash = await sha256(await readFile(path))
  const newHash = sha256(content)
  
  // Redis CAS
  const success = await redis.eval(`
    if redis.call('get', KEYS[1]) == ARGV[1] then
      redis.call('set', KEYS[1], ARGV[2])
      return 1
    else
      return 0
    end
  `, 1, `mem:${path}`, currentHash, newHash)
  
  if (success) {
    await writeFile(path, content)
    await git.add(path)
    await git.commit(`update ${path} ${newHash}`)
  } else {
    throw new Error('CAS conflict')
  }
}
```

## 性能优化

### 1. 增量同步
只同步变更的文件，使用 `rsync --checksum`

### 2. 批量提交
30 秒内的变更合并为一次 Git commit

### 3. 异步复制
WireGuard 复制在后台进行，不阻塞主流程

### 4. 压缩传输
```bash
rsync -avz --compress-level=9 .mem/shared/ <node>:.mem/shared/
```
