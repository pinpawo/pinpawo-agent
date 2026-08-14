# Studio 抽包迁移计划

> **Status: historical record.** This page preserves earlier design or implementation context; it does not define current behavior. Start with [the current documentation map](../../index.md).

Tracking issue: #561
前置勘察: [STUDIO_PACKAGE_EXTRACTION_FEASIBILITY.md](package-extraction-feasibility.md)

## 0. 目标与非目标

**目标**:把 Studio 概念从 `pet-agent` 中彻底移出,让 Studio **重新实现**在自己的
包里,而不是在 pet-agent 内部原地改造。

**非目标**:本次不修 C1–C11 那些执行期契约问题(单槽 review、私有 HITL 循环、
capacity/lease)。**先抽包再改行为** —— 否则改完还要再搬一次。

**兼容口径**:Studio 与旧 Ink TUI **都不做兼容**。该删的直接删,不保留别名、
不设过渡期。Chat 保护区不受此影响 —— 那是 issue 明确的保护面。唯一的例外是
chat 也在用的共享入口(如 `run` 命令),见 Phase 1。

---

## 1. 包结构

```text
packages/studio            @pinpawo/studio              编排核心
toolkits/studio-kanban     @pinpawo-toolkit/studio-kanban  看板:任务队列 + 知识库
```

命名依据:仓库既有规律是 `packages/<x>` → `@pinpawo/<x>`,
`toolkits/<x>` → `@pinpawo-toolkit/<x>`(见 `toolkits/browser`)。

### 1.1 依赖方向:studio 不依赖 kanban

```text
        agent-contracts
         ↑      ↑      ↑
   pet-agent  studio  agent-session
         ↑      ↑  ↑
         │      │  └──────── studio-kanban ──> pet-agent
         └──── local-agent ────────┘
```

- `@pinpawo/studio` **只声明 port**(需要一个能读写 queue / wiki 的东西),
  不 import kanban。
- `@pinpawo-toolkit/studio-kanban` 提供一个具体实现,与 browser toolkit 同构。
- **local-agent 负责把两者接起来**。

这样看板可以有多种实现(文件、S3、DB),换实现不用动编排核心。

---

## 2. `@pinpawo/studio` —— 编排核心

### 2.1 内容

来自 `packages/pet-agent/src/agent/studio/`:

```text
createStudioOrchestrator.ts   995   编排核心
types.ts                      308   + pet-agent/src/types/studio.ts (37)
dueRunScheduler.ts            338   调度
dueRunContract.ts             159
planCapability.ts             217   planner capability
createPetAgentRuntime.ts      263   ← 见 §2.3,不是简单搬运
```

外加 local-agent 的 Studio 逻辑:

```text
services/local-agent/src/studio/studioApiContract.ts   协议形状(Phase 1 产出)
services/local-agent/src/studio/studioBridge.ts        HITL 桥(要重做,见 C1)
```

### 2.2 依赖边界:零新增 export

勘察已用 tsc probe 编译验证:`agent/studio/**` 用到的 **25 个 pet-agent 符号
全部已公开导出**。`@pinpawo/studio` 依赖 `@pinpawo/pet-agent` 的公开 API 即可,
**pet-agent 不需要为抽包新增任何 export**。

### 2.3 `createPetAgentRuntime` 的处置

这个文件**不做原样搬运**。它包含 #561 Phase 2 要退役的私有
`while(true) { graph.invoke(); Command({resume}) }` HITL 循环。

抽包时先原样搬过去让编译通过,但标注为**待退役**;Phase 2 用"复用稳定 Chat
runtime"的实现替换它。搬包阶段不改行为,避免一次 PR 里混两件事。

### 2.4 需要声明的 port

`@pinpawo/studio` 对外声明它需要什么,不关心谁实现:

**已经是干净 port 的**(直接搬,无需改造):

```ts
// runQueueStore.ts 里已有的形状
export type StudioRunQueueStore = {
  clear(): void;
  save(snapshot: StudioRunSnapshot): StudioRunSnapshot;
  get(runId: string): StudioRunSnapshot | null;
  list(): StudioRunSnapshot[];
  recoverOpenRuns(options?): StudioRunSnapshot[];
};
```

