# `@pinpawo/studio` 抽包可行性勘察

> **Status: historical record.** This page preserves earlier design or implementation context; it does not define current behavior. Start with [the current documentation map](../../index.md).

Tracking issue: #561

## 结论先行

**可行,且比原地重构干净。** 关键发现:

1. `agent/studio/**` 依赖的 pet-agent 符号**全部 25 个已经是公开导出** ——
   抽包**不需要 pet-agent 新增任何 export**(已用 tsc 编译验证)。
2. pet-agent 核心**没有任何模块反向依赖 studio**,只有 barrel `index.ts` 两处
   re-export。
3. `types/studio.ts` 只被 studio 代码和 barrel 消费,可整体搬走。
4. **抽包顺带修复一个既有架构违规**:pet-agent 号称 runtime-independent,但
   7 个用 `node:fs` 的文件里有 5 个是 Studio 代码。

---

## 1. 命名规范核对

| 目录 | 包名 |
| --- | --- |
| `packages/agent-contracts` | `@pinpawo/agent-contracts` |
| `packages/agent-session` | `@pinpawo/agent-session` |
| `packages/pet-agent` | `@pinpawo/pet-agent` |
| `services/tui` | `@pinpawo/tui` |
| `services/local-agent` | `pinpawo`(bin,唯一无 scope 的) |

规律:**`@pinpawo/<目录名>`,目录名与包名去 scope 后完全一致**。

因此新包应为 `packages/studio` → `@pinpawo/studio`。
`packages/pinpawo-studio` 会破坏这个规律(目录名带冗余前缀)。

---

## 2. 待搬迁清单

### 2.1 pet-agent → `@pinpawo/studio`

`packages/pet-agent/src/agent/studio/` 共 12 个实现文件 3766 行 + 测试 3045 行:

```text
createPetAgentRuntime.ts     263   ← Phase 2 要退役的私有 HITL 循环
createStudioOrchestrator.ts  995   ← 编排核心
types.ts                     308
runQueueStore.ts             319
dueRunScheduler.ts           338
dueRunContract.ts            159
fileDueRunStore.ts           355
planCapability.ts            217
wikiCurator.ts               386
wikiReadToolkit.ts           323
wikiReadCapability.ts         26
index.ts                      77
```

外加 `packages/pet-agent/src/types/studio.ts`(37 行)——
`PetAgentStatus` / `StudioAgent` / `StudioContext` 等纯 Studio 概念。

搬走后 pet-agent 里不应再出现 `studio` 这个词。

### 2.2 pet-agent 需要的改动(极小)

只有 `src/index.ts` 两处 re-export 需要删除(L375、L418 附近)。
**不需要新增任何 export** —— 见 §3。

---

## 3. 依赖边界:全部已公开

`agent/studio/**` 从 pet-agent 核心导入的**全部符号**,按来源模块:

| 来源模块 | 符号 | 是否已公开导出 |
| --- | --- | --- |
| `types/agent` | `AgentActor` `AgentExecution` `AgentModels` | ✅ |
| `types/capability` | `AgentCapability` `defineCapability` `defineInstructionDocument` | ✅ |
| `types/toolkit` | `AgentToolkit` `NamedStructuredTool` `ToolOperationMetadata` `defineToolkit` `filterAvailableToolkits` | ✅ |
| `utils/structuredOutput` | `StructuredOutputAutoRepairConfig` `StructuredOutputMethod` `invokeStructuredOutput` | ✅ |
| `createAgentRuntime` | `OrchestratorConfig` `OrchestratorGraph` `buildOrchestratorRunInput` `compileAgentRegistry` `createOrchestratorGraph` `formatExecutorCompilationIssues` | ✅ |
| `orchestrator/review/reviewSpec` | `HumanReviewInterruptPayload` `ReviewResponse` `isHumanReviewInterruptPayload` | ✅ |
| `orchestrator/toolkitRuntime` | `ToolkitRuntimeManager` | ✅ |
| `orchestrator/types` | `ActiveDelegationTransition` | ✅ |

**25/25 已经在 `@pinpawo/pet-agent` 公开入口可见。**

验证方式不是 grep,而是把这 25 个符号全部从 `@pinpawo/pet-agent` import 写成
一个 probe 文件放进 workspace 内 `tsc --noEmit` —— 零错误通过。

> 这条结论直接推翻了 Phase 0 审计 §2.2 的担忧。当时按"模块路径"判断,认为
> `createAgentRuntime` / `reviewSpec` 是必须小心的 shared 边界;实际上它们**早就
> 是公开 API**,Studio 作为外部包消费它们完全正常,不构成对 Chat 的侵入。

### 3.1 反向依赖:无

pet-agent 核心中除 barrel `index.ts` 外,**没有任何模块 import `agent/studio`**。
这意味着删除 studio 子树不会在核心留下空洞。

### 3.2 外部依赖

`agent/studio/**` 用到的第三方:`@langchain/core`(messages/tools/chat_models)、
`@langchain/langgraph`、`zod`。新包 `package.json` 直接声明这三个即可,
与 pet-agent 现有依赖一致,不引入新的第三方。

