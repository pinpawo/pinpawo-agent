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
  // id 由应用 composition root 的 optional module resolver 解析。
  "plugins": [
    { "id": "kanban" }
  ]
}
```

`plugins[].options` 会原样传给 module resolver，再由 module 自己解释与校验。
Studio package 不含内置 module registry，也不 import kanban 或 scheduler。

`plugins` 可省略 —— 那样这块 studio 没有任何驱动方,只能由宿主手动
`dispatch`。这是合法的,但通常意味着配漏了。

装配时会校验(全部直接抛错,不静默跳过):

| 情况 | 报错 |
| --- | --- |
| `pets` 为空 | `"pets" must not be empty` |
| `pets` 里有重名 | `pets array has duplicate petId "…"` |
| `entryPetId` 不在 `pets` 里 | `entryPetId "…" is not in pets` |
| `pets` 里的名字没有对应的 `pets/<petId>.json` | `pet "…" has no matching pet config…` |
| 配了 module 但宿主未安装 resolver | `optional module "…" is configured but no module resolver is installed` |

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
  "modelProfileId": "qwen-max",  // 省略则用宿主默认 profile

  // 能力清单 —— 这里写的是 **capability 名**,不是 toolkit 名。
  // 未由 Host 或已安装 module 注册的名字会在装配时直接报错。
  "capabilities": ["general", "studio_planning"]
}
```

`studio_planning` 由可选 `@pinpawo-toolkit/studio-kanban` module 提供(声明
`uses: ['kanban']`)。它不在 Studio 或 local-agent 默认 Capability 注册表里；安装该
module 时，由 composition root 连同 kanban plugin/Toolkit 一起注入。

要不要给某个 pet 装,仍由这份配置决定:planner 需要它来拆任务,worker 需要它
来认领与完成任务;不碰看板的 pet 不必声明。

`model` 字段已被 `modelProfileId` 取代,**继续使用会显式报错**而不是静默
忽略 —— 否则 pet 会悄悄跑在默认 profile 上。

### 2.1 toolkit 不在 pet 配置里

**插件的 toolkit 不需要(也不能)写进 `capabilities`。** 装配时所有 toolkit
统一注入给每个 pet:

```ts
const availableToolkits = [...(input.toolkits ?? []), ...plugins];
```

pet 能不能真的用到 `kanban_task_*`,由**它的 capability 怎么声明 `uses`**
决定 —— capability 说自己要哪些 toolkit,不是 pet 配置说的:

```text
capability.uses: ['kanban']   ← 能力声明它需要这个 toolkit
        ↓
pet.capabilities: ['general', 'explore']  ← pet 只声明它有哪些能力
        ↓
toolkits 全量注入,由 uses 筛出这个 pet 实际拿到的工具
```

往 `capabilities` 里写 `"kanban"` 会抛
`references capability "kanban" which is not registered` —— 因为 `kanban` 是
toolkit 名,注册表里没有同名 capability。

**关键:pet 侧看不出"插件"这个概念。** 它只知道自己有某个能力,而那个能力
恰好用到了看板工具。至于看板同时也在驱动 studio 派活,与 pet 无关。

这正是两副面孔的价值:同一个东西,在 pet 那里是工具,在 studio 那里是驱动方。

---

## 3. 装配

宿主(`buildStudio`)负责读文件、解析 pet、把插件接上:

```ts
const studio = await createStudio({
  studioId: config.studioId,
  entryPetId: config.entryPetId,
  pets: resolvedPets,   // 宿主从 pets/*.json 装配出的 PetAgentRuntime[]
  plugins,              // 由外部 resolveModule(plugins[].id) 注入
});
```

`createStudio` 只做三件事:

1. 建 pet registry(重复 petId、`entryPetId` 不在 `pets` 中都会报错);
2. 依次 `await plugin.studio.start(context)`,把 `dispatch` / `onDispatchGate` /
   `notify` / `subscribe` / `listPets` 交给它;
3. 返回插板。

