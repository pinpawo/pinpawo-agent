# Pet 实例

> 状态：定义与实例分离；实例固定归属一个 Channel
> 更新：2026-11-10

## 问题

改造前，Studio 用一个 `petId` 同时表示三件事：

| 角色 | 改造前的位置 |
| --- | --- |
| 定义 | `<workdir>/.pinpawo/pets/<petId>.json`、`pets/<petId>/PET.md`、`pets/<petId>/capabilities/` |
| 运行对象 | `buildStudio` 按 petId 为每个配置的 Pet 建一个 `ResidentPetHost`，串行单位也是它 |
| 个体与寻址 | `studio.json` 的 `pets[]` 和 `entryPetId`、`dispatch({petId})`、Channel 成员、`channel_sessions`、schedule、trigger、消息作者 `pet:<id>` |

所以“采用同一套配置”和“是同一个持续工作的助手”分不开：同一份定义要起第二个助手只能复制目录；
助手也没有自己的记录和生命周期，配置里列了就常驻，删掉就消失。

## 概念

- **Pet 定义**：描述 Pet 怎么工作。模型选择、PET.md、Capability 与工具。可被多个 Pet 使用。
- **Pet**（实例）：一个具体的工作身份。引用一份定义，有稳定的 `petId`、不可变的 `channelId`、显示名称和生命周期。
  两个 Pet 可以用同一份定义，仍是两个独立的个体。
- **Session**：Pet 的一段会话。一个 Pet 有多个 Session，一个 Session 只属于一个 Pet。
- **Channel**：实例的唯一归属。先创建 Channel，再由 Studio authority 从定义创建属于它的 Pet。定义可以复用，实例和它的运行状态不能跨 Channel 复用。

命名：Studio 的所有接口里，`petId` 只指 Pet 实例；定义一律叫 `definitionId`。不存在既当定义又当实例的 id。

## 归属：放在 Studio 层

Pet 实例是 Studio core 的数据，不放 Host，也不放 Channel。

- Studio core 持有实例记录和运行端口；Channel Plugin 通过端口验证归属与管理成员，不取得私有 runtime。
  Scheduler、Trigger、dispatch、Console 寻址同一实例，但不能将它搬到另一 Channel。
- 不放 Host：Host 是运行层，不知道“个体”这个领域概念，也要能在没有 Studio 时运行（Chat Host）。
  Host 收到的 `petId` 就是它要运行的那个身份，另收一份定义快照。
- Studio core 已经保存过自己的数据（客户身份 `studio_clients`），实例表和它并列，
  用 Studio core 的迁移历史（owner `studio`）。

```sql
CREATE TABLE studio_pets (
  pet_id        TEXT PRIMARY KEY,   -- 创建时指定，之后不变
  definition_id TEXT NOT NULL,
  channel_id    TEXT NOT NULL,               -- 创建 API 必须绑定既有 Channel，之后不变
  name          TEXT NOT NULL,      -- 只用于显示，可改，不要求唯一
  created_at    TEXT NOT NULL,
  closed_at     TEXT,              -- 临时关闭；可恢复
  removed_at    TEXT               -- 永久移除；保留记录且不能复用 id
);
```

`petId` 由创建者指定（规则同客户 id：字母数字开头，1-64 位字母、数字、`.`、`_`、`-`），
API 不自动生成；Console 为每个新实例生成唯一 id。这样 `studio.json` 里的 trigger、CLI 和日志能写出可读的目标；名称另起，
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
| 创建 | 选择既有 Channel 和定义、指定 `petId` 和名称，写入 `studio_pets`，随即装配 resident runtime，发 `pet.created` |
| 改名 | 只改 `name`，发 `pet.renamed`；历史消息作者是 `pet:<petId>`，显示随名称变化。Pet 运行时自己看到的名字在下次装配（Host 重启）时更新 |
| Close | 明确确认停止当前工作和取消未开始的排队任务，等待业务工作实际停止，再写入 `closedAt`；保留记录 |
| Reopen | 清除临时关闭状态，以同一 `petId`、owner Channel、Session 与凭据重新装配；不自动恢复审批 |
| Remove | 与 Close 共用确认和停止路径；实际停止后写入 `removedAt`，永久移除，不可恢复或复用 id |
| Host 启动 | 只读取既未关闭也未移除的 Pet，逐个装配；定义缺失时启动失败并指出是哪个 Pet |
| Studio 关闭 | 先停 Plugin，再关闭每个 Pet 的 runtime；runtime 关完之前它的 dispatch 生命周期事件照常发布 |

