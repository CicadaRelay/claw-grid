# AI Scientist OS - Claw Mesh 集成

**Version:** 1.0.0  
**Integration Date:** 2026-03-03

## 概述

在 Claw Mesh 基础上构建 AI Scientist OS，实现三节点并行开发的分布式 AI 科学家系统。

## 架构

```
Claw Mesh (基础设施)
    ↓
├── WireGuard Mesh (网络层)
├── Redis Streams (消息队列)
├── FSC Worker (任务执行)
└── MemoV (记忆系统)
    ↓
AI Scientist OS (应用层)
    ↓
├── Tool Registry (Tokyo)
├── Planning & Routing (Silicon)
└── Visualization (Central)
```

## 模块分配

### 🇯🇵 Tokyo Node - Tool Engineer
**目录：** `ai-scientist/tools/`

**模块：**
- M1: Tool Registry
- M4: Multi-modal Input

**文件：**
```
ai-scientist/tools/
├── registry.json          # 20 核心工具定义
├── mcp-adapter.ts         # MCP 协议适配器
├── multi-modal-input.ts   # 多模态输入处理
└── README.md              # 工具文档
```

**集成点：**
- 使用现有的 `mcp/` 目录中的 MCP 基础设施
- 工具注册到 Redis: `fsc:tools` Stream
- 与 FSC Worker 集成执行

---

### 🇺🇸 Silicon Valley Node - Planning Architect
**目录：** `ai-scientist/planning/`

**模块：**
- M2: Plan & Verify
- M3: Semantic Routing

**文件：**
```
ai-scientist/planning/
├── task-decomposer.ts     # 任务分解器
├── plan-verify-loop.ts    # 计划验证循环
├── semantic-router.ts     # 语义路由器
├── dag-executor.ts        # DAG 执行器
└── README.md              # 规划文档
```

**集成点：**
- 使用 `memory/qdrant-pointer.js` 进行语义搜索
- 任务推送到 `fsc:tasks` Stream
- 与 FSC Worker 的分布式锁集成

---

### 🇨🇳 Central Node - UI/Observability Lead
**目录：** `ai-scientist/ui/`, `ai-scientist/integration/`

**模块：**
- M5: Mermaid Visualization
- 集成测试

**文件：**
```
ai-scientist/ui/
├── mermaid-renderer.tsx   # Mermaid 渲染器
├── dashboard.tsx          # 控制台集成
└── README.md              # UI 文档

ai-scientist/integration/
├── verify-integration.sh  # 集成测试脚本
├── demo-scenarios.ts      # Demo 场景
└── README.md              # 集成文档
```

**集成点：**
- 扩展现有的 `frontend/claw-mesh-dashboard/`
- 使用 `api/memov-mcp-proxy.ts` 获取数据
- 集成 `api/stream-chat.ts` 实时推送

---

## 开发流程

### Phase 1: 基础集成（Day 1 上午）

**Tokyo:**
1. 在 `ai-scientist/tools/registry.json` 定义 20 个工具
2. 实现 `mcp-adapter.ts` 连接现有 MCP 服务器
3. 工具注册到 Redis `fsc:tools`

**Silicon:**
1. 在 `ai-scientist/planning/task-decomposer.ts` 实现任务分解
2. 使用 `memory/pointer.js` 进行任务存储
3. 任务推送到 `fsc:tasks`

**Central:**
1. 准备集成测试框架
2. 扩展 `frontend/claw-mesh-dashboard/` 添加 AI Scientist 视图

---

### Phase 2: 功能开发（Day 1 下午）

**Tokyo:**
1. 实现 `multi-modal-input.ts`
2. 集成截图分析功能
3. 测试工具调用

**Silicon:**
1. 实现 `semantic-router.ts`
2. 集成 Qdrant 向量搜索
3. 测试路由准确率

**Central:**
1. 实现 `mermaid-renderer.tsx`
2. 集成到控制台
3. 测试实时更新

---

### Phase 3: 集成测试（Day 2 上午）

**Central 主导：**
1. 运行 `verify-integration.sh`
2. 测试端到端流程
3. 性能测试
4. 修复集成问题

---

### Phase 4: Demo & 优化（Day 2 下午）

**三节点联合：**
1. 运行 Demo 场景
2. 压力测试（60 Agent 并行）
3. 性能优化
4. 录制 Demo 视频

---

## 集成 API

### Tool Registry API
```typescript
// 注册工具
POST /api/tools/register
Body: { tool: Tool }

// 发现工具
GET /api/tools/discover?query=Redis故障
Response: { tools: Tool[] }

// 调用工具
POST /api/tools/invoke
Body: { tool_id: string, params: any }
```

### Planning API
```typescript
// 分解任务
POST /api/planning/decompose
Body: { description: string }
Response: { plan: Plan }

// 执行计划
POST /api/planning/execute
Body: { plan: Plan }
Response: { execution_id: string }

// 查询状态
GET /api/planning/status/:execution_id
Response: { status: ExecutionStatus[] }
```

### Visualization API
```typescript
// 生成 Mermaid
POST /api/viz/mermaid
Body: { plan: Plan, status: ExecutionStatus[] }
Response: { diagram: string }

// 实时更新（WebSocket）
WS /api/viz/stream
Message: { type: 'update', data: ExecutionStatus }
```

---

## 数据流

```
用户输入
    ↓
Task Decomposer (Silicon)
    ↓
Semantic Router (Silicon)
    ↓
Tool Registry (Tokyo)
    ↓
FSC Worker (3 nodes)
    ↓
MemoV (Central)
    ↓
Mermaid Viz (Central)
    ↓
用户界面
```

---

## Redis Streams

### 新增 Streams

```bash
# 工具注册
fsc:tools

# 任务计划
fsc:plans

# 执行状态
fsc:executions

# 可视化更新
fsc:viz_updates
```

### 现有 Streams（复用）

```bash
# 任务队列
fsc:tasks

# 结果队列
fsc:results

# 死信队列
fsc:dlq

# MemoV 事件
fsc:mem_events

# 心跳
fsc:heartbeats

# 开发状态
fsc:dev_status
```

---

## 部署

### 单节点测试
```bash
cd /root/.openclaw/workspace/claw-mesh-dev
./scripts/deploy-all.sh
```

### 三节点部署
```bash
# 在任意节点执行
./scripts/deploy-all.sh all
```

### 启动 AI Scientist 服务
```bash
# Tokyo
pm2 start ai-scientist/tools/mcp-adapter.ts --name ai-tools

# Silicon
pm2 start ai-scientist/planning/task-decomposer.ts --name ai-planning

# Central
pm2 start ai-scientist/ui/dashboard.tsx --name ai-dashboard
```

---

## 验证清单

- [ ] Q1: Tool Discovery - `curl /api/tools/discover?query=Redis故障`
- [ ] Q2: Task Decomposition - `curl /api/planning/decompose -d '{"description":"Redis集群故障"}'`
- [ ] Q3: Semantic Routing - 验证路由准确率 >95%
- [ ] Q4: Mermaid Rendering - 验证流程图生成
- [ ] Q5: E2E Demo - 单细胞分析 → 60 Agent 并行

---

## 下一步

1. Tokyo 开始实现 Tool Registry
2. Silicon 开始实现 Task Decomposer
3. Central 准备集成测试框架

**Let's build on top of Claw Mesh! 🚀**
