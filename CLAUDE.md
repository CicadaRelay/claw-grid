# CLAUDE.md — claw-mesh

## 项目概述
FSC-Mesh 分布式 AI 编码集群的基础设施层。
三节点全互联: 中央(10.10.0.1) + 硅谷(10.10.0.2) + 东京(10.10.0.3)

## 架构
- **网络**: WireGuard 主 + SSH 容错热备 (环形互修)
- **消息**: Redis 7 Streams (XREADGROUP + XACK)
- **记忆**: MemoV (Git + Redis) + Pointer Memory (URI寻址)
- **执行**: Docker Agent 容器 (<200MB)，1000 并发目标
- **治理**: 四层架构 (宪法→仲裁→汇总→执行)

## 技术约束
- 运行时: Bun (非 Node.js)
- 中央服务器 2核/2G — 代码必须内存敏感
- Docker Agent 镜像 < 200MB
- 每任务 < 4000 tokens
- 每小时成本 < $0.50
- Worker 模型: MiniMax/Doubao (廉价优先)

## 编码规范
- TypeScript strict mode
- 错误处理: 返回 Result 对象，不用 try-catch 包装业务逻辑
- 序列化: MessagePack/FlatBuffers (非 JSON) 用于高频通信
- 测试: Vitest
- 包管理: bun

## 关键路径
- `fsc/fsc-worker-daemon.ts` — Worker 守护进程
- `fsc/memov-sync-daemon.ts` — 记忆同步
- `memory/pointer.js` — Pointer Memory OS
- `memory/causal.js` — 故障诊断
- `memory/ontology.js` — 知识图谱
- `api/` — LLM 代理 + SSE + MCP
- `deploy/Dockerfile.agent` — Agent 容器镜像
- `config/wg0.conf.template` — WireGuard 模板

## 不要做的事
- 不要删除 SSH 隧道配置 (容错需要)
- 不要用 express/koa，用 Bun.serve
- 不要在 Worker 层用昂贵模型 (Claude/GPT-4)
- 不要把原始日志传到中央节点 (只传聚合指标)

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **claw-mesh** (957 symbols, 1977 relationships, 70 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/claw-mesh/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/claw-mesh/context` | Codebase overview, check index freshness |
| `gitnexus://repo/claw-mesh/clusters` | All functional areas |
| `gitnexus://repo/claw-mesh/processes` | All execution flows |
| `gitnexus://repo/claw-mesh/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## CLI

- Re-index: `npx gitnexus analyze`
- Check freshness: `npx gitnexus status`
- Generate docs: `npx gitnexus wiki`

<!-- gitnexus:end -->
