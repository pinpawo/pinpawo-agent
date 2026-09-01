# Studio Planner Capability Separation

> 状态：Draft
> 更新：2026-09-02

## 1. 问题

Kickstart 的 Planner Pet 当前用一个 `studio_planning` Capability 同时探索项目与维护
Kanban task 图。该 Capability 组合完整的 `bash`、`git` 和 `kanban` Toolkit，因此模型在
取得规划事实时也同时拥有文件修改、Shell、提交和推送能力。规划与交付只靠提示词区分，
工具边界并未表达职责边界。

Kanban 当前还把 Studio 中全部 Pet 都作为候选执行者返回。Planner 因而可以创建分派给
自己的 task，使规划请求再次进入 Planner，而不是进入交付 Pet。

## 2. 目标结构

Planner Pet 持有两个独立 Capability：

```text
external request
       │
       ├─ facts sufficient ─────────────────┐
       │                                    ▼
       └─ studio_exploration ── handoff ── studio_planning
                                               │
                                               ▼
                                      executor / reviewer tasks
```

- `studio_exploration` 读取项目、Git 和 GitHub 事实，交付规划所需证据；它只组合 Host
  提供的只读 `project-inspection` Toolkit。
- `studio_planning` 根据用户目标、已有 handoff 与一份 Kanban 快照建立最小 task 图；
  它只组合 Kanban Plugin 提供的 `kanban-planning` 视图。该视图包含读取与创建 task，
  不包含执行 Pet 使用的完成和阻塞工具。
- `studio_execution` 与 `studio_review` 只组合 `kanban-execution` 视图。该视图包含 task
  读取、完成和阻塞回报，不包含 assignee 选择与 task 创建。
- Pet 内部 Capability Planner 根据当前输入决定直接规划，或先探索再规划。两段工作沿
  现有 delegation、handoff 与 main-message 机制传递，不增加 Studio 专用状态。

## 3. Toolkit 边界

`project-inspection` 是 local-agent Host 的内建只读 Toolkit。它复用现有文件、搜索、Git 与
GitHub 查看工具，但不包含文件写入、补丁、下载、Shell、进程控制、暂存、提交、
推送或远端资源创建工具。

该 Toolkit 的价值是表达可执行权限，而不是新增第二套文件或 Git 实现。底层工具、工作目录
绑定和 operation metadata 继续复用现有实现。

## 4. Kanban 分派边界

Kanban Plugin 接受可选的 `assignablePetIds` 配置。配置存在时：

- assignee snapshot 只披露配置中的 Pet；
- task 创建只接受配置中的 Pet；
- Plugin 启动时校验每个 id 都属于当前 Studio。

Kickstart 配置只允许 `executor` 与 `reviewer` 接收 Kanban task。Planner 仍通过 Console、
HTTP 或 Trigger 接收外部规划请求；Wiki 仍由 `task.done` Trigger 驱动。

Planner 直接登记产生最终结果的完整交付。需要独立质量判断的实现由一个 Executor task
和一个依赖它的 Reviewer task 表达。Studio Kanban adapter claim 时排除已有 active task
的 Pet，使同一 Pet 串行交付，不同 Pet 仍可并行。

## 5. 验证

- 装配测试确认 Planner 拥有两个 Capability，且工具集合互不越界。
- Kanban 测试确认配置后的 assignee snapshot 与 task 创建均排除 Planner。
- Kanban 测试确认执行 Toolkit 不含 task 创建，并且同一 assignee 不会同时 claim 多个 task。
- Planner/Kanban 模型 eval 在候选事实中包含 Planner，并验证最终只创建 executor 与
  reviewer task、依赖正确、没有 Shell 调用或自分派。

## 6. 非目标

- 不改变 Studio core、dispatch receipt、resident Pet 或 Agent Session 契约。
- 不在 Studio 中引入新的计划状态或跨 Pet message contract。
- 不把通用 Kanban Plugin 固定为“Planner 永远不可分派”；可分派集合由使用它的 Studio
  配置决定。