Close 是临时关闭，Remove 是永久移除；从 Channel 移除 Pet 成员采用 Remove。
对 resident 实例，两者都必须明确确认停止当前工作、取消尚未开始的排队任务，即使队列
快照看起来空闲也不能省略。后端先停止接纳并等待业务工作实际停止，再持久化各自的最终
状态；一次确认完成整个操作，不需要停止后再点一次移除。停止失败或无法确认业务已停止时，
不写入最终关闭或移除状态，也不报告成功。请求结果不明时保留身份与历史，先核实再重试。
待审批内容不会被自动回答或恢复。已关闭实例可以直接 Remove，不再执行 resident 停止。

两者都保留实例行、消息历史、凭据与 Session。Close 后可用 Reopen 恢复原身份，
不能改绑 Channel；Remove 后不能恢复，替代实例必须用新 `petId`。
Studio 进程关闭与这两种操作不同：正常重启只恢复未关闭且未移除的实例。
创建时装配失败也保留关闭的实例行与 id，避免复用可能已有 Host 状态的身份。

并发：一个 Pet 同时只跑一个 turn（现在的规则，单位从“配置的 Pet”变成“Pet 实例”）。
同一定义的两个 Pet 可以并行。

## Session

- Host 侧的 Session 登记已经按 `petId` 分文件（`resident-sessions/<petId>.json`），sessionId 也以 `petId:` 开头。
  `petId` 换成实例 id 后，Session 自然属于实例，不需要新的关联字段。
- Channel 沿用现有形状：`channel_sessions(channel_id, pet_id) → session_id`，实例在唯一所属 Channel 中有专用 Session。
  runtime、运行槽和 Session 都随实例固定归属；不能拆开或跨 Channel 复用。
- Head 属于后续独立设计，本次没有实现 Head。后续实现也必须保持 Head 与实例归属一致，不能拆开或跨 Channel 复用。
- RS 资源仍按 Agent Session 管理，不改成按实例。实例级共享资源以后单独设计。
- Pet 可以有自己的凭据（命令的环境变量），存在 Studio core，见 [Pet 凭据](pet-credentials.md)。

## 寻址

- 所有投递都用 `petId`（实例）。Channel 成员、schedule、trigger 规则、`POST /dispatch` 都已经要求显式 petId；
  名称从不用于寻址。
- 目标 Pet 不存在时直接失败，不换成其他 Pet，也不换成默认 Pet。
- Trigger 不再在启动时校验目标 Pet（Pet 可以在运行中创建，启动时的校验已经不够）：触发时由 Studio dispatch
  拒收不存在的 Pet，失败记入 Trigger 自己的 delivery 日志。Scheduler 在创建 schedule 时校验，触发时同样按上面的规则失败。
- Schedule 和 Trigger 只经 Channel 投递（`channelId` 必填），落在这对 (Channel, Pet) 的 Session。
- `POST /dispatch` 不指定 Session，落在该 Pet 当前活跃的 Session。这是正式规则，不是兜底：
  Session 不是调用方指定的东西。

## 管理入口

Studio core 在 `StudioPluginContext` 上提供 `pets`：

```ts
type StudioPets = {
  list: () => Promise<StudioPet[]>;
  get: (petId: string) => Promise<StudioPet | undefined>;
  definitions: () => StudioPetDefinition[];
  create: (input: { petId: string; definitionId: string; name: string; channelId: string }) => Promise<StudioPet>;
  closeInstance: (petId: string, options?: { confirmStop?: boolean }) => Promise<StudioPet>;
  reopenInstance: (petId: string) => Promise<StudioPet>;
  removeInstance: (petId: string, options?: { confirmStop?: boolean }) => Promise<StudioPet>;
  rename: (petId: string, name: string) => Promise<StudioPet>;
  credentials: StudioPetCredentials; // 见 pet-credentials.md
};
type StudioPet = { petId: string; definitionId: string; channelId: string; name: string; createdAt: string; closedAt?: string; removedAt?: string };
```

`listPets()` 保留为同步读取，返回已装配的 Pet（`{petId, name, definitionId, channelId, createdAt}`），供 Plugin 校验成员和目标。

