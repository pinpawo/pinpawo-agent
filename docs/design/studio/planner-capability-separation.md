# Studio Planner Capability Separation

> 状态：Draft
> 更新：2026-09-14

## 当前职责

Planner 的交付是任务草稿或共享 Kanban 任务，不是源文件实现、审阅或 Wiki 写入。
Supervisor 根据当前输入和已有事实选择 Capability；不增加固定的探索、规划顺序。

- `studio_exploration` 使用 Host 的只读 `project-inspection`，交付有来源的事实摘要。
- `studio_planning` 使用 Kanban Plugin 的 `kanban-planning`，创建和维护任务图。
- 两者可使用 Studio Host 提供的 `studio-context`，通过 `studio_pet_list` 查询实际
  resident Pet 的标识与名称。这个列表不是本 Pet 的 Capability 列表，也不赋予跨 Pet 执行权限。
- PET.md 保留现有的草稿确认流程，并说明默认模板的人工 assignment 和会话交接方式。
  Capability 的 description 在 Supervisor 选择前就表达可交付内容与只读边界。

## 供给边界

`studio-context` 属于 Studio Host 的装配层，和 local-agent 提供的项目只读工具同样通过
Host inventory 供给，由 Capability.uses 选择。它在调用时读取当前 Studio registry，
只返回 `petId/name`，不暴露配置凭据、其他 Pet 文档、工具、会话或 checkpoint。

Studio core 不增加工具、调度策略或状态存储；Kanban 不依赖 Pet 名录；也不把具体
Plugin 的接口注入其他 Plugin。名录查询不推断 Pet 的业务职责或当前可接纳状态。

## 默认模板的执行交接

Kanban 创建的 task 尚未分配执行者。用户在 Console 中选择 executor 或 reviewer，
默认 Trigger 消费 `task.assigned` 后派发。Wiki 由默认 `task.done` Trigger 驱动。
这些是默认模板的装配事实，不是通用 Studio 或 Kanban 的内建规则。任务关联只是上下文
关联，不是自动执行依赖。旧草稿描述的 Planner 自行分配、依赖 claim 流程已不适用。

Console dispatch 是单向 admission。Planner 的自然回复可能是草稿、追问或交接，
不等同于任务已经创建或项目目标完成。详细回复和确认通过 Planner 自己的会话进行。

## 验证

- Host 装配测试确认名录工具进入 inventory；只披露实际 registry 的公开字段。
- 模型 eval 使用默认 PET.md/Capability 文档和生产 Kanban Toolkit，验证草稿、修改、确认。
- 完整图 eval 使用真实 Supervisor、Capability 执行与自然回复，读取隔离的合成工作区，
  验证探索证据、Pet 发现、确认后创建未分配任务且不修改项目文件。
- 工具调用与任务快照作为行为证据，不用提示词字符串匹配验证模型行为。

现有 workdir 的 PET.md/Capability 文档由用户维护；模板升级不覆盖已有文档。

## 模型文案检查（2026-09-14）

检查范围包括默认四个 Pet 的说明、能力文档、Kanban 和本地工具描述，以及规划、验收、
执行和工作摘要的通用提示词。描述侧重目标、可用操作、所需输入和交付结果，去除仅用于
解释实现的 resident、root、Entry/Boundary、thread、生命周期等术语。

工具名称、参数名、状态值和用于区分指令与事实的数据标签保持不变，确保模型仍能准确调用
工具、理解状态和识别信息来源。Git worktree、Kanban、PR 等实际工作对象，以及安全审阅
中的权限和风险含义予以保留。验证使用已有行为测试和模型 eval，不增加提示词字面断言。
