# Studio 配置

> **状态：当前本地宿主配置。** schema 位于
> [`configSchema.ts`](../../../packages/studio/src/configSchema.ts)，装配位于
> [`buildStudio.ts`](../../../packages/studio/src/host/buildStudio.ts)。

[English](../../studio/configuration.md)

契约：[Studio 推模型](push-model.md) ·
[`studioContract.ts`](../../../packages/studio/src/studioContract.ts)

本文用**配置**表达契约的实际形状 —— 抽象类型不足以暴露契约在真实使用中
是否顺手,配置能。

下面的字段与装配流程都对应现有代码。

---

## 1. `studio.json`

位置:`<workdir>/.pinpawo/studio.json`。

```jsonc
{
  "studioId": "content-studio",   // 必填
  "name": "内容工作室",            // 可选
  "description": "写稿 / 校对流水线",  // 可选

  // 外部输入默认派给谁。它就是一次普通 dispatch ——
  // planner 只是恰好扮演拆解角色的 pet,在契约里没有特殊地位。
  "entryPetId": "planner",

  // 这个 studio 有哪些 pet 可供派活。必填,不可为空。
  "pets": ["planner", "writer", "reviewer"],

  // 装哪些插件 —— **必须显式列出**,studio 不做任何隐式装配。
  // 顺序即 start 顺序(插件之间可能有依赖);stop 时逆序。
  //
  // id 由应用 composition root 的 Plugin resolver 解析。
  "plugins": [
    { "id": "kanban" }
  ]
}
```

`plugins[].options` 会原样传给 Plugin resolver，再由 Plugin 自己解释与校验。
Studio package 不含内置 Plugin registry，也不 import kanban 或 scheduler。

`plugins` 可省略 —— 那样这块 studio 没有任何驱动方,只能由宿主手动
`dispatch`。这是合法的,但通常意味着配漏了。

装配时会校验(全部直接抛错,不静默跳过):

| 情况 | 报错 |
| --- | --- |
| `pets` 为空 | `"pets" must not be empty` |
| `pets` 里有重名 | `pets array has duplicate petId "…"` |
| `entryPetId` 不在 `pets` 里 | `entryPetId "…" is not in pets` |
| `pets` 里的名字没有对应的 `pets/<petId>.json` | `pet "…" has no matching pet config…` |
| 配了 Plugin 但宿主未安装 resolver | `plugin "…" is configured but no plugin resolver is installed` |

同一个 Plugin id 可以用不同 options 配置多次；resolver 返回的每个 Plugin 实例仍必须
具有唯一 `name`，因为它是 Studio 内部的生命周期与 event source 标识。

### 1.1 这里不该出现什么

`studio.json` 只描述**这块 studio 由谁组成、由什么驱动**。任务、依赖、进度、
迭代上限、重试策略都是插件的领域,不在这里配 —— 它们属于对应插件的
`options`,或者根本不存在(如自动重试,见契约 §2.2)。

同理,`entryPetId` 只是外部输入的默认目标,不代表 planner 有任何特殊地位。

> 注意 `studio.json` **不校验多余字段**:`plannerPetId` / `agents` /
> `curator` / `maxIterationCount` / `maxRetryPerTask` 这些旧字段留在文件里
> 不会报错,只是被忽略 —— 照着它们配会得到一块"配了却不生效"的 studio。
> (`pets` 是必填的,所以只写 `agents` 的旧配置会因为缺 `pets` 而失败。)

---

## 2. `pets/<petId>.json`

位置:`<workdir>/.pinpawo/pets/<petId>.json`。

```jsonc
{
  "petId": "writer",           // 必填
  "name": "撰稿",              // 必填
  "role": "把提纲写成完整稿件",
  "serviceSummary": "长文写作、结构化改写",
  "modelProfileId": "qwen-max"  // 省略则用宿主默认 profile
}
```

`petId` 同时用于推导 Capability 目录，所以必须是安全的单个路径段。`general`
仍由 Agent Host 作为 baseline 自动提供。旧的 `capabilities` 名称列表和 `model`
字段都会显式报迁移错误，不会被静默忽略。

### 2.1 `pets/<petId>/capabilities/`

目录成员就是该 Pet 的 Capability 选择，不需要额外配置目录或名称列表：

```text
<workdir>/.pinpawo/pets/writer/capabilities/
├── explore/
│   └── CAPABILITY.md
└── studio-planning/
    └── CAPABILITY.md
```

