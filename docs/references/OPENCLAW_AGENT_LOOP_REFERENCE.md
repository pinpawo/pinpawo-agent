# OpenClaw Agent Loop 参考

> 来源：OpenClaw 官方文档 (docs.openclaw.ai)
> 日期：2026-04-03
> 用途：作为 pet-agent orchestrator loop 设计的外部参考

## 1. 核心理念

OpenClaw 没有显式的 orchestrator loop / convergence controller。
它信任 LLM 原生的 tool-calling 循环作为收敛机制。

## 2. Agent Loop

单次 agent run 的执行路径：

```
intake → context assembly → model inference → tool execution → streaming → persistence
```

循环逻辑：
- LLM 推理后有 tool call → 执行工具，把结果放回消息，继续循环
- LLM 推理后没有 tool call → 输出最终回复，loop 结束

终止条件全部是代码级的：
- 模型不再调工具 → 自然结束
- 超时 → abort（默认 48 小时，可配置 `runTimeoutSeconds`）
- 外部信号 → 取消（AbortSignal）
- Gateway 断连

没有 decision/respond 分离，没有显式 convergence check。

## 3. Sub-Agent 机制

Sub-agent 是从现有 session 中 spawn 的后台任务，运行在隔离 session 中。

### 3.1 Spawn

非阻塞，返回 `{ status: "accepted", runId, childSessionKey }`。

```
/subagents spawn <agentId> <task> [--model <model>]
```

或通过 tool `sessions_spawn`：
- 必填：`task`
- 可选：`label`, `agentId`, `model`, `runTimeoutSeconds`, `mode`, `cleanup`, `sandbox`

### 3.2 返回结构（Announce）

Sub-agent 完成后 announce 回父 agent：

```
status:  'success' | 'error' | 'timeout' | 'unknown'   ← 代码级，不是 LLM 自我评估
result:  string（助手回复文本，或最后一个 toolResult）
stats:   { duration, tokenUsage(input/output/total), cost }
```

关键设计：
- status 是运行时状态，不是 LLM 判断
- 没有 `needs_more` / `blocked` / `ask_user` 等 LLM 自评估字段
- 没有单独的 summary 字段——父 agent 直接读 result 文本理解发生了什么
- 父 agent 收到 announce 后，在自己的 tool loop 里决定下一步
- 当前刚返回的 announce 是父 agent 做下一步判断的输入，不能在 handoff
  时再替换成短 preview；preview 只适合历史记录、UI 任务跟踪或 artifact
  refs。
- 如果结果本体是长结构化数据、长报告或二进制产物，sub-agent 应先把本体
  写成 artifact，再在 result/announce 中给出足够父 agent 回复用户的自然语
  言结论和 artifact 引用。

### 3.3 Announce 跳过

Sub-agent 可以回复 `ANNOUNCE_SKIP` 来跳过结果通知。

## 4. Orchestrator 模式（树状 fan-out）

不是"loop 回 decision"，而是深度控制的树状结构：

```
Main Agent (depth 0)
  ├── Sub-agent A (depth 1) ──announce──→ Main
  ├── Sub-agent B (depth 1) ──announce──→ Main
  │     └── Worker (depth 2) ──announce──→ Sub-agent B
```

配置：
```json5
{
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2,           // 允许 sub-agent 再 spawn（默认 1）
        maxChildrenPerAgent: 5,     // 每个 session 最多活跃子 agent
        maxConcurrent: 8,           // 全局并发上限
        runTimeoutSeconds: 900,     // 默认超时
      }
    }
  }
}
```

深度策略：
| 深度 | 角色 | 能否 Spawn |
|------|------|-----------|
| 0 | Main agent | 始终可以 |
| 1 | Orchestrator 或 leaf | 仅当 maxSpawnDepth >= 2 |
| 2 | Leaf worker | 不可以 |

## 5. 预算控制

不用 iteration count，用深度和超时：
- `maxSpawnDepth` — 最多几层嵌套
- `runTimeoutSeconds` — 单次执行超时
- `maxChildrenPerAgent` — 单 agent 并发子任务上限

超时是最可靠的安全网。

## 6. 对 pet-agent 的启发

### 6.1 收敛判断可以交给 LLM tool loop

不需要单独的 convergence controller / decision 节点。
route 节点看到 capability 返回的 messages 后自然能判断"够了"还是"继续"。

### 6.2 subagent status 应该是代码级的

`success | error | timeout` 而不是 LLM 自我评估的 `done | needs_more | blocked`。

### 6.3 不需要 summary 字段

父 agent 直接读子 agent 的 result 文本。LLM 本身就能理解文本内容。

### 6.4 保持简单

OpenClaw 的 loop 就是 LLM 原生行为：有工具就用，没工具就回复。
复杂的 planner state、convergence check、decision/respond 分离都不是必需的。

## 参考链接

- [Agent Loop](https://docs.openclaw.ai/concepts/agent-loop)
- [Sub-Agents](https://docs.openclaw.ai/tools/subagents)
- [Agent Runtime](https://docs.openclaw.ai/concepts/agent)