---

## 4. 顺带修复的架构违规

CLAUDE.md 规定 pet-agent 是 runtime-independent(不碰 FS/网络)。实际情况:

```text
pet-agent 中使用 node:fs 的文件(7 个)
├── agent/orchestrator/capabilityPlanner/documentWorkspace.ts   ← 非 Studio
├── agent/orchestrator/capabilityPlanner/workspaceReader.ts     ← 非 Studio
├── agent/studio/createPetAgentRuntime.ts                       ← Studio
├── agent/studio/fileDueRunStore.ts                             ← Studio
├── agent/studio/runQueueStore.ts                               ← Studio
├── agent/studio/wikiCurator.ts                                 ← Studio
└── agent/studio/wikiReadToolkit.ts                             ← Studio
```

**5/7 是 Studio 代码。** 抽包后 pet-agent 的 FS 耦合从 7 处降到 2 处,
更接近它声称的运行时无关性。

`@pinpawo/studio` 是否允许碰 FS 需要决定(见 §7 待定项)——
它管理 wiki 目录和 run queue 文件,天然是有状态的。

---

## 5. local-agent 侧:需要逐个评估,不一刀切

34 个文件提到 studio。按耦合密度和职责分三类:

### 5.1 Studio 逻辑 —— 候选搬迁

| 文件 | 行数 | 判断 |
| --- | --- | --- |
| `studio/studioRuntime.ts` | 233 | 装配逻辑;`buildStudioForTurn` 本身要被 host 取代 |
| `studio/studioConfig.ts` | 194 | studio.json schema + 校验;**读文件** |
| `studio/petConfig.ts` | 161 | pet.json schema + 校验;**读文件** |
| `studio/studioBridge.ts` | 116 | HITL 单槽桥;C1 要重做 |
| `studioRunService.ts` | 91 | 每请求装配,Phase 6 要删 |

### 5.2 宿主接线 —— 留在 local-agent

| 文件 | 判断 |
| --- | --- |
| `localServerStudioHandler.ts` | ws 消息路由,是传输层 |
| `localServerStudioReviews.ts` | ws review 路由 |
| `localStudioDueRunScheduler.ts` | 进程内定时器 + 宿主生命周期 |
| `serverMode.ts` | 启动路径(Phase 1 已落地,继续有效) |
| `commands/run.ts` `cli.ts` | CLI 入口 |
| `localConfigProjection.ts` `localServerTypes.ts` | 宿主配置投影 |

### 5.3 TUI 相关 —— 按 #232 处理,不属于本次抽包

`tui/**` 下 9 个文件(commandSubmit、render/text、statusBarModel 等)。
Phase 5 原计划收缩 Studio TUI,与抽包正交。

**配置文件读取的归属是主要待定项**:`studioConfig.ts` / `petConfig.ts` 的
**schema 与校验规则**是 Studio 概念(该进新包),但**读文件**是宿主职责
(该留 local-agent)。建议拆成 `parseXxx(raw)` 进新包 + `loadXxx(path)` 留宿主 ——
现有代码已经是这个形状(`parseStudioLocalConfig` / `loadStudioLocalConfig` 分离),
拆分成本很低。

---

## 6. 建议的依赖方向

```text
              agent-contracts
               ↑     ↑      ↑
       pet-agent  studio  agent-session
               ↑     ↑      ↑
              local-agent
```

- `@pinpawo/studio` 依赖 `@pinpawo/pet-agent` 的公开 API 与 `@pinpawo/agent-contracts`
- `pet-agent` **不**依赖 studio(删掉 barrel 的两处 re-export 后即成立)
- `local-agent` 同时依赖三者,负责宿主接线

---

## 7. 待定项(需要 owner 决定)

1. **`@pinpawo/studio` 是否允许碰 FS?**
   它天然管理 wiki 目录与 run queue 文件。两种选择:
   (a) 允许,新包定位为"有状态的 Studio 运行时";
   (b) 不允许,store 抽象成接口由 local-agent 注入实现。
   (b) 更干净但工作量大;(a) 与现状一致。
2. **配置 schema 与 loader 是否拆分**(§5.3)。
3. **抽包与 #561 各 Phase 的关系**:抽包本身是结构调整,Phase 2–4 的执行期
   契约问题(C1–C11)在新包内解决还是抽包前解决。建议**先抽包再改行为**,
   否则改完还要再搬一次。

---

## 8. 对既有产出的影响

- **Phase 0 审计文档**:§1(现状盘点)、§4(C1–C13 差距清单)仍然有效。
  §2 的"Studio-only / shared 分类"结论需要更新 —— 见 §3 的说明,当时高估了
  shared 边界的风险。
- **Phase 1(server mode + fail-fast)**:落在 local-agent 启动路径,抽包后
  依然成立,不需要回退。
- **`studio/studioApiContract.ts`**:应随 Studio 逻辑进新包。
