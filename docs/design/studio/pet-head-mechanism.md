# Pet Head：判断、派发与反馈

## 1. 结构和职责

![Channel Timeline、Pet Head、Dispatch 和 Agent Session 的关系](assets/pet-head-mechanism.svg)

- **Channel Timeline → EventBus → Head。** Head 跟随 Pet 实例，订阅自己的 Channel。离线不补投，自己的消息和其他 Head 的自动回复不触发新判断。
- **Head → Studio Dispatch → Host Dispatch Coordinator。** Head 只判断是否提交独立工作。Channel 校验成员和绑定，交付原消息、附件和一层明确引用。Coordinator 负责接纳、FIFO 和 Stop 等待；Head 不复制队列规则。
- **Dispatch Coordinator → `readExecution` → Head。** 协调器提供本 Pet、当前 Channel 和绑定 Session 的执行事实。Head 不另行订阅派发生命周期，也不在 Dispatch 中读取 Agent Session。

## 2. 两阶段

1. **相关性判断。** 规范 `@Pet` 直接通过；其他消息用 `assessRelevance` 判断，只返回 `{ relevant }`。无关则结束，不读 Session。
2. **派发判断。** 先取得已绑定 Session 的任务事实，再单次调用 `decideDispatch`，返回 `{ shouldDispatch, reply }`。回复和提交不是互斥分支。模型不改写原任务，不根据忙闲决定是否允许提交。

`readExecution` 是运行时准备上下文的只读入口，不增加模型工具。当前执行、队列和最多十项近期生命周期不受聊天窗口限制。原消息 ID 标注来源，不用来匹配或过滤任务；当前执行的原消息不在窗口里时，只补读这条公开消息。存在当前执行时，Head 另外取一次已绑定 Session 的现有快照，只提供执行状态和可选的已记录 Plan。这个快照和 Dispatch 事实独立，不把 Plan 和任何一条派发绑定。不读取 Session 消息给模型。快照不可用时仍可报告已知状态和提交独立工作。完成必须有真实生命周期事件，不从队列消失推断；重启后不重建历史。正式交付仍经原有 Channel 桥接。

```mermaid
sequenceDiagram
    participant C as Channel Timeline
    participant H as Pet Head
    participant M as Head 模型
    participant D as Dispatch Coordinator
    participant S as Agent Session
    C->>H: 提交后的消息
    opt 无规范 @
        H->>M: 只判断相关性
        M-->>H: relevant
    end
    Note over H: 无关则结束
    H->>D: 一次读取当前绑定的执行快照
    D-->>H: 当前执行、排队和近期结果
    opt 存在当前执行
        H->>S: 读一次绑定 Session 快照
        S-->>H: 快照状态及可选的已记录 Plan
    end
    H->>M: 原消息、公开上下文和任务事实
    M-->>H: shouldDispatch, reply
    opt 独立新工作
        H->>D: 经 Channel 提交原消息
        D-->>H: 接纳或异常；Stop 期间静默等待
    end
    opt 有回复或派发异常
        H->>C: 回复原消息；异常不抹掉已有状态答复
    end
```

## 3. 场景与边界

| 用户消息 | 处理 |
| --- | --- |
| 「A 做到哪了？」 | 只按事实回答。A 排队不说成在跑，已完成不读取新任务的 Plan。 |
| 「A 到哪了？另外做 B。」 | 一次判断产生 A 的回复和 B 的提交。B 未接纳时不声称已排队。 |
| 「如果 A 没做完就换 B。」 | 不是普通独立派发；不把未知当失败，本次不接入 Stop 或替换工具。 |
| 「你是分析员吗？」 | 直接回复，不因当前有工作而被替换为进度。 |

同一个懒加载客户端分别使用 `pet_head_relevance`、`pet_head_dispatch` 两个结构化约定。系统规则和角色前置；Channel 历史保留最近十条和显式引用。不加模型重判、额外回复生成或队列控制。首次 Session 注册仍由 Host 的 idle-only 规则接纳。
