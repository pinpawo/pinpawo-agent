# Studio 配置目标形态(初稿)

Tracking issue: #561
契约: [`STUDIO_PUSH_MODEL_DESIGN.md`](STUDIO_PUSH_MODEL_DESIGN.md) ·
[`studioContract.ts`](../packages/studio/src/studioContract.ts)

本文用**配置示例**表达目标形态。它是设计的一部分 —— 抽象类型不足以暴露
契约在真实使用中是否顺手,配置能。

> 状态:初稿,尚未实现。与现状的差异见 §4。

---

## 1. `studio.json`

```jsonc
{
  "studioId": "content-studio",
  "name": "内容工作室",

  // 外部入口 submitRequest(goal) 派给谁。
  // 它就是一次 dispatch —— planner 只是恰好扮演拆解角色的普通 pet。
  "entryPetId": "planner",

  // 这个 studio 有哪些 pet 可供派活
  "pets": ["planner", "writer", "reviewer"],

  // 这个 studio 装哪些插件。顺序即 start 顺序。
  "plugins": [
    { "id": "kanban" },
    {
      "id": "scheduler",
      // 插件自己的配置，studio 原样透传不解释
      "options": { "timezone": "Asia/Shanghai" }
    }
  ]
}
```

### 1.1 与现状的差异

| 现在 | 目标 | 为什么 |
| --- | --- | --- |
| `plannerPetId` | `entryPetId` | planner 不是特殊角色,只是入口 dispatch 的目标 |
| `agents` | `pets` | 与 `pet` 术语统一 |
| `curator.promptPath` | 移入 kanban 插件 options | curator 是看板的领域概念 |
| `maxIterationCount` | 移入插件 options | 迭代上限由驱动方决定 |
| `maxRetryPerTask` | **删除** | 自动重试退役(设计 §4.2) |

`studio.json` 里**不该再出现**任务、依赖、进度、重试相关的字段 —— 那些
全是插件的领域。

---

## 2. `pets/<petId>.json`

pet 配置基本不变,只增加插件 toolkit 的引用方式:

```jsonc
{
  "petId": "writer",
  "name": "撰稿",
  "role": "把提纲写成完整稿件",
  "serviceSummary": "长文写作、结构化改写",
  "modelProfileId": "qwen-max",

  // 能力清单。插件的 toolkit 与普通 toolkit 在这里没有区别 ——
  // pet 不需要知道某个 toolkit 背后还插在 studio 上。
  "capabilities": ["general", "kanban"]
}
```

**关键:pet 侧看不出"插件"这个概念。** 它只知道自己有 `kanban` 这个能力,
可以读写看板。至于看板同时也在驱动 studio 派活,与 pet 无关。

这正是两副面孔的价值:同一个东西,在 pet 那里是工具,在 studio 那里是驱动方。

---

## 3. 装配

```ts
const studio = createStudio({
  pets: resolvedPets,          // 由宿主从 pets/*.json 装配
  entryPetId: config.entryPetId,
  plugins: [
    createKanbanPlugin({ root: kanbanRoot }),
    createSchedulerPlugin({ timezone: 'Asia/Shanghai' }),
  ],
});
```

`createStudio` 内部只做三件事:

1. 建 pet registry;
2. 依次调用每个插件的 `studio.start(context)`,把 `dispatch` / `notify` /
   `subscribe` / `listPets` 交给它;
3. 把带 `tools` 的插件注册为 pet 可用的 toolkit。

**它不读配置文件** —— 文件入口属于宿主(与 #613 的 config loader 分层一致)。

---

## 4. 一个完整回合

用配置串一遍,验证契约是否自洽:

```text
1. 客户端 submitRequest("写一篇关于 X 的稿子")
       ↓
2. studio.dispatch({ petId: "planner", request: "写一篇..." })
       ↓  返回 { threadId }，立即结束 —— 不等结果
3. planner 跑起来，调用 kanban toolkit 贴了三张卡
       ↓
4. kanban 插件感知到自己的领域数据变了
       ↓
5. kanban 调 context.dispatch({ petId: "writer", request: "...",
                                correlationId: "card-1" })
       ↓
6. writer 干完，调 kanban toolkit 把 card-1 标记完成
       ↓
7. kanban 调 context.notify({ type: "task.done",
                              correlationId: "card-1" })
       ↓
8. studio 广播 → scheduler / trigger 若订阅了就能看到
       ↓
9. kanban 看到 card-1 完成，依赖满足，dispatch card-2……
```

**验证点:**

- 第 2 步之后 studio 就不管了 —— 没有任何地方在等 pet
- 第 4 步的"感知"是插件内部的事,契约不规定它怎么实现
- 第 7 步 studio 只广播,不解释 `task.done` 是什么意思
- 全程 pet 从未直接与 studio 通信

---

## 5. 待定项

1. `plugins[].id` 如何解析到具体实现:内置注册表?还是像 capability 那样
   从 `~/.pinpawo/` 加载?
2. 插件 options 的校验归谁:studio 原样透传的话,校验就在插件自己的
   schema 里 —— 与 #613 确立的 "机制在 pet-agent / schema 在各自的包 /
   文件入口在宿主" 分层一致。
3. 现有 `studio.json` 的迁移:Studio 不背兼容包袱,直接改;需确认是否有
   已在使用的真实配置。
