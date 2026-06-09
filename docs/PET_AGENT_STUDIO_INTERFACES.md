# Pet Agent Studio Interfaces

本文档描述 Studio 与 pet 之间(以及 pet 与 UI 之间)的接口边界。Studio 内部的循环、wiki 维护、turn state event 等是编排实现细节,见 `docs/PET_AGENT_STUDIO_ORCHESTRATOR_DESIGN.md`;整体架构理念见 `docs/PET_AGENT_STUDIO_ARCHITECTURE_OVERVIEW.md`。

## Boundaries

```text
┌──────────────────────────────────────────────────────────────┐
│  StudioOrchestrator                                          │
│   planner agent invoke → execute 状态机 → wiki_curator       │
│   维护 plan / turn state / wiki                              │
└──────────────────────────────────────────────────────────────┘
        │ Boundary 1: 函数调用(本文档主要内容)
        │ PetAgentRuntime.invoke({ brief, wikiRoot, signal, onToolEvent? })
        │  → Promise<{ reply }>
        ▼
┌──────────────────────────────────────────────────────────────┐
│  PetAgentRuntime (LangGraph)                                 │
│   单 pet ReAct + wiki middleware + capabilities + tools      │
│   持有: humanReviewer(构造时注入,HITL 桥)                 │
└──────────────────────────────────────────────────────────────┘
        │ Boundary 2: 工具事件回调(onToolEvent,通过 invoke 入参)
        │ Boundary 3: HITL 应答桥(humanReviewer,构造时注入)
        ▼
┌──────────────────────────────────────────────────────────────┐
│  UI(pet 面板)                                                │
└──────────────────────────────────────────────────────────────┘
```

边界 1 是 Studio 视角下的"pet 是什么"——一个普通函数。边界 2、3 是 pet runtime 与 UI 之间的两个 callback 桥(都是函数注入,不是独立信道);Studio 不参与路由。

## Boundary 1: Pet Invocation Contract

pet 是一个普通的异步函数。Studio 派发一棒任务等价于调用一次这个函数。

```ts
type PetInvokeArgs = {
  brief:         string;             // Studio 撰写的任务文本(自然语言)
  wikiRoot?:     string;             // 共享知识库目录的绝对路径
  signal?:       AbortSignal;        // Studio 取消信号
  threadId?:     string;             // checkpoint namespace,见下文
  onToolEvent?:  SubagentToolEventHandler;  // 边界 2,见下文
  // 其他运行时透传字段:execution / workdir / extraCapabilities
};

type PetInvokeResult = { reply: string };  // pet 最终返回的文本(可含文件路径引用)

interface PetAgentRuntime {
  invoke(args: PetInvokeArgs): Promise<PetInvokeResult>;
}
```

要点:

- **核心输入只有两件:任务文本 + wiki 根目录**。pet 自己的 capability/tool 配置、HITL 桥(`humanReviewer`)在 runtime 构造时已确定,不通过 invoke 传。
- **返回是一段文本**。文本中可以引用文件路径(`/…/cover.jpg`),curator 会解析并整理。
- **没有 envelope 结构**。Studio↔pet 是函数调用,不需要为协议层包装。
- **HITL 与工具事件走 pet runtime 自己的 UI callback 桥(边界 2、3)**,不通过 invoke 返回值;Studio 视角下,invoke 一直 pending 直到 pet 最终 resolve `{ reply }`(或抛错/取消)。

## Wiki Middleware

pet runtime 在 Studio 模式下注入 wiki middleware,收到 `wikiRoot` 后做两件事:

1. **读 `{wikiRoot}/index.md`**,把原文粘到 pet system prompt 前段。
2. **绑定 `wiki_read` toolkit**,把 wikiRoot 配进 toolkit 的根路径。

system prompt 注入示例:

```text
你可以访问一个共享知识库,根目录已在工具中配置好。下面是知识库的当前索引:

----- index.md -----
{index.md 原文}
--------------------

使用 wiki_read.cat / grep / find 等工具检索详情。
```

效果:

- pet 进入工作时已经知道 wiki 全貌,**不需要先 `ls` 或 `cat index.md` 来探路**。
- 省一次 LLM 调用 + 一次 tool 调用。
- index.md 的组织形态(列表、表格、目录树、段落)完全由 curator 决定——middleware 不解读,只透传。

middleware 是 Studio 模式下的标准配置;单 agent 模式不挂这个 middleware,pet 代码路径完全相同。

## Wiki Read Toolkit

```ts
type WikiReadToolkit = {
  ls:    (path?: string) => string;
  cat:   (path: string)  => string;
  grep:  (pattern: string, path?: string) => string;
  find:  (filter: { name?: string; ext?: string }) => string;
  head:  (path: string, n?: number) => string;
  tail:  (path: string, n?: number) => string;
};
```

