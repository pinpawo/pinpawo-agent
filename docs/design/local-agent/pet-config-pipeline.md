# PetConfig 读写链路设计（2026-09-08 draft）

基线：`ab6bb12e`（#780 合并后）。

本文只回答四个问题：**定义什么、存在哪、谁来读、怎么被用到。**
类型形式（可选字段、`Pick<>`、拆不拆）是这四个问题的结果，不是前提，
放在最后一节。

---

## 一、现状：三条链路，两条是断的

### 1.1 Studio —— 四段完整

```
定义   PetConfig + petConfigSchema        packages/studio/src/configSchema.ts
存     <workdir>/.pinpawo/pets/<petId>.json
读     loadPetConfigs(dir) → parseConfigDocument → 校验 + 去重
用     resolveStudio(studio, petConfigs) → buildStudio → createResidentPetRuntime
```

解析机制（`defineConfigSchema` / `parseConfigDocument`）住在
`packages/pet-agent/src/utils/configDocument.ts`，schema 与目录级一致性归 Studio。
分层清楚，可以直接复用。

### 1.2 Chat 的 Pet 身份 —— 断在"读"

```
定义   StoredConfig.actor_id / actor_name    storage.ts:11-12
存     ~/.pinpawo/config.json
读     没有人读                              ← 断点
用     LOCAL_ACTOR_ID = 'local-only'         actorSelection.ts:8 硬编码
       LOCAL_ACTOR_NAME = 'Local Agent'
```

实测：`actor_id` / `actor_name` 在非测试代码中各只出现 1 次，都是
`httpHandlers.ts:33-34` 把常量**输出**成同名字段，没有任何读取。

用户在 `config.json` 里写 `actor_id` 完全无效，且无任何提示。

### 1.3 Chat 的 Pet 定义 —— 整条不存在

```
定义   无
存     无
读     无
用     modelProfileId        ← 全局 getConfig()
       defaultCapabilityName ← 无（永远 undefined）
       petDocument           ← PET.md（唯一有文件的一项）
```

后果：Studio 的 pet 能配 `defaultCapabilityName`，Chat 的不能；
同一件事两套 Host 两套答案。

### 1.4 死配置

`user_id`、`nickname` —— 非测试代码零读取。

---

## 二、定义什么

判据：**用户能写、需要持久化、重启后仍生效**的才是配置。
按此过一遍常驻 Pet 装配所需的 15 项：

| 项 | 是配置 | 归属 |
|---|---|---|
| `petId` / `name` | ✅ | **PetConfig** |
| `modelProfileId` | ✅ | **PetConfig**（引用 `config.json#models`） |
| `defaultCapabilityName` | ✅ | **PetConfig** |
| PET.md 文档 | ✅ | **PetConfig 的同名目录约定**，非 JSON 字段 |
| `globalReviewPolicyMode` | ✅ | Host 设置（已在 `config.json`） |
| `autoAuthorizationSafetyLevel` | ✅ | Host 设置（已在） |
| `capabilityRegistryBackend` | ✅ | Host 设置（已在） |
| `workdir` | ✅ | Host 设置（已在） |
| `capabilityCatalog` | ❌ | 扫描派生 |
| `toolkitInventory` | ❌ | 扫描派生 |
| `chatCheckpointer` | ❌ | 服务对象 |
| `toolkitRuntimeManager` | ❌ | 服务对象 |
| `capabilityArtifactStore` | ❌ | 服务对象 |
| `serverMode` | ❌ | 启动参数，不持久化 |
| `runtimeConfig` 的派生路径 | ❌ | 由 `workdir` 计算 |

**结论：PetConfig 就是 Studio 已定义的那四项**，Chat 缺的正是这一份，
不需要发明新字段：

```ts
export type PetConfig = {
  petId: string;
  name: string;
  modelProfileId?: string;          // 留空继承 Host default profile
  defaultCapabilityName?: string;   // 留空用 general
};
```

（现名 `PetLocalConfig`。`Local` 在此不构成区分——不存在 remote 变体——
本设计一律用 `PetConfig`，改名与本链路改造同批完成。）

---

## 三、存在哪

统一到 Studio 已有的约定，Chat 复用同一布局：

```
<workdir>/.pinpawo/
  config.json                 Host 设置：models / policy / workdir / capability_*
  pets/
    <petId>.json              PetConfig
    <petId>/PET.md            该 Pet 的根文档
```

Chat 的差别只是"只有一个 pet"，不是"没有 pet 配置"。

**默认 pet 不落盘**（已定）：`pets/` 为空或不存在时，使用内置默认
`{ petId: 'local-only', name: 'Local Agent' }`，不写文件。该值与现有
`LOCAL_ACTOR_ID` / `LOCAL_ACTOR_NAME` 同值，故存量用户零迁移。
用户要改名就自己建 `pets/local-only.json`。

`pinpawo init` 是否顺带生成这份文件，留到 init 整体优化时一并处理——
生成的内容等于默认值，届时加上不改变任何行为。

**PET.md 的位置分歧**：Chat 现在读 `<workdir>/PET.md`（`petDocument.ts:7`），
Studio 读 `pets/<petId>/PET.md`。收敛时 Chat 需同时接受两者，旧路径存在时
继续生效并提示迁移。

---

## 四、谁来读

复用 Studio 的加载器，不写第二套：

```
parseConfigDocument(pet-agent/utils/configDocument.ts)   解析机制，已存在
        ↑
petConfigSchema(studio/configSchema.ts)                  字段与校验，已存在
        ↑
loadPetConfigs(dir)                                      目录读取 + 去重，已存在
        ↑
├── Studio: loadPetConfigs(petsDir) → N 份
└── Chat:   loadPetConfigs(petsDir) → 取 1 份，空则默认   ← 新增的唯一一段
```

