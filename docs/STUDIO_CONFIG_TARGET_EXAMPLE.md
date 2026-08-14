# Studio 配置

Tracking issue: #561
契约: [`STUDIO_PUSH_MODEL_DESIGN.md`](STUDIO_PUSH_MODEL_DESIGN.md) ·
[`studioContract.ts`](../packages/studio/src/studioContract.ts)
schema: [`configSchema.ts`](../packages/studio/src/configSchema.ts) ·
装配: [`buildStudio.ts`](../services/local-agent/src/studio/buildStudio.ts)

本文用**配置**表达契约的实际形状 —— 抽象类型不足以暴露契约在真实使用中
是否顺手,配置能。

> 状态:**已落地**(#629)。下面的字段与装配流程都对应现有代码。
> 文件名里的 `TARGET_EXAMPLE` 是它作为目标形态起草时留下的,内容已是现状。

---

## 1. `studio.json`

位置:`<workdir>/.pinpawo/studio.json`。

```jsonc
{
  "studioId": "content-studio",
  "name": "内容工作室",

  // 外部输入默认派给谁。它就是一次普通 dispatch ——
  // planner 只是恰好扮演拆解角色的 pet,在契约里没有特殊地位。
  "entryPetId": "planner",

  // 这个 studio 有哪些 pet 可供派活。必填,不可为空。
  "pets": ["planner", "writer", "reviewer"],

  // 装哪些插件 —— **必须显式列出**,studio 不做任何隐式装配。
  // 顺序即 start 顺序(插件之间可能有依赖);stop 时逆序。
  "plugins": [
    { "id": "kanban" },
    {
      "id": "scheduler",
      // 插件自己的配置。studio 与宿主都原样透传、不解释,
      // 校验归插件自己(与 #613 的分层一致)。
      "options": { "timezone": "Asia/Shanghai" }
    }
  ]
}
```

`plugins` 可省略 —— 那样这块 studio 没有任何驱动方,只能由宿主手动
`dispatch`。这是合法的,但通常意味着配漏了。

### 1.1 已删除的字段

以下字段**曾经存在,现已删除**。留在这里是为了让旧配置的报错可被理解:

| 旧字段 | 去向 | 为什么 |
| --- | --- | --- |
| `plannerPetId` | → `entryPetId` | planner 不是特殊角色,只是入口 dispatch 的目标 |
| `agents` | → `pets` | 与 `pet` 术语统一 |
| `curator.promptPath` | 删除 | curator 随拉模型退役;写知识库是插件的事 |
| `maxIterationCount` | → 插件 `options` | 迭代上限由驱动方决定 |
| `maxRetryPerTask` | 删除 | 自动重试退役(契约 §2.2) |

`studio.json` 里**不该再出现**任务、依赖、进度、重试相关的字段 —— 那些
全是插件的领域。

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

  // 能力清单。插件的 toolkit 与普通 toolkit 在这里没有区别 ——
  // pet 不需要知道某个 toolkit 背后还插在 studio 上。
  "capabilities": ["general", "kanban"]
}
```

`model` 字段已被 `modelProfileId` 取代,**继续使用会显式报错**而不是静默
忽略 —— 否则 pet 会悄悄跑在默认 profile 上。

**关键:pet 侧看不出"插件"这个概念。** 它只知道自己有 `kanban` 这个能力,
可以读写看板。至于看板同时也在驱动 studio 派活,与 pet 无关。

这正是两副面孔的价值:同一个东西,在 pet 那里是工具,在 studio 那里是驱动方。

---

## 3. 装配

宿主(`buildStudio`)负责读文件、解析 pet、把插件接上:

```ts
const studio = await createStudio({
  studioId: config.studioId,
  entryPetId: config.entryPetId,
  pets: resolvedPets,   // 宿主从 pets/*.json 装配出的 PetAgentRuntime[]
  plugins,              // 由 plugins[].id 查内置注册表得到
});
```

`createStudio` 只做三件事:

1. 建 pet registry(重复 petId、`entryPetId` 不在 `pets` 中都会报错);
2. 依次 `await plugin.studio.start(context)`,把 `dispatch` / `onDispatchGate` /
   `notify` / `subscribe` / `listPets` 交给它;
3. 返回插板。

**它是 `async` 的** —— 插件启动失败必须让调用方看见。一个没起来的驱动器
意味着这块 studio 不会派活,静默吞掉会变成"提交了但什么都没发生"。

**它不读配置文件。** 文件入口属于宿主(与 #613 的 config loader 分层一致),
`@pinpawo/studio` 因此完全不碰 FS。

### 3.1 `plugins[].id` 怎么解析

宿主持有一张内置注册表:

```ts
const PLUGIN_FACTORIES: Record<string, StudioPluginFactory> = {
  kanban: () => createKanbanPlugin(),
};
```

`options` 原样传给工厂,由插件自己解释与校验。id 不认识就报错并列出已知
插件 —— 不静默跳过,否则配了插件却没装上会很难查。

插件的 toolkit 面与普通 toolkit 合并后交给所有 pet:

```ts
const availableToolkits = [...(input.toolkits ?? []), ...plugins];
```

pet 能不能用,仍由它自己 `capabilities` 里的声明决定。

> 第三方插件(从 `~/.pinpawo/` 加载,像 capability 那样)尚未实现。这属于
> 宿主的装配职责,不影响契约本身。

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
       ↓
6. writer 的闸门回到 open → 队列放行下一条
       ↓  kanban 经 onDispatchGate 收到 task-1 的 open
7. kanban 调 context.notify({ type: "task.done", correlationId: "task-1" })
       ↓
8. studio 广播 → 别的插件若订阅了就能看到
       ↓
9. kanban 看到 task-1 完成,依赖满足,dispatch task-2……
```

**验证点:**

- 第 1 步之后 studio 就不管了 —— 没有任何地方在等 pet
- 第 3 步的"感知"是插件内部的事,契约不规定它怎么实现
- 第 6 步走的是 **dispatch 那条点对点的线**,不是 event 总线
- 第 7 步 studio 只广播,不解释 `task.done` 是什么意思
- 全程 pet 从未直接与 studio 通信

### 4.1 卡住的时候

第 5 步若 writer 撞上人工确认:

```text
5'. writer 的闸门变成 waiting —— 队列不放行下一条
       ↓  kanban 经 onDispatchGate 收到 waiting
6'. 人走 chat 路径跟 writer 对话,把它解开
       ↓  闸门回到 open
7'. 队列继续,kanban 收到 open
```

studio 全程不知道"review"是什么,只知道门关着。人怎么被通知到、要不要在
看板上标出来,是 kanban 的判断。

---

## 5. 已确认的约定

1. **插件必须显式配置。** studio 不做隐式装配 —— 读一眼 `studio.json` 就知道
   这块 studio 由什么驱动。
2. **插件 options 的校验归插件自己。** studio 与宿主都原样透传不解释。
3. **不做兼容迁移。** §1.1 的字段变更直接改,不留兼容层。
4. **entry pet 没有特权。** 它只是 `dispatch` 的一个默认目标;契约里没有
   `submitRequest` 这种专属入口。

## 6. 待定项

1. **第三方插件从哪加载。** 目前只有内置注册表。
2. **插件状态的落盘位置。** `KanbanBoard` 现在只在内存里,进程重启即空;
   scheduler 回来时会面对同一个问题。大概是
   `<workdir>/.pinpawo/studio/<plugin-id>/`,但这属于宿主约定,不进契约。