每个直接子目录都必须是有效的 Capability 目录。损坏文档或同一 Pet 内的重名会让
Host 启动失败。目录 symlink 是允许的，因此多个 Pet 可以复用同一份 Capability，
不必复制。Capability 名以 Pet 为作用域：不同 Pet 可以拥有同名但内容不同的定义。

`studio_planning` 的 `CAPABILITY.md` 声明 `uses: ['kanban']`，但它仍完全属于
Agent。Kanban Plugin 只定义对应 Toolkit，不注册或携带 Capability。

仓库中的 `packages/studio/examples/kanban-workdir/` 提供了一份完整目录示例。

`model` 字段已被 `modelProfileId` 取代,**继续使用会显式报错**而不是静默
忽略 —— 否则 pet 会悄悄跑在默认 profile 上。

### 2.2 Toolkit 不在 Pet 配置里

Plugin 定义的 Toolkit 先进入 Host 的统一 Toolkit inventory：

```ts
await capabilityAssembly.init({
  toolkitSources: plugins.map((plugin) => ({
    id: `studio-plugin:${plugin.name}`,
    kind: 'plugin',
    definitions: plugin.toolkits,
  })),
});
```

pet 能不能真的用到 `kanban_task_*`,由**它的 capability 怎么声明 `uses`**
决定 —— capability 说自己要哪些 toolkit,不是 pet 配置说的:

```text
capability.uses: ['kanban']   ← 能力声明它需要这个 toolkit
        ↓
该 Capability 位于 pets/<petId>/capabilities/  ← 目录成员就是选择
        ↓
toolkits 全量注入,由 uses 筛出这个 pet 实际拿到的工具
```

`kanban` 是 Toolkit 名，只应出现在 Capability 的 `uses` 中。

**关键:pet 侧看不出"插件"这个概念。** 它只知道自己有某个能力,而那个能力
恰好用到了看板工具。至于看板同时也在驱动 studio 派活,与 pet 无关。

Plugin 高于 Toolkit：它在 Studio 中是驱动方，同时可以定义 Agent 使用的 Toolkit，
但 Plugin 本身从不作为 Toolkit 传给 Pet。

---

## 3. 装配

宿主先解析配置与 Plugin，再初始化统一 Toolkit inventory，最后构建 resident Pet:

```ts
const configuration = await resolveStudioHostConfig({ resolvePlugin });
await capabilityAssembly.init({
  toolkitSources: pluginToolkitSources,
});
const studio = await buildStudio({
  configuration,
  toolkits: capabilityAssembly.getToolkitInventoryStore()
    .getSnapshot().effectiveToolkits,
  hostCapabilities: hostBaselineCapabilities,
  petCapabilities: capabilitiesLoadedFromPetDirectories,
  // ...models/checkpoint
});
```

`createStudio` 只做三件事:

1. 建 pet registry(重复 petId、`entryPetId` 不在 `pets` 中都会报错);
2. 依次 `await plugin.start(context)`,把 `dispatch` / `onInvocation` /
   `notify` / `subscribe` / `listPets` 交给它;
3. 返回插板。

**它是 `async` 的** —— 插件启动失败必须让调用方看见。一个没起来的驱动器
意味着这块 studio 不会派活,静默吞掉会变成"提交了但什么都没发生"。

`createStudio` 不读配置文件；`@pinpawo/studio` 的 Host 层负责 workdir 文件与 runtime
装配，core contract 保持 transport/filesystem 无关。

### 3.1 `plugins[].id` 怎么解析

Studio Host 接收外部 resolver:

```ts
const resolvePlugin: StudioPluginResolver = (id, options) =>
  installedPlugins.resolve(id, options);

const host = new StudioHost({
  resolvePlugin,
});
```

`options` 原样传给 resolver。未安装或不认识的 id 必须 fail fast，不能静默跳过。
`studio-kanban` 自己拥有 Kanban Plugin 与 Toolkit 实现；依赖方向是
Plugin package → Studio contract，不是 Studio → Kanban。`studio_planning`
Capability 由对应 Pet 的约定目录独立提供。

Plugin 定义的 Toolkit 与其他 Toolkit 来源一起进入 Host inventory:

```ts
const availableToolkits = hostInventory.effectiveToolkits;
```

pet 实际拿到哪些工具,由它目录中 Capability 声明的 `uses` 筛出来 —— 见 §2.2。