`FileStudioRunQueueStore` 是它的一个实现 → 搬去 kanban。
`FileDueRunStore` 同理。

**需要新建 port 的**:wiki 侧目前用裸 `wikiRoot: string` 到处拼路径
(`wikiCurator.ts` / `wikiReadToolkit.ts`),是硬 FS 耦合。需要抽成:

```ts
export type StudioWikiStore = {
  ensureSkeleton(): Promise<void>;
  read(relPath: string): Promise<string | null>;
  write(relPath: string, content: string): Promise<void>;
  list(relPath: string): Promise<string[]>;
};
```

具体方法集以现有 `wikiCurator` / `wikiReadToolkit` 的实际调用点为准,
抽包时按真实用量确定,不预先设计冗余接口。

---

## 3. `@pinpawo-toolkit/studio-kanban` —— 看板

### 3.1 内容

```text
wikiCurator.ts        386   wiki 整理(LLM 驱动)
wikiReadToolkit.ts    323   wiki_read_* 工具
wikiReadCapability.ts  26
runQueueStore.ts      319   ← FileStudioRunQueueStore 实现部分
fileDueRunStore.ts    355
```

### 3.2 与 browser toolkit 同构

照 `toolkits/browser` 的形状:

- `defineToolkit({ name, description, availability, tools, runtime })`
- runtime 有 `start()` / `resolve()` / `bindTools()` 生命周期
- 允许碰 FS(toolkit 本来就是碰机器的那一层)
- `package.json` 依赖 `@pinpawo/pet-agent` + `@langchain/*` + `zod`,与 browser 一致

### 3.3 为什么叫 kanban 而不是 wiki

它同时管**任务队列**和**知识库** —— 看板正好覆盖这两件事。
名字说的是"这个 toolkit 干什么",而不是"studio 的那堆东西"。

---

## 4. pet-agent 的改动

### 4.1 删除

- `src/agent/studio/` 整个目录
- `src/types/studio.ts`
- `src/index.ts` 中两处 `from './agent/studio/index'` 的 re-export(L375、L418)

删完之后 **pet-agent 里不应再出现 `studio` 这个词**,这是抽包完成的验收信号。

顺带:pet-agent 的 `node:fs` 使用者从 7 个降到 2 个
(5 个是 Studio 代码),更接近它声称的 runtime-independent。

### 4.2 新增:通用 config loader(不碰 FS)

pet-agent 目前**没有**通用 config loader。新增一个,提供**机制**而非具体配置:

```ts
// 接收已读出的内容,不碰 FS
export function parseConfigDocument<T>(input: {
  /** 已由调用方读出的原始文本 */
  content: string;
  /** 仅用于错误信息,不用于读取 */
  source: string;
  schema: ConfigSchema<T>;
}): T;
```

职责划分:

| 关注点 | 归属 |
| --- | --- |
| JSON 解析、schema 校验、**统一报错格式** | pet-agent(机制) |
| schema 定义 | 各自的包(chat 的在 pet-agent/local-agent,studio 的在 `@pinpawo/studio`) |
| **文件入口**(去哪读、读哪个文件) | 各自的宿主 |

这样 studio 的 workdir 配置入口可以和 chat 完全不同,但解析行为、校验语义和
报错格式保持一致。chat 也不会被 studio 的配置复杂度污染。

现有 `studioConfig.ts` / `petConfig.ts` 已经是 `parseXxx(raw, source)` +
`loadXxx(path)` 分离的形状,改造成本低:`parseXxx` 的 schema 部分进
`@pinpawo/studio`,`loadXxx` 留 local-agent。

---

## 5. local-agent 的改动

按职责分三类,**不一刀切**:

### 5.1 搬进 `@pinpawo/studio`

- `studio/studioApiContract.ts` — 协议形状
- `studio/studioConfig.ts` / `studio/petConfig.ts` 的 **schema 部分**

### 5.2 留在 local-agent(宿主接线)

- `localServerStudioHandler.ts` / `localServerStudioReviews.ts` — ws 传输层
- `localStudioDueRunScheduler.ts` — 进程内定时器 + 宿主生命周期
- `serverMode.ts` / `commands/run.ts` / `cli.ts` — 启动路径(Phase 1 已落地,继续有效)
- `localConfigProjection.ts` / `localServerTypes.ts` — 宿主配置投影
- `studioConfig.ts` / `petConfig.ts` 的 **loadXxx(path) 部分** — 文件入口
- `studioRuntime.ts` / `studioRunService.ts` — 装配,最终被 host 取代

