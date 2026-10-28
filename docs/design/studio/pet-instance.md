# Pet 实例

> 状态：第一阶段已实现（issue #1015）；第二、三阶段未开始
> 更新：2026-10-28

## 问题

Studio 现在用一个 `petId` 同时表示三件事：

| 角色 | 现在在哪里 |
| --- | --- |
| 定义 | `<workdir>/.pinpawo/pets/<petId>.json`、`pets/<petId>/PET.md`、`pets/<petId>/capabilities/` |
| 运行对象 | `buildStudio` 按 petId 为每个配置的 Pet 建一个 `ResidentPetHost`，串行单位也是它 |
| 个体与寻址 | `studio.json` 的 `pets[]` 和 `entryPetId`、`dispatch({petId})`、Channel 成员、`channel_sessions`、schedule、trigger、消息作者 `pet:<id>` |

所以“采用同一套配置”和“是同一个持续工作的助手”分不开：同一份定义要起第二个助手只能复制目录；
助手也没有自己的记录和生命周期，配置里列了就常驻，删掉就消失。

## 概念

- **Pet 定义**：描述 Pet 怎么工作。模型选择、PET.md、Capability 与工具。可被多个 Pet 使用。
- **Pet**（实例）：一个具体的工作身份。引用一份定义，有稳定的 `petId`、显示名称和生命周期。
  两个 Pet 可以用同一份定义，仍是两个独立的个体。
- **Session**：Pet 的一段会话。一个 Pet 有多个 Session，一个 Session 只属于一个 Pet。
- **Channel**：协作入口。成员里的 Pet 就是 Pet 实例；Channel 不定义 Pet，也不创建 Pet。

命名：Studio 的所有接口里，`petId` 只指 Pet 实例；定义一律叫 `definitionId`。不存在既当定义又当实例的 id。

## 归属：放在 Studio 层

Pet 实例是 Studio core 的数据，不放 Host，也不放 Channel。

- 不放 Channel：Channel 只是入口之一，Scheduler、Trigger、dispatch、Console 都要找到同一个 Pet；
  放在 Channel 里会让其他入口都依赖 Channel Plugin，一个 Pet 也没法加入多个 Channel。
- 不放 Host：Host 是运行层，不知道“个体”这个领域概念，也要能在没有 Studio 时运行（Chat Host）。
  Host 收到的 `petId` 就是它要运行的那个身份，另收一份定义快照。
- Studio core 已经保存过自己的数据（客户身份 `studio_clients`），实例表和它并列，
  用 Studio core 的迁移历史（owner `studio`）。

```sql
CREATE TABLE studio_pets (
  pet_id        TEXT PRIMARY KEY,   -- 创建时指定，之后不变
  definition_id TEXT NOT NULL,
  name          TEXT NOT NULL,      -- 只用于显示，可改，不要求唯一
  created_at    TEXT NOT NULL,
  archived_at   TEXT                -- 为空表示在用
);
```

`petId` 由创建者指定（规则同客户 id：字母数字开头，1-64 位字母、数字、`.`、`_`、`-`），
不自动生成。这样 `studio.json` 里的 trigger、CLI 和日志能写出可读的目标；名称另起，
不参与寻址。

## 定义

- 文件位置不变：`<workdir>/.pinpawo/pets/<definitionId>.json` 加同名目录下的 PET.md 与 `capabilities/`。
  文件里的 `petId` 字段改名为 `definitionId`；旧字段名明确报错。
- `studio.json` 的 `pets` 改名为 `definitions`，列出这个 Studio 允许使用的定义；`entryPetId` 删除
  （当前没有任何使用者）。旧字段名明确报错。
- 定义在 Host 启动时读成快照。运行中创建 Pet 用的也是这份快照；改了定义要重启 Host 才生效。
  首期不做版本管理，也不做热更新。

## 生命周期

| 操作 | 行为 |
| --- | --- |
| 创建 | 选定义、指定 `petId` 和名称，写入 `studio_pets`，随即装配 resident runtime，发 `pet.created` |
| 改名 | 只改 `name`，发 `pet.renamed`；历史消息作者是 `pet:<petId>`，显示随名称变化。Pet 运行时自己看到的名字在下次装配（Host 重启）时更新 |
| Host 启动 | 读取所有在用的 Pet，逐个装配；定义缺失时启动失败并指出是哪个 Pet |
| 归档 | 先标记 `archived_at`，此后 dispatch 以 `pet_archived` 拒收；队列里还没开始的 dispatch 失败；正在跑的跑完；然后关闭 runtime，发 `pet.archived` |
| 历史 | 归档不删 Session、checkpoint 和 Channel 消息；清理是另一回事，首期不做 |

首期不做取消归档：要继续工作就新建一个 Pet。

并发：一个 Pet 同时只跑一个 turn（现在的规则，单位从“配置的 Pet”变成“Pet 实例”）。
同一定义的两个 Pet 可以并行。

## Session

- Host 侧的 Session 登记已经按 `petId` 分文件（`resident-sessions/<petId>.json`），sessionId 也以 `petId:` 开头。
  `petId` 换成实例 id 后，Session 自然属于实例，不需要新的关联字段。