> Studio 继续只声明 `StudioPluginResolver` port，不持有具体 Plugin catalog。
> Plugin 的安装/discovery 策略仍由外部装配者负责。

Plugin 的持久化状态仍由 Plugin 自己拥有。例如，应用 resolver 可以构造
`createKanbanPlugin({ stateStore: createFileKanbanStateStore(...) })`，并选择
`<workdir>/.pinpawo/studio/<plugin-instance>/kanban.json` 这样的绝对路径。Studio
既不推导该路径，也不读取 snapshot；没有注入 state store 时，同一个 Plugin 明确
以纯内存方式运行。

---

## 4. 一个完整回合

用配置串一遍,验证契约是否自洽:

```text
1. 宿主 dispatch({ petId: entryPetId,
                    input: { kind: "request", request: "写一篇关于 X 的稿子" } })
       ↓  返回 { threadId, invocationId, completion },立即确认
2. planner 排进它自己的队列;轮到它就跑,调 kanban toolkit 贴了三张任务
       ↓
3. kanban 插件感知到自己的领域数据变了(它订阅的是自己的 board)
       ↓
4. kanban 调 context.dispatch({ petId: "writer",
                                input: { kind: "request",
                                         request: "Kanban taskId: task-1\n..." } })
       ↓  排进 writer 的 active invocation 队列
5. writer 干完,调用 kanban_task_complete({ taskId: "task-1", result: "..." })
       ↓  看板状态变了 —— 这是 kanban 得知完成的**唯一**途径
6. writer invocation completed → studio 放行这个 pet 的下一条
       ↓
7. kanban 调 context.notify({ type: "task.done", payload: { taskId: "task-1" } })
       ↓
8. studio 广播 → 别的插件若订阅了就能看到
       ↓
9. kanban 看到 task-1 完成,依赖满足,dispatch task-2……
```

**验证点:**

- 第 1 步只是确认；调用方可选地观察 invocation event 或 completion
- 第 3 步的"感知"是插件内部的事,契约不规定它怎么实现
- 第 5 步是闭环的关键:pet 调 toolkit,数据落在插件自己的状态里
- 第 6 步只按 active invocation 串行；durable interrupt 会作为一种终态结束本次 invocation
- 第 7 步 studio 只广播,不解释 `task.done` 是什么意思
- 全程 pet 从未直接与 studio 通信

### 4.1 卡住的时候

第 5 步若 writer 请求一个必须人工确认的操作:

```text
5'. LangGraph 创建 interrupt,把 pending continuation 写入 checkpoint
       ↓
6'. 当前 invocation 以 pending_interrupt 结束；checkpoint 保持 waiting
       ↓
7'. 独立交互 plugin/Host adapter 把 pending action 作为 event 告知用户层
       ↓
8'. 用户授权后,交互 adapter 对同一个 pet 发起 typed resume dispatch
       ↓
9'. 新 invocation 在同一个稳定 thread 上 resume
```

Studio core 不解释 review 选项；Pet runtime 负责投射 pending、校验 response 和构造
resume Command。waiting/interrupt 由 LangGraph checkpoint 持久化,不依赖 Chat Host
内存；没有交互 Plugin 时，Pet thread 可以一直停在 checkpoint 上，但不会占住一次
内存 invocation。

> **看板上目前看不出来。** Plugin 可以经 `context.onInvocation` 订阅自己派出去
> 那些 invocation 的 `pending_interrupt` / `failed` 终态并标到任务上 —— 但 kanban
> **尚未接上这条**,它现在只从 pet 调 `kanban_task_*` 得知进展。要不要标、
> 怎么标,是 kanban 的领域判断。

---

## 5. 三条约定

1. **插件必须显式配置。** studio 不做隐式装配 —— 读一眼 `studio.json` 就知道
   这块 studio 由什么驱动。
2. **插件 options 的校验归插件自己。** studio 与宿主都原样透传不解释。
3. **entry pet 没有特权。** 它只是 `dispatch` 的一个默认目标,契约里不存在
   专属的提交入口。

## 6. 开放问题

1. **第三方插件从哪加载。** 目前只有宿主的内置注册表。
2. **插件状态的落盘位置。** `KanbanBoard` 只活在内存里,进程重启看板归零;
   scheduler 会面对同一个问题。大概是
   `<workdir>/.pinpawo/studio/<plugin-id>/`,但这属于宿主约定,不进契约。
