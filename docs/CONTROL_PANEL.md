# Claw Mesh Control Panel

**Version:** 1.0.0  
**Tech Stack:** Vite + React + TypeScript + Tailwind + shadcn/ui + React Flow + Zustand + Socket.io

## 概述

Claw Mesh Control Panel 是一个深度集成 Mesh 网络和 MemoV 记忆系统的可视化控制台，提供实时监控、因果调试、全局搜索和时光回滚功能。

## 核心功能

### 1. Mesh 拓扑图（React Flow）
- 实时显示所有 Worker 节点
- 节点状态：在线/离线/繁忙
- 资源使用率：CPU、内存、磁盘
- 任务分布：每个节点的任务数
- 网络连接：WireGuard 连接状态

### 2. MemoV 时间线（WebSocket 实时推送）
- 实时显示所有 MemoV 事件
- 事件类型：task_complete、worker_shutdown、network_healed
- 时间轴可视化
- 事件过滤和搜索

### 3. 因果调试器（Causal Debugger）
- 7 种错误模式检测
- 指针版本链分析
- 因果关系可视化
- 自动修复建议

### 4. 全局搜索（MemoV + Qdrant）
- 语义搜索
- 精确指针查询
- 关键词过滤
- 结果排序和分页

### 5. 时光回滚（MCP Rollback）
- 选择任意时间点
- 预览回滚影响
- 一键回滚
- 回滚历史记录

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Claw Mesh Control Panel                   │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   Frontend   │───▶│  MCP Proxy   │───▶│    Redis     │  │
│  │ Vite + React │    │  Express +   │    │   Streams    │  │
│  │              │◀───│  Socket.io   │◀───│              │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│         │                    │                    │          │
│         ▼                    ▼                    ▼          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              WebSocket Real-time Push                 │  │
│  │  MemoV Events → Timeline → Causal Debugger           │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## 快速开始

### 前置条件

- Node.js 18+
- Bun (推荐) 或 npm
- Redis 运行在 10.10.0.1:6379
- FSC Worker 已部署

### 安装依赖

```bash
# 前端
cd frontend/claw-mesh-dashboard
npm install

# 后端
cd api
bun install express socket.io redis cors
```

### 启动服务

```bash
# 启动 MCP 代理（后端）
cd api
bun run memov-mcp-proxy.ts

# 启动前端（开发模式）
cd frontend/claw-mesh-dashboard
npm run dev
```

访问：http://localhost:5173

## 环境变量

### 后端（api/memov-mcp-proxy.ts）

```bash
PORT=3001
REDIS_HOST=10.10.0.1
REDIS_PORT=6379
MEMOV_PATH=/opt/claw-mesh/.mem
```

### 前端（frontend/claw-mesh-dashboard/.env）

```bash
VITE_API_URL=http://localhost:3001
VITE_WS_URL=ws://localhost:3001
```

## API 接口

### GET /api/mesh/topology
获取 Mesh 拓扑信息

**响应：**
```json
{
  "nodes": [
    {
      "id": "worker-node1",
      "cpu_usage": "45.23",
      "memory_usage": "2048/4096",
      "disk_usage": "60%",
      "running_tasks": 3,
      "max_concurrent": 10,
      "timestamp": 1709481600000
    }
  ]
}
```

### GET /api/memov/timeline
获取 MemoV 时间线

**参数：**
- `since`: 起始事件 ID（默认 '0'）
- `limit`: 返回数量（默认 50）

**响应：**
```json
{
  "timeline": [
    {
      "id": "1709481600000-0",
      "type": "task_complete",
      "task_id": "test-123",
      "agent_id": "worker-node1",
      "timestamp": 1709481600000
    }
  ]
}
```

### POST /api/search
全局搜索

**请求：**
```json
{
  "query": "revenue recognition",
  "limit": 10
}
```

**响应：**
```json
{
  "results": [
    {
      "pointer": "ptr://finance/rule/revenue@v1",
      "score": 0.95,
      "content": "Revenue recognition follows ASC 606",
      "timestamp": 1709481600000
    }
  ]
}
```

### POST /api/causal/debug
因果调试

**请求：**
```json
{
  "pointer": "ptr://api/auth/token@v2",
  "mode": "full"
}
```

**响应：**
```json
{
  "pointer": "ptr://api/auth/token@v2",
  "mode": "full",
  "issues": [
    {
      "type": "version_conflict",
      "severity": "high",
      "message": "Version v2 supersedes v1 but v1 is still active"
    }
  ],
  "suggestions": [
    "Deprecate ptr://api/auth/token@v1"
  ]
}
```

