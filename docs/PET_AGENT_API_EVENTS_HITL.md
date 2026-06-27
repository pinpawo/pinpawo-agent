# 工具事件与 HITL API

## 1. 事件类型

```ts
type SubagentToolEvent =
  | { event: 'on_tool_start'; toolCallId?: string; name: string; input: unknown; operation?: SubagentToolOperationMetadata }
  | { event: 'on_tool_event'; toolCallId?: string; name: string; data: unknown; operation?: SubagentToolOperationMetadata }
  | { event: 'on_tool_end'; toolCallId?: string; name: string; output: unknown; operation?: SubagentToolOperationMetadata }
  | { event: 'on_tool_error'; toolCallId?: string; name: string; error: unknown; operation?: SubagentToolOperationMetadata }
  | { event: 'on_runtime_event'; name: string; data: unknown };

type SubagentToolEventHandler = (event: SubagentToolEvent) => void | Promise<void>;
```

### 调用语义

1. 事件发生在 single invoke 生命周期内按时间顺序回调。
2. 回调异常不应中断主任务执行（按当前实现，异常被吞掉）。
3. 典型用途：UI 渲染日志、执行轨迹、调试和计量。

## 2. HITL（人工审核）回调

```ts
type HumanReviewer = (request: HumanReviewInterruptPayload) => Promise<ReviewResponse>;
type HumanReviewerRequest = HumanReviewInterruptPayload;
```

### 关键语义

1. `HumanReviewer` 在 `createPetAgentRuntime` 配置阶段注入，不是 `invoke` 入参。
2. Graph 遇到 interrupt 时，runtime 循环：
   - 拿到 canonical request
   - `humanReviewer(...)`
   - 用返回结果 `resume` 继续
3. 未配置时遇中断直接抛错，`invoke` 不会静默返回。

## 3. 常见中断处理结果（`ReviewResponse`）

1. `approve`：继续执行
2. `reject`：终止或回退（由策略决定）
3. `edit`：带修正输入继续
4. `respond`：带附加 `input` 的应答

## 4. 典型集成模式

### 4.1 UI 直接回调

`Local Agent` 通常在构造 runtime 时注入闭包，闭包查到对应会话后弹窗或等待输入。

### 4.2 接口约定

1. 上层需要自行管理中断会话映射（threadId / session / task 维度）。
2. `invoke` 仍是一个 Promise，业务层看到的是 running -> resolved/rejected。

## 5. 相关文档

1. `PET_AGENT_STUDIO_INTERFACES` 的 Boundary 2/3
2. `packages/pet-agent/src/agent/studio/types.ts` 与 `packages/pet-agent/src/agent/studio/createPetAgentRuntime.ts`