约束:

- 所有操作以 wiki middleware 注入的 `wikiRoot` 为根,不允许越界访问。
- 命令白名单:`ls / cat / grep / find / head / tail`。
- read-only:不开放写、cd、删除。
- 多模态 pet 可加 `attach(path)` 扩展,把图/音频以多模态输入注入 LLM(由扩展名 / 文件内容决定类型)。

## Boundary 2: Tool Event Callback (`onToolEvent`)

pet runtime 调用 tool 时,把生命周期事件回传给调用方,供 UI 渲染"pet 在干什么"。**是一个 callback,不是独立的事件总线**——已经在 pet runtime 内部用 LangGraph 的 tool 节点钩子串通,调用方只需在 invoke 时传入。

```ts
type SubagentToolEvent =
  | { event: 'on_tool_start'; toolCallId?: string; name: string; input: unknown }
  | { event: 'on_tool_event'; toolCallId?: string; name: string; data: unknown }
  | { event: 'on_tool_end';   toolCallId?: string; name: string; output: unknown }
  | { event: 'on_tool_error'; toolCallId?: string; name: string; error: unknown };

type SubagentToolEventHandler = (event: SubagentToolEvent) => void | Promise<void>;

// 用法
runtime.invoke({
  brief, wikiRoot,
  onToolEvent: (event) => ui.renderToolEvent(event),
});
```

要点:

- 单一函数,无需 subscribe/unsubscribe。生命周期跟随 invoke。
- pet runtime 不假设 UI 形态:ws、SSE、TUI、进程内 Emitter,各上层自己适配。
- Studio 在派发 pet 时把上层的 `onToolEvent` 透传给 `pet.invoke()`(自身不消费内容)。

## Boundary 3: HITL Bridge (`humanReviewer`)

pet 内 tool 触发 `interrupt(...)`(由 toolkit 的 `policy.toolReview` 在调用前决定)。toolkit policy 返回 `ReviewSpec`，wrapper 生成 canonical `review` interrupt payload。Studio `humanReviewer` 桥只接收 canonical `HumanReviewInterruptPayload`，并直接转发 `ReviewSpec`。

```ts
type HumanReviewer = (request: HumanReviewInterruptPayload) => Promise<HumanReviewDecision>;

// 构造时注入
const pet = createPetAgentRuntime({
  models, actor, capabilities, tools,
  humanReviewer: async (request) => {
    // 这个闭包知道怎么找该 pet 的 UI session(ws / SSE / 进程内 promise / ...)
    return await uiSession.askReview(request);
  },
});
```

`HumanReviewDecision`(approve / edit / reject / respond)定义见 `packages/pet-agent/src/agent/orchestrator/humanReview.ts`。`HumanReviewInterruptPayload` / `ReviewSpec` 定义见 `packages/pet-agent/src/agent/orchestrator/review/reviewSpec.ts`。

流程:

```text
pet 内部 tool 调用:
  policy.toolReview.request(ctx) → ReviewSpec
  interrupt({ kind: "review", review, pendingAction? })  // LangGraph 暂停,checkpoint 写入

pet runtime invoke 循环:
  graph.invoke(...) 返回带 __interrupt__ 的 state
  → 调 humanReviewer(request) → 等 UI 答复
  → graph.invoke(Command({ resume: { decisions: [decision] } }), ...)
  → 检测仍有 __interrupt__ 则继续循环

最终返回:
  { reply: 文本 }  // Studio 看到的依旧是一个 Promise
```

要点:

- **桥是构造时注入,不是 invoke 入参**。同一 pet runtime 多次 invoke 共用同一桥(通常对应该 pet 的 UI session)。Studio 这一层完全不传 humanReviewer,也不感知。
- **invoke 对调用方是原子的**。HITL 在 pet runtime 内部循环消化,Studio 视角下 dispatch 只有 `running / finished / cancelled`,不引入 `awaiting_review`。
- **未注入 humanReviewer 又撞到 interrupt 时,invoke 会抛错**——明确失败,而不是静默吞掉。
- **审批触发由 toolkit policy 决定**,而非 LLM 现场判断。`requiresApproval` / `riskTags` 等静态元数据由 toolkit 自己消费。

## Cancellation

Studio 通过 `AbortSignal` 取消某次 invoke:

```text
Studio:
  controller.abort()
  → signal.aborted = true
  → pet runtime 检测到信号,abort LangGraph 执行
  → invoke() Promise rejects with AbortError
```