**它是 `async` 的** —— 插件启动失败必须让调用方看见。一个没起来的驱动器
意味着这块 studio 不会派活,静默吞掉会变成"提交了但什么都没发生"。

`createStudio` 不读配置文件；`@pinpawo/studio` 的 Host 层负责 workdir 文件与 runtime
装配，core contract 保持 transport/filesystem 无关。

### 3.1 `plugins[].id` 怎么解析

Studio Host 接收外部 resolver:

```ts
const resolveModule: StudioModuleResolver = (id, options) =>
  installedModules.resolve(id, options);

const host = new StudioHost({ resolveModule });
```

`options` 原样传给 resolver。未安装或不认识的 id 必须 fail fast，不能静默跳过。
`studio-kanban` 自己拥有 kanban 实现与 `studio_planning` Capability；依赖方向是
module → Studio contract，不是 Studio → kanban。

插件的 toolkit 面与普通 toolkit 合并后交给所有 pet:

```ts
const availableToolkits = [...(input.toolkits ?? []), ...plugins];
```

pet 实际拿到哪些工具,由它的 capability 声明的 `uses` 筛出来 —— 见 §2.1。
`capabilities` 里**只写 capability 名**。

> module catalog/discovery 尚未实现。这属于应用 composition root 的职责，不进入
> Studio package。

---

## 4. 一个完整回合

用配置串一遍,验证契约是否自洽:

```text
1. 宿主 dispatch({ petId: entryPetId, request: "写一篇关于 X 的稿子" })
       ↓  返回 { threadId },立即结束 —— 没有人在等
2. planner 排进它自己的队列;轮到它就跑,调 kanban toolkit 贴了三张任务
       ↓
3. kanban 插件感知到自己的领域数据变了(它订阅的是自己的 board)
       ↓
4. kanban 调 context.dispatch({ petId: "writer", request: "...",
                                correlationId: "task-1" })
       ↓  studio 记录 source=kanban;排进 writer 的队列
5. writer 干完,调 kanban toolkit 把 task-1 标记完成
       ↓  看板状态变了 —— 这是 kanban 得知完成的**唯一**途径
6. writer 的闸门回到 open → studio 放行这个 pet 的下一条
       ↓
7. kanban 调 context.notify({ type: "task.done", correlationId: "task-1" })
       ↓
8. studio 广播 → 别的插件若订阅了就能看到
       ↓
9. kanban 看到 task-1 完成,依赖满足,dispatch task-2……
```

**验证点:**

- 第 1 步之后 studio 就不管了 —— 没有任何地方在等 pet
- 第 3 步的"感知"是插件内部的事,契约不规定它怎么实现
- 第 5 步是闭环的关键:pet 调 toolkit,数据落在插件自己的状态里
- 第 6 步的放行由**闸门**决定,不是"上一次 invoke 返回了"(契约 §3.1)
- 第 7 步 studio 只广播,不解释 `task.done` 是什么意思
- 全程 pet 从未直接与 studio 通信

### 4.1 卡住的时候

第 5 步若 writer 请求一个必须人工确认的操作:

```text
5'. LangGraph 创建 interrupt,把 pending continuation 写入 checkpoint
       ↓
6'. writer 的闸门变成 waiting,studio 不放行这个 pet 的下一条
       ↓
7'. 独立交互 plugin/Host adapter 把 pending action 作为 event 告知用户层
       ↓
8'. 用户授权后,控制 adapter 恢复同一个 thread
       ↓
9'. 闸门回到 open,队列继续
```

studio 全程不知道"review"是什么,它只观察 gate。waiting/interrupt 本身由 LangGraph
checkpoint 持久化,不依赖 Chat Host 的内存状态；没有安装交互插件时,这条 dispatch 一直
卡住也是合法状态。

> **看板上目前看不出来。** 插件可以经 `context.onDispatchGate` 订阅自己派出去
> 那些 dispatch 的闸门变化,把 `waiting` / `blocked` 标到任务上 —— 但 kanban
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