- Channel 沿用现有形状：`channel_sessions(channel_id, pet_id) → session_id`，每对 (Channel, Pet) 一个专用 Session。
  一个 Pet 加入多个 Channel，各有各的 Session，不合并上下文。
- RS 资源仍按 Agent Session 管理，不改成按实例。实例级共享资源以后单独设计。

## 寻址

- 所有投递都用 `petId`（实例）。Channel 成员、schedule、trigger 规则、`POST /dispatch` 都已经要求显式 petId；
  名称从不用于寻址。
- 目标 Pet 不存在或已归档时直接失败，不换成其他 Pet，也不换成默认 Pet。
- Trigger 不再在启动时校验目标 Pet（Pet 可以在运行中创建和归档，启动时的校验已经不够）：触发时由 Studio dispatch
  拒收不存在或已归档的 Pet，失败记入 Trigger 自己的 delivery 日志。Scheduler 在创建 schedule 时校验，触发时同样按上面的规则失败。
- 不带 session 的 dispatch（`POST /dispatch`、不绑 Channel 的 schedule）目前落在该 Pet 当前选中的 Session。
  这是剩下的“活跃 Session 兜底”，第二阶段改为显式绑定（见“分阶段”）。

## 管理入口

Studio core 在 `StudioPluginContext` 上提供 `pets`：

```ts
type StudioPets = {
  list: (options?: { includeArchived?: boolean }) => Promise<StudioPet[]>;
  get: (petId: string) => Promise<StudioPet | undefined>;
  definitions: () => StudioPetDefinition[];
  create: (input: { petId: string; definitionId: string; name: string }) => Promise<StudioPet>;
  rename: (petId: string, name: string) => Promise<StudioPet>;
  archive: (petId: string) => Promise<StudioPet>;
};
type StudioPet = { petId: string; definitionId: string; name: string; createdAt: string; archivedAt?: string };
```

`listPets()` 保留为同步读取，只返回在用的 Pet（`{petId, name, definitionId}`），供 Plugin 校验成员和目标。

- studio-http：`GET /pets`（所有客户，在用的 Pet）；只接受本机 token 的 `GET /pets?archived=1`（含已归档）、
  `GET /pet-definitions`、`POST /pets {petId, definitionId, name}`、`POST /pets/rename {petId, name}`、
  `POST /pets/archive {petId}`。错误码：参数不合法 400，已存在 409，不存在 404。
- `pinpawo-studio pets list [--archived] | definitions | create <petId> --definition <id> --name <name> | rename <petId> --name <name> | archive <petId>`。
- `pinpawo-studio init` 按模板为每份定义创建一个同名 Pet，新目录开箱即用。
- Console 的 Pet 管理页放第三阶段；在此之前 Console 继续通过 `GET /pets` 列出 Pet。

装配的边界不变：Studio core 只持有实例记录和 dispatch / session 端口。`createStudio` 收 `definitions` 和
Host 组合层提供的 `assemblePet(pet)`，拿回 `{dispatch, sessions, close}`；interaction 留在 Host
（`buildStudio` 维护按 petId 的 live map），Agent Session 传输按 `petId` 查找它，所以运行中新建的 Pet 也能被 TUI 连接。
Studio 关闭时，先停 Plugin，再关闭所有 Pet 的 runtime。

## 迁移

不迁移旧数据（与 [存储](storage.md) 的“不兼容旧数据”一致）：

- 现有 workdir 升级时：改 `pets/*.json` 的 `petId` 为 `definitionId`，`studio.json` 的 `pets` 为 `definitions`
  并删掉 `entryPetId`，然后删除 `<workdir>/.pinpawo/studio/studio.sqlite` 与 `~/.pinpawo/workspaces/<id>/resident-sessions/`，
  再用 `pinpawo-studio pets create` 建 Pet。
- 不删库也能启动，但旧 Channel 里以定义 id 登记的 Pet 成员不再对应任何 Pet，@ 它们会明确失败。

## 分阶段

1. **本阶段**：定义与实例拆开；`studio_pets` 与 `StudioPets`；Host 启动与运行中按实例装配、归档关闭；
   HTTP / CLI / init；Trigger 改为触发时校验；测试覆盖创建、两个同定义实例互不串联、重启恢复同一实例与其 Session、
   归档拒收。
2. **Channel 外入口的 Session**：`POST /dispatch` 与不绑 Channel 的 schedule 显式指定或预留 Session，
   去掉 resident dispatch 的活跃 Session 兜底。
3. **Console**：Pet 管理页（创建、改名、归档），Channel 成员选择显示定义。

## 验收

- [ ] 同一份定义创建两个 Pet，各自被寻址，Session 与运行互不影响，无需复制配置目录。
- [ ] 一个 Pet 新建、切换 Session 不改变 petId。
- [ ] Host 重启后恢复同一批 Pet 及其 Session，不产生重复 Pet。
- [ ] 归档后 dispatch 被拒，历史仍可读；在途工作按“生命周期”一节结束。
- [ ] 目标 Pet 不存在或已归档时失败，不落到其他 Pet 或默认 Pet。