- studio-http：`GET /pets`（所有客户）仅列出存活实例。本机 token 可读取 `GET /pets/records`
  的全部保留记录及 `GET /pet-definitions`，并调用 `POST /pets {petId, definitionId, name, channelId}`、
  `POST /pets/rename {petId, name}`、`POST /pets/reopen {petId}`。
- `POST /pets/close` 和 `POST /pets/remove` 接受 `{petId, confirmStop?: boolean}`；存在 resident
  时必须明确传 `confirmStop: true`。缺少确认时拒绝，不把同意停止解释成审批通过。
- CLI：`pets list`、`pets records`、`pets definitions`、
  `pets create <petId> --definition <id> --name <name> --channel <channelId>`、
  `pets rename <petId> --name <name>`、`pets reopen <petId>`；
  已获停止确认后执行 `pets close <petId> --confirm-stop` 或 `pets remove <petId> --confirm-stop`。
  Channel 的 `remove-member ... --member pet:<petId> --confirm-stop` 转交同一永久移除操作。
  完整接口与错误边界见 [Studio API](../../reference/api/studio.md#pet-instances)。
- `pinpawo-studio init` 只准备定义，不创建全局 Pet。先创建空 Channel，再创建归属它的实例。
- Console 在选定 Channel 的成员面板提供定义选择与实例创建，仅本机 authority 可用。普通 Channel client 可管理人类成员和移除 Pet，但不可创建实例或读取定义。
- `GET /pets` 只列出存活注册，含 `channelId`；关闭或移除后的历史记录仍保留。
- 本机 authority 的记录元数据支持保留身份的显示和关闭管理，不等于完整的历史检查入口。
  普通 client 的历史消息仍可能回退显示作者 id。停止判据针对业务工作；关闭实例的 Session
  检查、外部 observer 和其元数据写入的清理留待后续。Reopen 是恢复使用，不是只读历史检查。

装配的边界不变：Studio core 只持有实例记录和 dispatch / session 端口。`createStudio` 收 `definitions` 和
Host 组合层提供的 `assemblePet(pet)`，拿回 `{dispatch, sessions, close}`；interaction 留在 Host
（`buildStudio` 维护按 petId 的 live map），Agent Session 传输按 `petId` 查找它，所以运行中新建的 Pet 也能被 TUI 连接。
Studio 关闭时，先停 Plugin，再关闭所有 Pet 的 runtime。

## 迁移

本次不支持将既有实例数据升级为 Channel 所有权模型。迁移 `0004_pet_channel` 发现
任何既有 `studio_pets` 行时，在修改 schema 或记录迁移之前明确拒绝；原始数据不变，
仍可用之前版本打开。不要猜测归属、复制实例或静默丢弃历史。

全新 Studio 或没有 Pet 实例的旧数据库可正常迁移。已有实例的 Studio 应继续使用之前版本，
等待明确的数据归属升级方案；不要删除数据库、Session 注册或凭据来完成本次升级。

## 实现范围

- 定义可被多个实例复用；实例只有一个不可变 Channel。
- Studio authority 在既有 Channel 中创建实例；Channel 创建不接受已有 Pet 列表。
- Console 和 CLI 遵守相同创建顺序；普通客户不获得定义创建权限。
- Close 可恢复，Remove（包括移除 Pet 成员）永久生效；共用明确确认后的先停止、再持久化路径。
- 保留身份与历史，关闭可原身份恢复，移除不可重开或复用 id；两者都不能搬迁至其他 Channel。
- 不新增 Head、停止端口、队列或 dispatch/event-core 语义。

## 验收

- [ ] 同一份定义创建两个 Pet，各自被寻址，Session 与运行互不影响，无需复制配置目录。
- [ ] 一个 Pet 新建、切换 Session 不改变 petId。
- [ ] Host 重启只恢复仍开放且未移除的 Pet 及其 Session，不产生重复 Pet。
- [ ] Schedule 和 Trigger 不带 `channelId` 时被拒绝，不会直接 dispatch 到活跃 Session。
- [ ] 目标 Pet 不存在时失败，不落到其他 Pet 或默认 Pet。

- [ ] 一个实例不能加入第二个 Channel；关闭后重启不恢复 runtime，Reopen 保留原身份、归属、Session 与凭据。
- [ ] Close 与 Remove 都先明确确认停止当前工作和取消未开始的排队任务；实际停止后才持久化各自最终状态。
- [ ] 停止失败或结果不明时无最终操作成功；审批不被自动回答或恢复；Remove 后 id 不可恢复或复用。
