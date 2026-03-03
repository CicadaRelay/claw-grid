# CLAW Mesh

**OpenClaw 分布式 AI 编码集群 + Pointer Memory OS**

将 WireGuard 全网状网络、Full Self Coding (FSC) 并行编码引擎、MemoV AI 记忆层、Pointer Memory OS 整合为统一的分布式 AI Agent 协作平台。

## 🎯 核心功能

1. **并行编码**: FSC Worker 从 Redis 队列拉取任务，Docker 容器并行执行
2. **AI Agent 协作**: 通过 MemoV 共享上下文，支持多 Agent 对话
3. **分布式任务调度**: 中央节点调度，Worker 节点执行
4. **Pointer Memory OS**: URI-based 记忆寻址，支持版本管理、因果追踪、向量搜索

## 🏗️ 架构

```
中央节点 (10.10.0.1)
├── Redis (任务队列)
├── MemoV Master (.mem/memov.git bare repo)
├── Qdrant (向量数据库)
└── FSC Gateway (任务调度)

Worker 节点 (10.10.0.2/3/4)
├── FSC Worker Daemon (任务执行)
├── MemoV Sync Daemon (记忆同步)
├── Pointer Memory OS (记忆寻址)
└── Docker (容器运行时)
```

## 📦 项目结构

```
claw-mesh/
├── reference/          # WireGuard 配置参考
├── fsc/                # FSC 集成代码
│   ├── fsc-worker-daemon.ts      # Worker 守护进程
│   ├── memov-sync-daemon.ts      # MemoV 同步守护进程
│   ├── deploy-workers.sh         # 部署脚本
│   └── start-worker.sh           # 启动脚本
├── memory/             # Pointer Memory OS
│   ├── pointer.js                # Pointer 系统核心
│   ├── qdrant-pointer.js         # Qdrant 集成
│   ├── causal.js                 # 因果修正
│   ├── ontology.js               # 本体论
│   ├── pointers.json             # Pointer 目录
│   └── README.md                 # 详细文档
├── scripts/            # 工具脚本
│   ├── memos-migration.js        # Memos 迁移
│   └── test-pointer.js           # 测试套件
├── memov/              # MemoV 配置和文档
│   └── memov-sync-strategy.md    # 同步策略
├── QUICKSTART.md       # 快速开始
└── README.md
```

## 🔗 与上游项目的关系

- **FSC**: 基于 [full-self-coding](https://github.com/coleam00/full-self-coding)，添加 OpenClaw 集成和 WireGuard 网络支持
- **MemoV**: 使用 [memov](https://github.com/memovai/memov) 作为记忆层，添加多节点 Git 同步机制
- **WireGuard**: 自研配置管理，支持 4 节点全网状拓扑（10.10.0.0/24）

## 🚀 快速开始

### Pointer Memory OS (Day 1 ✓)

```bash
# 测试 Pointer 系统
cd /root/.openclaw/workspace/claw-mesh-dev
node scripts/test-pointer.js

# 测试 Qdrant 集成（需要 Qdrant 运行）
docker run -d -p 6333:6333 qdrant/qdrant
node scripts/test-pointer.js --qdrant

# 迁移 Memos 数据
export MEMOS_URL=http://localhost:5230
export MEMOS_TOKEN=your_token
export OPENAI_KEY=sk-...
node scripts/memos-migration.js
```

详细文档：[QUICKSTART.md](./QUICKSTART.md) | [memory/README.md](./memory/README.md)

### FSC Worker 部署

### 前置条件

- WireGuard 全网状网络已配置（10.10.0.0/24）
- 中央节点 Redis 运行在 10.10.0.1:6379
- 所有节点已安装 Bun/Node.js 18+

### 部署

```bash
# 1. 克隆仓库
git clone https://github.com/2233admin/claw-mesh.git
cd claw-mesh

# 2. 部署到所有节点
cd fsc
./deploy-workers.sh

# 3. 在每个 Worker 节点启动
./start-worker.sh
```

## 🤝 协作开发

### 分支策略

- `main`: 稳定版本
- `central-dev`: 中央节点开发分支
- `silicon-dev`: 硅谷节点开发分支
- `tokyo-dev`: 东京节点开发分支

### 工作流程

1. 创建你的分支：`git checkout -b <node>-dev`
2. 开发并提交：`git commit -m "feat: xxx"`
3. 推送到远程：`git push origin <node>-dev`
4. 在 GitHub 上创建 Pull Request
5. 代码审查后合并到 `main`

### 任务分工

- **硅谷节点**: FSC Worker 优化 + MemoV 集成测试
- **中央节点**: Redis 配置 + 中央调度器 + .mem bare repo 初始化
- **东京节点**: 轻量级 Worker 部署 + 性能测试

## 📚 文档

- [FSC Worker Daemon 设计](./fsc/fsc-worker-daemon.ts)
- [MemoV 同步策略](./memov/memov-sync-strategy.md)
- [部署指南](./fsc/deploy-workers.sh)

## 📊 技术栈

- **Runtime**: Bun / Node.js 18+
- **Language**: TypeScript
- **Queue**: Redis 7+
- **Memory**: MemoV (Git + ChromaDB)
- **Network**: WireGuard
- **Container**: Docker

## 📝 License

MIT

## 🙏 致谢

- [full-self-coding](https://github.com/coleam00/full-self-coding) - FSC 核心引擎
- [memov](https://github.com/memovai/memov) - AI 记忆层
- [OpenClaw](https://github.com/openclaw/openclaw) - AI Agent 框架
