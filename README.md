# CLAW Mesh

**FSC-Mesh: 分布式 AI 编码集群 + 治理控制平面 + Pointer Memory OS**

将 WireGuard 全网状网络、Full Self Coding (FSC) 并行编码引擎、四层治理控制平面、MemoV AI 记忆层、Pointer Memory OS 整合为统一的分布式 AI Agent 协作平台。目标: 1000 Docker Agent 并行自治编码。

## 🎯 核心功能

1. **并行编码**: FSC Worker 从 Redis Streams 拉取任务，Docker 容器并行执行，优先级调度
2. **四层治理**: 宪法(PolicyEngine) → 仲裁(Arbitration) → 质量(QualityJudge) → 执行
3. **Agent 信誉**: Trust Factor 动态评分，信誉匹配任务，连续失败冷却
4. **成本控制**: 预算追踪 + 模型自动降级 (premium → standard → economy → paused)
5. **三重质量门**: 自动化检查 + 结构分析 + LLM Judge，防止低质量代码合并
6. **AI Agent 协作**: 通过 MemoV 共享上下文，支持多 Agent 对话
7. **Pointer Memory OS**: URI-based 记忆寻址，支持版本管理、因果追踪、向量搜索
8. **进化层**: GEP 策略预设 (balanced/innovate/harden)，反收敛检测

## 🏗️ 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    治理控制平面 (governance/)                 │
├─────────┬───────────┬───────────┬──────────┬───────────────┤
│ 宪法层   │ 仲裁层     │ 质量层    │ 成本层   │ 进化层        │
│ Policy   │ Arbitrate │ Judge    │ Budget   │ Evolution    │
│ Engine   │ (ECON)    │ (RGD)    │ Control  │ (GEP/EvoMap) │
├─────────┴───────────┴───────────┴──────────┴───────────────┤
│                    信誉系统 (Trust Factor)                    │
├─────────────────────────────────────────────────────────────┤
│                    审计日志 (Redis Stream)                    │
└─────────────────────────────────────────────────────────────┘

中央节点 (10.10.0.1)                Worker 节点 (10.10.0.2/3/...)
├── Redis 7 (Streams + Hash)       ├── FSC Worker Daemon v0.3.0
├── 治理控制平面                    │   ├── 失败分类 (5 类)
├── MemoV Master                    │   ├── 差异化重试
├── Qdrant (向量数据库)             │   └── 主动自愈引擎
├── FSC Gateway                     ├── MemoV Sync Daemon v2.1
└── Dashboard (Material Glass)      ├── Pointer Memory OS
                                    └── Docker Agent (<200MB)
```

## 📦 项目结构

```
claw-mesh/
├── governance/         # 治理控制平面 (1947 LOC)
│   ├── types.ts                  # 治理类型定义
│   ├── trust-factor.ts           # Agent 信誉系统
│   ├── policy-engine.ts          # 声明式策略引擎 (7 内置规则)
│   ├── audit-log.ts              # 审计日志 (Redis Stream)
│   ├── quality-judge.ts          # 三重质量验证
│   ├── arbitration.ts            # 共识投票协议
│   ├── cost-controller.ts        # 成本控制 + 模型降级
│   ├── evolution.ts              # 进化层 (GEP 策略)
│   └── index.ts                  # 统一入口 + 工厂函数
├── fsc/                # FSC 集成代码
│   ├── fsc-worker-daemon.ts      # Worker 守护进程 v0.3.0
│   ├── memov-sync-daemon.ts      # MemoV 同步守护进程 v2.1
│   ├── deploy-workers.sh         # 部署脚本
│   └── start-worker.sh           # 启动脚本
├── memory/             # Pointer Memory OS
│   ├── pointer.js                # Pointer 系统核心
│   ├── qdrant-pointer.js         # Qdrant 集成
│   ├── causal.js                 # 因果修正
│   ├── ontology.js               # 本体论
│   └── pointers.json             # Pointer 目录
├── frontend/           # Dashboard (Material Glass)
│   └── claw-mesh-dashboard/      # React + Vite + Zustand
├── scripts/            # 工具脚本
├── memov/              # MemoV 配置和文档
├── QUICKSTART.md       # 快速开始
└── README.md
```

## 🛡️ 治理控制平面

四层治理确保 Agent 集群安全、高效、可控运行：

| 层级 | 模块 | 职责 | 理论基础 |
|------|------|------|----------|
| 宪法层 | `PolicyEngine` | 7 条声明式规则 (token/成本/信誉/容量)，hot-update | GaaS 论文 |
| 仲裁层 | `Arbitration` | 风险分级投票 (1/3/5/7 Judge)，信誉加权 | ECON (ICML 2025) |
| 质量层 | `QualityJudge` | 自动化(0-40) + 结构(0-30) + LLM(0-30) 三重验证 | AXIOM 警告 |
| 进化层 | `Evolution` | 探索/利用平衡，Capsule 知识复用，反收敛 | EvoMap GEP |

**信誉系统 (Trust Factor)**:
- 评分公式: 成功率 x40 + 质量 x30 - 违规 x20 - 成本 x10
- 动态调整: 成功 +2~5, 失败 -3~10, 质量优秀 +3, 连续成功 x1.2
- 冷却机制: 连续失败 3 次 → 5 分钟禁止接任务

**成本控制 (Cost Controller)**:
- 预算 < 50%: premium (claude-sonnet)
- 预算 50-80%: standard (doubao)
- 预算 > 80%: economy (minimax)
- 预算 > 100%: paused (硬停止)

**Redis 数据结构**:
- Streams: `fsc:governance:audit`, `fsc:review_queue`, `fsc:votes:{taskId}`
- Hash: `fsc:trust:{agentId}`, `fsc:budget`, `fsc:policies`
- Sorted Set: `fsc:trust:leaderboard`

```typescript
import { createGovernanceLayer } from './governance';

