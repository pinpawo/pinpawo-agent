# Host Capability Catalog（草案）

> 状态：实施中（#685）
> 范围：所有使用 local host runtime 的 Agent，包括 Chat Host 与 Studio Pet。

## 一个 Capability 机制，两种来源策略

Capability 是 Agent 概念，不属于 Chat 或 Studio。`HostCapabilityCatalog` 是共享的
Host-level owner：它合并 Host baseline、外部来源，拒绝名称冲突，解析启用状态，并
发布不可变 snapshot。Agent registry compiler 只消费 snapshot 的已选 definitions。

Chat 与 Studio 不共享一个运行时 catalog 实例，也不共享来源目录；它们共享的是目录
协议、catalog contract、冲突规则和 Agent registry compiler：

| Host | baseline | 外部来源 | 选择规则 |
| --- | --- | --- | --- |
| Chat | `general` 与 Host 内建 Capability | 默认目录、环境覆盖、`capability_dirs` | `config.capabilities[id]` 覆盖 `defaultEnabled` |
| Studio Pet | `general` | `<workdir>/.pinpawo/pets/<petId>/capabilities/` | 目录成员即被选择 |

因此 Studio Pet 的 Capability 与 Chat Capability 是同一种对象和同一条编译路径；仅
每个 Pet 拥有独立 snapshot，不能复用 Chat Host 的全局用户来源或运行时状态。

## 层次

```text
capabilityLoader
  - 纯 CAPABILITY.md 文件协议：路径、frontmatter、entry、strict/tolerant scan

HostCapabilityCatalog
  - Host baseline + configured / directory sources
  - name collision policy
  - activation policy + immutable snapshots

Chat Host / Studio Host
  - 为各自 Agent 请求 snapshot
  - 只把 snapshot.capabilities 交给 Agent registry compiler
```

loader 不知道 `general`、Chat 内建 Capability 或 Studio Pet；这些是 Host catalog
合并来源时的所有权规则。同一个 Agent snapshot 内的来源不能重名，这样不会由下游
静默去重决定 Capability 的优先级。

## 生命周期

Chat Host 在启动时加载 configured source，Chat 请求读取 catalog snapshot。Capability
不再通过 local HTTP 提供展示或 rescan 接口；真实可路由性只在 Agent registry 编译时
确定。

Studio Host 启动时通过同一个 catalog 为每个 Pet 创建 directory snapshot。目录定义
中的 `defaultEnabled` 是 Chat 的配置默认值；Studio 的显式 Pet 目录成员默认全部选择。
请求/线程范围 Toolkit（如 pet profile、artifact discovery）不进入 catalog。
