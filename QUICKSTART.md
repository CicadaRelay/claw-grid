# Pointer Memory OS - Quick Start

## Day 1 完成 ✓

已实现：
- ✅ Pointer 系统（URI 生成、版本管理、因果追踪）
- ✅ Qdrant 集成（向量搜索、精确查询、过滤）
- ✅ Memos 迁移脚本（API 拉取 → LLM 提取 → Pointer 存储）
- ✅ 测试套件（本地测试 + Qdrant 集成测试）

## 快速测试

### 1. 测试 Pointer 系统（无依赖）

```bash
cd /root/.openclaw/workspace/claw-mesh-dev
node scripts/test-pointer.js
```

**输出示例：**
```
=== Testing Pointer System ===

Test 1: Generate pointers
  Generated: ptr://finance/rule/revenue@2025-Q1
  ✓ Pass

Test 2: Parse pointer
  Parsed: { domain: 'finance', topic: 'rule', slug: 'revenue', version: '2025-Q1' }
  ✓ Pass

...

=== All tests passed! ===
```

### 2. 测试 Qdrant 集成（需要 Qdrant 运行）

```bash
# 启动 Qdrant（如果还没运行）
docker run -d -p 6333:6333 qdrant/qdrant

# 运行测试
node scripts/test-pointer.js --qdrant
```

### 3. 迁移 Memos 数据

```bash
# 设置环境变量
export MEMOS_URL=http://localhost:5230
export MEMOS_TOKEN=your_token_here
export OPENAI_KEY=sk-...
export QDRANT_URL=http://localhost:6333

# 运行迁移
node scripts/memos-migration.js
```

**迁移流程：**
1. 从 Memos API 拉取所有 memo
2. 用 GPT-4 提取结构化事实
3. 为每个事实生成 pointer URI
4. 用 OpenAI 生成 embedding
5. 存储到 Qdrant
6. 导出到 `memory/pointers.json`

## 使用示例

### 基础用法

```javascript
const { PointerSystem } = require('./memory/pointer');

const ps = new PointerSystem();

// 1. 生成 pointer
const ptr = ps.generatePointer('api', 'auth', 'token', 'v1');
// → ptr://api/auth/token@v1

// 2. 创建 payload
const payload = ps.createPayload({
  pointer: ptr,
  type: 'rule',
  topic: 'auth',
  content: 'JWT tokens expire after 24 hours',
  keywords: ['jwt', 'token', 'expiry']
});

// 3. 存储
ps.store(ptr, payload);

// 4. 更新版本
const v2 = ps.deprecateAndCreate(ptr, {
  type: 'rule',
  topic: 'auth',
  content: 'JWT tokens expire after 1 hour (security update)',
  keywords: ['jwt', 'token', 'expiry', 'security']
});
// → ptr://api/auth/token@v2 (supersedes v1)

// 5. 查询版本链
const chain = ps.getPointerChain(v2.pointer);
// → ['ptr://api/auth/token@v1', 'ptr://api/auth/token@v2']
```

### Qdrant 集成

```javascript
const { QdrantPointerStore } = require('./memory/qdrant-pointer');

const store = new QdrantPointerStore('http://localhost:6333');

// 初始化
await store.initialize();

// 存储（需要 embedding）
const embedding = await generateEmbedding(payload.content);
await store.storePointer(payload, embedding);

// 向量搜索
const queryEmbedding = await generateEmbedding('token expiry rules');
const results = await store.searchPointers(queryEmbedding, 10);
// → [{ pointer, score, summary, payload }]

// 精确查询
const exact = await store.getPointer('ptr://api/auth/token@v2');

// 按主题过滤
const authPointers = await store.getActiveByTopic('auth');

// 获取版本链
const chain = await store.getPointerChain('ptr://api/auth/token@v2');
```

## Pointer 命名规范

### 标准格式
```
ptr://{domain}/{topic}/{slug}@{version}
```

### Domain 分类
- `finance` - 财务规则
- `api` - API 规范
- `code` - 代码知识
- `personal` - 个人偏好
- `project` - 项目信息