### POST /api/memov/rollback
时光回滚

**请求：**
```json
{
  "timestamp": 1709481600000,
  "target": "ptr://finance/rule/revenue@v1"
}
```

**响应：**
```json
{
  "success": true,
  "message": "Rolled back to 2026-03-03T10:00:00.000Z"
}
```

## WebSocket 事件

### memov:event
实时 MemoV 事件推送

**数据格式：**
```json
{
  "id": "1709481600000-0",
  "type": "task_complete",
  "task_id": "test-123",
  "agent_id": "worker-node1",
  "timestamp": 1709481600000
}
```

## 前端组件

### MeshTopology.tsx
使用 React Flow 渲染 Mesh 拓扑图

**功能：**
- 节点拖拽
- 缩放和平移
- 节点详情弹窗
- 实时更新

### MemoVTimeline.tsx
MemoV 事件时间线

**功能：**
- 实时事件流
- 事件过滤
- 时间轴导航
- 事件详情

### CausalDebugger.tsx
因果调试器

**功能：**
- 指针输入
- 错误检测
- 版本链可视化
- 修复建议

### GlobalSearch.tsx
全局搜索界面

**功能：**
- 搜索输入
- 结果列表
- 相关度排序
- 快速预览

### TimeRollback.tsx
时光回滚界面

**功能：**
- 时间选择器
- 影响预览
- 回滚确认
- 历史记录

## 状态管理（Zustand）

```typescript
interface AppState {
  // Mesh 状态
  nodes: Node[];
  selectedNode: Node | null;
  
  // MemoV 状态
  timeline: Event[];
  filters: EventFilter;
  
  // 搜索状态
  searchQuery: string;
  searchResults: SearchResult[];
  
  // 调试状态
  debugTarget: string;
  debugResults: DebugResult | null;
  
  // Actions
  setNodes: (nodes: Node[]) => void;
  selectNode: (node: Node) => void;
  addEvent: (event: Event) => void;
  setSearchQuery: (query: string) => void;
  // ...
}
```

## 样式（Tailwind + shadcn/ui）

使用 shadcn/ui 组件库：
- Button
- Card
- Dialog
- Input
- Select
- Table
- Toast

## 部署

### 开发环境

```bash
# 后端
cd api
bun run memov-mcp-proxy.ts

# 前端
cd frontend/claw-mesh-dashboard
npm run dev
```

### 生产环境

```bash
# 构建前端
cd frontend/claw-mesh-dashboard
npm run build

# 部署到 Nginx
cp -r dist/* /var/www/claw-mesh-dashboard/

# 启动后端（使用 PM2）
pm2 start api/memov-mcp-proxy.ts --name claw-mesh-api
```

### Docker 部署

```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm install

# 复制代码
COPY . .

# 构建前端
RUN npm run build

# 暴露端口
EXPOSE 3001 5173

# 启动
CMD ["npm", "run", "start"]
```

## 监控

### 健康检查

```bash
curl http://localhost:3001/health
```

### 日志

```bash
# 后端日志
pm2 logs claw-mesh-api

# 前端日志（开发模式）
npm run dev
```

## 故障排查

### WebSocket 连接失败

检查 CORS 配置：
```typescript
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',  // 生产环境应该限制域名
    methods: ['GET', 'POST']
  }
});
```

### Redis 连接失败

检查 Redis 配置：
```bash
redis-cli -h 10.10.0.1 ping
```

### 前端无法加载数据

检查 API URL 配置：
```bash
# frontend/claw-mesh-dashboard/.env
VITE_API_URL=http://localhost:3001
```

## 安全建议

1. **CORS 限制**
   - 生产环境限制允许的域名
   - 不要使用 `origin: '*'`

2. **认证授权**
   - 添加 JWT 认证
   - 限制 API 访问权限

3. **输入验证**
   - 验证所有用户输入
   - 防止 SQL 注入和 XSS

4. **HTTPS**
   - 生产环境使用 HTTPS
   - WebSocket 使用 WSS

## 参考资料

- [React Flow](https://reactflow.dev/)
- [Socket.io](https://socket.io/)
- [Zustand](https://github.com/pmndrs/zustand)
- [shadcn/ui](https://ui.shadcn.com/)
- [Tailwind CSS](https://tailwindcss.com/)

## 更新日志

### v1.0.0 (2026-03-03)
- 初始版本
- Mesh 拓扑图
- MemoV 时间线
- 因果调试器
- 全局搜索
- 时光回滚