`petConfigSchema` 与 `loadPetConfigs` 现居 `packages/studio`，需上移到
**`services/local-agent`**（已定）。Studio 已依赖 `pinpawo/host-runtime`，
改为从那里导入。

定在 local-agent 而非 pet-agent，因为 PetConfig 含 `modelProfileId` 这类本机
概念，放进 runtime-independent 包会破坏 CLAUDE.md 的边界约定。解析机制
（`parseConfigDocument`）仍留在 pet-agent，两者分层不变。

**读取时机**：Chat 在 `AgentHost.init()` 内、`caps.init()` 之前完成，
与现有 `loadPetDocumentFile` 同一阶段（`runtime.ts:43-48`）。

**失败语义**沿用 Studio：目录不存在 → 空；单文件解析失败 → 带路径抛错；
petId 重复 → 抛错。

Chat 多一条：**读到 >1 份时抛错**。Chat 终局就是单 Pet（已定），多 Pet 只在
Studio 模式下存在，所以这不是临时限制，而是 Chat Host 的固有契约——报错应
明确指向 Studio，而不是暗示"以后会支持"。

---

## 五、怎么被用到

现在 `ServerDeps` 把**配置**和**运行时服务**混在一个类型里，这是
"`actorId` 与 `chatCheckpointer` 并列"这种怪状的根源。分层后：

```
PetConfig            ← 读自文件，可存可改
HostExecutionConfig  ← 读自 config.json（#764 已抽出）
        +
运行时服务（catalog / inventory / checkpointer / artifactStore / runtimeManager）
        ↓ 装配
ServerDeps           ← 内存产物，不可持久化
        ↓
buildChatSetup → graph
```

`ServerDeps` 中被 PetConfig 吸收的字段：

| 现字段 | 去向 |
|---|---|
| `actorId` | `petConfig.petId` |
| `actorName` | `petConfig.name` |
| `modelProfiles` | 仍是服务对象；选择哪个 profile 由 `petConfig.modelProfileId` 决定 |
| `defaultCapabilityName` | `petConfig.defaultCapabilityName` |
| `petDocument` | 由 `petConfig.petId` 定位加载 |

装配点：
- Chat：`AgentHost.buildServerDeps()`（`runtime.ts:109`）
- Studio：`buildStudio` → `createResidentPetRuntime`（已经在传 `petId`/`petName`）

**`ServerDeps` 这个名字**：它实际是"一个常驻 Pet 运行起来所需的全部东西"，
其中只有 `serverMode` 一项与 server 有关，而 `residentPetHost` / `buildChatSetup`
等主要消费者都不是 server。分层完成后剩余内容会变，届时一并正名
（候选 `ResidentPetRuntimeDeps`），本轮不动。

---

## 六、落地顺序

每步独立可验证、可单独成 PR。

**Step 1 — 删死配置**（无依赖，最小）
`user_id`、`nickname` 从 `StoredConfig` 移除。非测试代码零读取。
不加 `reader.fail`：它们从无行为，静默忽略即可。

**Step 2 — 上移 PetConfig 定义与加载器**
`PetConfig` / `petConfigSchema` / `loadPetConfigs` 从 `packages/studio`
迁至 `services/local-agent`，Studio 改为从 `pinpawo/host-runtime` 导入。
同批把 `PetLocalConfig` → `PetConfig`、`petLocalConfigSchema` → `petConfigSchema`。
纯搬迁 + 改名，行为不变。

**Step 3 — Chat 接上 PetConfig**
`AgentHost.init()` 读 `pets/`；空目录用内置默认
`{ petId: 'local-only', name: 'Local Agent' }` —— 与现有常量同值，
**故存量用户零行为变化、零迁移**。读到 >1 份时抛错并指向 Studio。
`actorSelection.ts` 的两个常量退化为该默认值的来源。
`StoredConfig.actor_id` / `actor_name` 移除，因为身份改由 `pets/` 表达；
这两个键从未生效，删除不影响任何现存配置。

**Step 4 — PET.md 路径收敛**
Chat 兼容 `<workdir>/PET.md`（旧）与 `pets/<petId>/PET.md`（新），
旧路径命中时提示迁移。

**Step 5 — ServerDeps 分层**
`petConfig` 作为一个字段进入装配，`actorId` / `actorName` /
`defaultCapabilityName` 从 `ServerDeps` 移除。
此时才谈类型形式：剩下的字段哪些真可选、要不要 `Pick<>` 收窄消费者签名——
**边界由前四步的数据决定，不再靠猜**。

---

## 七、已定决策（2026-09-08）

1. **默认 pet 不落盘**：先用内置默认值，`pinpawo init` 的生成留到 init 整体
   优化时一并做。
2. **PetConfig 定义放 `services/local-agent`**，Studio 从 `pinpawo/host-runtime`
   导入。
3. **Chat 终局单 Pet**，多 Pet 只存在于 Studio 模式。故 Chat 读到 >1 份 pet
   配置是错误状态，不是待支持的功能。

单 Pet 不等于不需要配置：现在用户改不了 pet 名字、设不了
`defaultCapabilityName`，这与 pet 数量无关，Step 1–4 仍然要做。

---

## 八、不在本设计内

- `runtimeConfig.checkpointPath` 死字段与 checkpoint 三套路径收敛（含数据迁移）。
- 跨包 `Local*` 符号改名（`LocalAgentRuntimeConfig` 等 6 个 + `local-server-transport` 出口）。
- 10 处 `@deprecated` 别名清理。
- #764 借 merge commit 夹带的 pause_task 改动补独立提交追溯。