### Topic 分类
- `rule` - 规则
- `auth` - 认证
- `bug` - Bug 记录
- `lesson` - 经验教训
- `error` - 错误处理

### Version 格式
- `v1`, `v2`, `v3` - 简单递增
- `2025-Q1`, `2026-Q2` - 时间版本
- `v1.1`, `v1.2` - 小版本更新

### 示例
```
ptr://finance/rule/revenue@2025-Q1
ptr://api/auth/clientId@v2
ptr://code/bug/memory-leak@v1
ptr://personal/preference/editor@v3
ptr://project/config/database@2026-03
```

## Payload 类型

### fact - 事实
```json
{
  "type": "fact",
  "content": "User ID is stored in JWT payload"
}
```

### rule - 规则
```json
{
  "type": "rule",
  "content": "All API requests must include Authorization header"
}
```

### lesson - 经验教训
```json
{
  "type": "lesson",
  "content": "Always validate input before database queries to prevent SQL injection"
}
```

### error - 错误记录
```json
{
  "type": "error",
  "content": "Memory leak caused by unclosed database connections",
  "metadata": {
    "severity": "high",
    "fixed_in": "ptr://code/bug/memory-leak@v2"
  }
}
```

## 目录结构

```
claw-mesh-dev/
├── memory/
│   ├── pointer.js              # Pointer 系统核心
│   ├── qdrant-pointer.js       # Qdrant 集成
│   ├── causal.js               # 因果修正（已有）
│   ├── ontology.js             # 本体论（已有）
│   ├── pointers.json           # Pointer 目录（自动生成）
│   └── README.md               # 详细文档
├── scripts/
│   ├── memos-migration.js      # Memos 迁移脚本
│   └── test-pointer.js         # 测试套件
└── QUICKSTART.md               # 本文件
```

## 下一步（Day 2）

### 任务清单
- [ ] 集成 `causal.js` 实现 7 种错误修正模式
- [ ] 添加 context tree 压缩（基于 agentic-context-engine）
- [ ] 创建 A2A agent chain：
  - [ ] planner - 任务分解
  - [ ] researcher - pointer 搜索
  - [ ] coder - 代码生成
  - [ ] validator - 沙盒验证
  - [ ] updater - pointer 更新

### 预期产出
- `memory/causal-pointer.js` - 因果修正集成
- `memory/context-tree.js` - 上下文树
- `agents/` - A2A agent 定义
- `scripts/test-a2a.js` - A2A 测试

## 环境要求

### 必需
- Node.js 18+
- Qdrant (Docker 或本地)

### 可选（用于 Memos 迁移）
- Memos 实例
- OpenAI API key

### Docker 快速启动

```bash
# Qdrant
docker run -d -p 6333:6333 -v $(pwd)/qdrant_storage:/qdrant/storage qdrant/qdrant

# Memos（可选）
docker run -d -p 5230:5230 -v $(pwd)/memos_data:/var/opt/memos neosmemo/memos:latest
```

## 故障排查

### Qdrant 连接失败
```bash
# 检查 Qdrant 是否运行
curl http://localhost:6333/collections

# 如果没有响应，启动 Qdrant
docker run -d -p 6333:6333 qdrant/qdrant
```

### Memos 迁移失败
```bash
# 检查环境变量
echo $MEMOS_TOKEN
echo $OPENAI_KEY

# 测试 Memos API
curl -H "Authorization: Bearer $MEMOS_TOKEN" $MEMOS_URL/api/v1/memos
```

### 模块找不到
```bash
# 确保在正确的目录
cd /root/.openclaw/workspace/claw-mesh-dev

# 检查文件是否存在
ls -la memory/
ls -la scripts/
```

## 性能指标（Day 1）

- ✅ Pointer 生成：< 1ms
- ✅ 版本管理：< 1ms
- ✅ 本地搜索：< 10ms（1000 pointers）
- ⏳ Qdrant 搜索：< 50ms（待测试）
- ⏳ Memos 迁移：~2s/memo（待测试）

## 联系

- 项目：claw-mesh-dev
- 文档：`memory/README.md`
- 测试：`scripts/test-pointer.js`
