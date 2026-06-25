# Pet Agent Studio Interfaces

本文档描述 Studio 与 pet 之间，以及 pet 与 UI 之间的接口边界。Studio 的内部循环、wiki 维护和 turn 事件是编排实现细节；持久产物参见 `docs/PET_AGENT_CAPABILITY_ARTIFACT_STORE_DESIGN.md`。

## Boundaries

```text
┌──────────────────────────────────────────────────────────────┐
│  StudioOrchestrator                                          │
│   planner agent invoke → queue runner → wiki_curator          │
│   维护 run / task / wiki / turn state event                    │
└──────────────────────────────────────────────────────────────┘
        │ Boundary 1: 函数调用
        │ PetAgentRuntime.invoke({ brief, wikiRoot, signal, ... })
        │  → Promise<{ reply }>
        ▼
┌──────────────────────────────────────────────────────────────┐
│  PetAgentRuntime (LangGraph)                                 │
│   单 pet ReAct + wiki middleware + capabilities + tools      │
│   持有: humanReviewer(构造时注入, HITL 桥)                  │
└──────────────────────────────────────────────────────────────┘
        │ Boundary 2: 工具事件(onToolEvent,通过 invoke 入参)
        │ Boundary 3: HITL 应答桥(humanReviewer,构造时注入)
        ▼
┌──────────────────────────────────────────────────────────────┐
│  UI(pet 面板)                                                │
└──────────────────────────────────────────────────────────────┘
```

Boundary 1 是 Studio 视角下的“pet 是什么”——一个普通函数。Boundary 2/3 是 pet runtime 与 UI 的 callback 桥（都是函数注入，不是独立信道）。Studio 不参与它们的路由。

## Boundary 1: Pet Invocation Contract

pet 派发一棒任务，本质是一次函数调用。

```ts
import type {
  SubagentToolEventHandler,
  AgentExecution,
  AgentToolkit,
  AgentCapability,
} from '@pinpawo/pet-agent';

type PetInvokeArgs = {
  brief: string;                    // Studio 撰写的任务文本
  wikiRoot?: string;                // 共享知识库路径
  signal?: AbortSignal;             // Studio 取消信号
  threadId?: string;                // checkpoint/thread namespace
  execution?: AgentExecution;
  workdir?: string;                 // 执行上下文工作目录
  runtimeEnvironment?: string;       // 可选 runtime prompt 叠加
  onToolEvent?: SubagentToolEventHandler;
  toolkits?: AgentToolkit[];
  extraCapabilities?: AgentCapability[];
  forcedCapabilityNames?: string[];
};

type PetInvokeResult = {
  reply: string;
};

interface PetAgentRuntime {
  invoke(args: PetInvokeArgs): Promise<PetInvokeResult>;
}
```

要点:

- pet 运行时不接收 `artifactRefs` / `artifacts` 作为入参。
- 同一 run 的历史 `CapabilityArtifactRef` 会通过上下文注入到 prompt（如 `capabilityArtifacts` 片段）。
- 返回值是纯文本；长期产物只在 `CapabilityArtifactRef` 内传递。
- HITL 与工具事件都通过 callback 注入，不依赖返回值。
- `invoke()` 对上层是原子的：Studio 只在 Promise resolve 时拿到最终文本（或抛错/取消）。

## Wiki Middleware

pet runtime 在 Studio 模式下会注入 wiki middleware：

1. 读取 `{wikiRoot}/index.md` 并前置到 system prompt。
2. 挂载 `wiki_read` toolkit（`ls / cat / grep / find / head / tail`，只读）。

system prompt 片段示例:

```text
你可以访问一个共享知识库,根目录已在工具中配置好。下面是知识库的当前索引:

----- index.md -----
{index.md 原文}
--------------------

使用 wiki_read 工具检索详情。
```

效果:

- pet 进入工作时已知会话背景，不需要先探索 index。
- index.md 组织方式由 curator 决定；middleware 仅透传。

## Wiki Read Toolkit

```ts
type WikiReadToolkit = {
  ls: (path?: string) => string;
  cat: (path: string) => string;
  grep: (pattern: string, path?: string) => string;
  find: (filter: { name?: string; ext?: string }) => string;
  head: (path: string, n?: number) => string;
  tail: (path: string, n?: number) => string;
};
```

约束:

- 工具仅允许在 wikiRoot 内访问。
- 只读命令，不提供写和删除。
- 命令白名单: `ls / cat / grep / find / head / tail`。

## Artifact Boundary

capability 产物不直接依赖 `wiki`，也不依赖 `ToolMessage.artifact` 长期存在。Studio / pet runtime 在能力执行结束时写 `CapabilityArtifactStore`，返回 `CapabilityArtifactRef`。

`CapabilityArtifactRef` 参考 `@pinpawo/pet-agent` 导出（见 `types/artifact.ts`）。

边界规则:

- `ToolMessage.artifact` 仅作为临时结构化回执，不能作为 store 边界。
- pet 侧 `invoke` 返回不再带 `artifacts`。
- `studio` 与 `UI` 的稳定交互只依赖 ref；内容通过 `store` 或专用 read tool 按需读取。

## Boundary 2: Tool Event Callback (`onToolEvent`)

```ts
type SubagentToolEvent =
  | { event: 'on_tool_start'; toolCallId?: string; name: string; input: unknown }
  | { event: 'on_tool_event'; toolCallId?: string; name: string; data: unknown }
  | { event: 'on_tool_end';   toolCallId?: string; name: string; output: unknown }
  | { event: 'on_tool_error'; toolCallId?: string; name: string; error: unknown };

type SubagentToolEventHandler = (event: SubagentToolEvent) => void | Promise<void>;

runtime.invoke({
  brief, wikiRoot,
  onToolEvent: (event) => ui.renderToolEvent(event),
});
```

- 单一 callback,生命周期跟随 invoke。
- pet runtime 不假设 UI 形态（ws、SSE、TUI、进程内）
- Studio 将回调透传给 `pet.invoke()`，自身不消费细节。

## Boundary 3: HITL Bridge (`humanReviewer`)

tool policy 触发审核后，工具 wrapper 会抛出 `HumanReviewInterruptPayload`，pet runtime 会通过 `humanReviewer` 桥等待 UI 决策，并在图中恢复。

`invoke()` 对调用方仍是原子行为：要么拿到最终 `reply`，要么抛错。

## Cancellation

```text
Studio:
  controller.abort()
  → signal.aborted = true
  → pet runtime 检测信号并终止
  → invoke() Promise rejects with AbortError
```

`execute` 图中应定期检查 signal。

## Artifact-Ready Outputs

pet 输出文本可直接引用 artifact 标识（例如 `@artifact:<id>`）或文件路径，但推荐先写入 artifact store，再通过 reference 组织输出；UI/curator 解析后再做人类阅读展示。

## Queue Before Worker

- planner 先输出有序任务队列。
- runner 逐项调用 `PetAgentRuntime.invoke(...)`。
- 每个 pet 调用为独立上下文，互不影响。
- 同步入口 `submitRequest()` 可快速返回，`waitForRun()` 可等待完成。