### 5.3 TUI:旧 TUI 不做兼容

仓库里有**两套 TUI**:

| 位置 | 是什么 | 规模 | Studio 引用 |
| --- | --- | --- | --- |
| `services/local-agent/src/tui/` | 旧 Ink 客户端(`pinpawo tui --legacy`) | 110 文件,23 个 import `ink` | 11 个文件 |
| `services/tui/` (`@pinpawo/tui`) | OpenTUI v2(`pinpawo tui --v2`) | — | 10 个文件 |

**口径:旧 TUI 不做兼容。** 与"Studio 不做兼容"同一条原则 —— 旧 TUI 里的
Studio 引用**直接删,不迁移、不保留别名、不做过渡期**。

具体到抽包:

- 旧 Ink TUI(`services/local-agent/src/tui/**`)中的 Studio 相关代码
  (`commandSubmit` 的 `/studio`、`render/text` 的 Studio 文案、
  `tuiState` 的 studio 分支等)**直接移除**,不随抽包迁往新包。
- v2 TUI(`services/tui/**`)按 #232 的节奏走;它消费的是公开 API,
  抽包后改 import 来源即可。

这条同时简化了 #561 Phase 5 —— 原计划"Studio TUI 收缩为状态与诊断",
在旧 TUI 上不再需要,因为它整体不做兼容。

---

## 6. 实施顺序

每步结束都要 `npm run typecheck && npm test` 全绿。

| 步 | 内容 | 说明 |
| --- | --- | --- |
| 1 | 建 `packages/studio` 骨架 + workspace 注册 | ✅ 已完成 |
| 2 | 搬编排核心(orchestrator/types/scheduler/planCapability) | ✅ 已完成;顺带抽出 wiki/runQueue port |
| 3 | 建 `toolkits/studio-kanban`,搬 wiki + store 实现 | ✅ 已完成 |
| 4 | pet-agent 删 studio 子树与 barrel re-export | ✅ 已完成 |
| 5 | pet-agent 新增通用 config loader,studio schema 迁移 | ✅ 已完成 |
| 6 | local-agent 改为消费两个新包,宿主接线保留 | ✅ 已完成(与第 4 步同 PR) |
| 7 | 删除旧 Ink TUI 中的 Studio 引用 | ✅ 已完成 |

**抽包 7 步全部完成。**

第 5 步的落地形态与 §4.2 的设计一致:机制在 pet-agent 且不碰 FS
(`utils/configDocument`),schema 在 `@pinpawo/studio`(`configSchema.ts`),
文件入口留 local-agent。local-agent 侧两份 loader 从 355 行降到 94 行。

步 2–4 是一次完整的搬迁,中途 pet-agent 会同时存在新旧两份;步 4 收尾。

---

## 7. 对既有产出的影响

- **Phase 0 审计**:§1(现状盘点)、§4(C1–C13)仍有效。§2 的分类结论已被
  勘察修正 —— 当时按模块路径高估了 shared 边界风险,实际 25 个符号全是公开 API。
- **Phase 1(server mode + fail-fast)**:落在 local-agent 启动路径,抽包后
  继续成立,**不回退**。
- **`studioApiContract.ts`**:随 Studio 逻辑进 `@pinpawo/studio`。

---

## 8. 验收

- [ ] `packages/pet-agent/**` 中不再出现 `studio`(大小写不敏感)
- [ ] pet-agent 的 `node:fs` 使用者从 7 降到 2
- [ ] `@pinpawo/studio` 不 import `@pinpawo-toolkit/studio-kanban`
- [ ] pet-agent 未为抽包新增任何 export
- [ ] chat 模式的配置复杂度未因 studio 增加
- [ ] 旧 Ink TUI(`services/local-agent/src/tui/**`)中不再有 Studio 引用
- [ ] `npm run typecheck && npm test` 全绿
- [ ] Chat 回归基线(见 Phase 0 审计 §3)未受影响