const gov = await createGovernanceLayer(redis);

// 策略检查
const check = gov.policy.validate(task, agent, budget, activeTasks, maxConcurrent);
if (!check.allowed) console.log('Blocked:', check.violations);

// 质量评估
const report = await gov.quality.evaluate({ taskId, agentId, gitDiff, ... });
if (report.decision === 'REJECT') { /* 不合并 */ }

// 信誉更新
await gov.trust.updateFromReceipt(executionReceipt);
```

## 🔗 与上游项目的关系

- **FSC**: 基于 [full-self-coding](https://github.com/coleam00/full-self-coding)，添加治理感知调度 + WireGuard 网络支持
- **MemoV**: 使用 [memov](https://github.com/memovai/memov) 作为记忆层，v2.1 事件驱动 + 多节点 Git 同步
- **EvoMap**: 整合 [EvoMap evolver](https://github.com/EvoMap) GEP 协议，Agent 自进化 + Capsule 知识复用
- **WireGuard**: 自研配置管理，支持全网状拓扑 + SSH 隧道热备容错

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

- [FSC Worker Daemon v0.3.0](./fsc/fsc-worker-daemon.ts) — 失败分类 + 主动自愈
- [MemoV Sync v2.1](./fsc/memov-sync-daemon.ts) — 事件驱动快照
- [MemoV 同步策略](./memov/memov-sync-strategy.md)
- [Pointer Memory OS](./memory/README.md)

## 📊 技术栈

- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **Queue**: Redis 7 (Streams + Pub/Sub + Sorted Set)
- **Memory**: MemoV v2.1 (Git + Redis) + Pointer Memory OS
- **Network**: WireGuard + SSH 隧道热备
- **Container**: Docker (<200MB per Agent)
- **Frontend**: React + Vite + Zustand + Material Glass
- **Governance**: 自研四层治理 (1947 LOC)

## 📝 License

MIT

## 🙏 致谢

- [full-self-coding](https://github.com/coleam00/full-self-coding) - FSC 核心引擎
- [memov](https://github.com/memovai/memov) - AI 记忆层
- [EvoMap](https://github.com/EvoMap) - GEP 协议 + AI Council 治理
- [OpenClaw](https://github.com/openclaw/openclaw) - AI Agent 框架

## 📖 理论基础

- **ECON** (ICML 2025) — 贝叶斯纳什均衡，1000 Agent 无需互相通信
- **GaaS** — Trust Factor 信誉评分 + 声明式规则引擎
- **AXIOM** — LLM Judge 80% 误判率警告 → 三重验证对策
- **RGD** — Guide+Debug+Feedback 三 Agent，Pass@1 97.6%
- **MAGMA** — 四图记忆 (语义/时间/因果/实体)，token 减 95%
