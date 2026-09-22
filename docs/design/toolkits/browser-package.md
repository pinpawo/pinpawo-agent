# Browser Toolkit 包提取记录

> 状态：Historical。2026-08-18 已完成 package extraction；本记录保留包归属与设计背景，
> 不再列出已完成的迁移步骤。2026-09-22 整理。
> 后续设计：[本机 Runtime 托管与 CDP Browser](local-execution-runtime.md)，
> 跟踪 [issue #848](https://github.com/pinpawo/pinpawo-agent/issues/848)，现已进入实现与联合验收。

## 提取解决的问题

Browser 原先分散在 services/local-agent 与 tools/chrome-extension，Toolkit、Runtime、
浏览器驱动和宿主组件的归属不清，构建产物也容易不同步。包提取将它们归入
[toolkits/browser](../../../toolkits/browser/package.json)，由 Browser 包统一维护源码、
配置接口、测试和发行产物。

“默认内置”是 local-agent 的发行选择；Browser 的实现不因此归 local-agent 所有，
也不成为其他 Capability 的隐式依赖。

## 持续适用的包边界

| 位置 | 职责 |
| --- | --- |
| packages/pet-agent | Toolkit 静态契约、执行身份、工具与审核；不解释浏览器协议 |
| toolkits/browser | Browser Toolkit、操作接口、Runtime 实现及其测试 |
| services/local-agent | 用户配置适配、默认发行组合、通用装载与命令行 UI |

Browser 包通过显式配置注入工作，不导入 local-agent 的 config/storage 内部模块。
Capability 用 uses 声明 Toolkit；Host 是否选择 Toolkit、静态定义和实时运行状态分别处理。
领域关系见 [Host / Agent / Capability / Toolkit](../host-agent-capability-toolkit.md)。

## 包提取完成时的历史状态

以下描述重构前基线 da6c791b；链接固定到该版本，不代表当前执行方式：

- [toolkit](https://github.com/pinpawo/pinpawo-agent/blob/da6c791b/toolkits/browser/src/toolkit.ts) 与
  [runtime](https://github.com/pinpawo/pinpawo-agent/blob/da6c791b/toolkits/browser/src/runtime.ts) 由 Host 创建实际 Browser root。
- [session](https://github.com/pinpawo/pinpawo-agent/blob/da6c791b/toolkits/browser/src/session.ts) 保留 extension 与 Playwright 启动路径；
  原提案中的 managedCdp 目录设想不能视为已经存在的 CDP 直连实现。
- [package](https://github.com/pinpawo/pinpawo-agent/blob/da6c791b/toolkits/browser/package.json) 包含 extension 构建，
  [公共出口](https://github.com/pinpawo/pinpawo-agent/blob/da6c791b/toolkits/browser/src/index.ts) 提供 Native Host 安装与状态接口。
  [Host CLI](https://github.com/pinpawo/pinpawo-agent/blob/da6c791b/services/local-agent/src/commands/browser.ts) 使用这些接口。

此前的多 backend、extension bridge、Native Host 与每 Host 独立 root 是当时方案的
组成部分；包提取完成不意味着这些执行路径需要永久保留。

## 后续替换

#848 保持上述源码归属，调整执行与部署：browser 只提供 CDP，实际 Runtime 在本机
统一托管进程运行，Host 通过异步客户端使用实例。其他 backend、extension/Native Host、
相关配置和发行路径随实现删除。

后续的接口、清理范围和验收统一以 [当前草案](local-execution-runtime.md) 为设计依据。
本记录不维护另一份迁移计划；实际 Runtime 生命周期 reference 随代码落地更新。