pet runtime 内部应在 LLM 调用 / tool 调用 / interrupt 等位置定期检查 signal。

## Multimedia Outputs

pet 输出文本可包含对文件路径的引用,例如:

```text
我已生成视频封面,保存在 /tmp/pet-output/cover-001.jpg。
建议尺寸 1920x1080,风格暖色调美食。
```

或采用约定标记(如 `@file:/tmp/...`)。curator 解析 pet 返回的文本,识别文件路径,把文件搬到 wiki 目录内,在对应 topic markdown 中以自然语言描述。

**类型 / 尺寸 / 风格等语义信息全部在文本里自然表达**,不引入结构化字段。curator 的整理逻辑由 curator prompt 自定义,见 orchestrator 文档。

## Future: 并行 Dispatch

并行场景下:

- Studio 可对多个 pet 同时调用 invoke,各自返回独立的 Promise。
- 每次 invoke 走独立的 thread + checkpoint namespace,互不影响。
- pet 端不感知是否被并行调用——每次都是一次独立的函数调用。
- Studio 在 fan-in 处 `Promise.all([...])` 等所有 pet 返回。
- 调度上的变化由 Studio 承担,**本文档定义的接口不需要变化**。

## Thread / Checkpoint Namespace

pet runtime 内部用 LangGraph checkpointer 保存执行状态(支持 HITL interrupt + resume)。namespace 约定:

```text
studio:{studioId}:thread:{conversationId}:pet:{petId}:dispatch:{dispatchId}
```

不同 pet、同一 pet 的不同 dispatch、未来的并行 dispatch 各自独立 namespace,状态不互相污染。

## 错误处理

```text
pet 抛 error 或 timeout:
  → invoke() Promise rejects
  → Studio 的 execute 状态机下一轮看到 error,
    据 task.retryCount 决定 retry(对同 taskIndex 再 dispatch)/ finish(若有可作交付的产出)/ stop。
```

retry 由 Studio 调度(execute 状态机再次输出 dispatch 同 taskIndex,dispatcher 自动 `retryCount++`),pet runtime 自身不负责 retry。

## MVP 范围

- pet runtime 实现 `PetInvokeArgs` 接口与 wiki middleware。
- `wiki_read` toolkit 在 Studio 模式下默认装备。
- Boundary 2(`onToolEvent`)已具备,调用方按需透传。
- Boundary 3(`humanReviewer`)已具备,由"持有 pet UI session 的那一层"在构造 pet runtime 时注入。
- Cancellation 用 AbortSignal。
- 并行 dispatch 留到 Phase 后续(接口已为之留出空间)。

## Open Questions

- 多媒体路径引用用约定标记还是纯自然语言识别?(curator prompt 可控)
- chat 层(目前用 ws stream + `__interrupt__` 直推客户端)是否最终也迁移到统一构造 pet runtime + 注入 humanReviewer 的模式?这是一个相对大的内务清理,见 [LangGraph 多 agent HITL 调研结论](#) 中提到的"a 的外壳 + b 的内核"思路。
- **tool event 是否升级为可靠的结构化源,`operation` 从它直接产生?** 现状:local-agent 运行链路已经从结构化源 `StreamToolsPayload` 直接产出 `operation`(`ToolOperationTracker -> buildToolOperationEvent`),TUI 本地路径和 app-facing WS 都不再双发旧运行态消息；chat 顶层 stream 也不再订阅 `tools` mode，operation 只从 `onToolEvent` 边界进入。pet-agent subagent 层会规范缺失的 `toolCallId`，并在自然完成、limit reached、异常时关闭仍 active 的 tool event。
  - `operation` 的质量上限取决于结构化源 `StreamToolsPayload`；subagent/local-agent 已补 stable id 和 terminal closure，底层 LangChain 原始事件仍可能存在顺序不确定。
  - `operation` 现在带 `phase` 生命周期,reducer 把 `activeOperations` 当权威 state;掉一个 end 就会让 `activeOperations` 永久泄漏——start↔terminal 的可靠配对从"美观"变成"正确性"。
  - 该源在 chat / studio 现在都通过 `onToolEvent` 进入 local-agent；pet-agent subagent 层和 local-agent 运行层都会为缺失 `toolCallId` 的事件补 synthetic id，并关闭仍 active 的 operation/tool event。

  目标方向:继续把底层结构化 tool 事件源做成**有序、原生稳定 callId**,`operation` 从它一次归一化产出。利好:客户端只认 `operation` 稳定形状,源侧调整可在不动客户端的前提下做。详见 `docs/LOCAL_AGENT_ARCHITECTURE_REFACTOR_PLAN.md` §5.0(stream→event 映射)。
