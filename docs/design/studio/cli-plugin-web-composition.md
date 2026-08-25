# Studio CLI Plugin Web Composition

> 状态：Draft composition design（CLI loader、HTTP static hook 与 Kanban Console 已落地）
> 更新：2026-08-25
> 依赖：[Standalone process](standalone-process.md)、[HTTP Plugin](http-plugin.md)、
> [Kanban Console UI](../kanban/ui-console.md)

Studio 的独立 CLI 应能通过**通用 Plugin 装配**启动一个完整的本地 Web surface：一个
HTTP Plugin 持有唯一 loopback server，业务 Plugin 贡献 API，UI Plugin 贡献静态 bundle。
这不是让 Studio core 变成 Web application，也不是让每个 UI 启动自己的 server。

```text
pinpawo-studio CLI
  └─ generic Plugin module loader
       ├─ HTTP Plugin             -> one loopback HTTP/SSE server
       ├─ Kanban Plugin           -> task APIs + dispatch/event integration
       └─ Kanban Console Plugin   -> static Web bundle mount

browser
  └─ same-origin static UI -> HTTP Plugin routes/SSE -> Studio Plugin surface
```

`createStudio()`、`StudioHost` 与 `StudioPluginContext` 仍不 import、枚举或解释
HTTP、Kanban、Console 等具体 Plugin。

## 1. 目标与非目标

目标：

- `pinpawo-studio` 按 workdir 的显式配置装载已安装 Plugin；
- 一次 CLI 启动只产生一个 HTTP listener；
- Console bundle 与 API/SSE 使用同一 loopback origin；
- Plugin 的启动、rollback 和停止仍由 Studio lifecycle 统一管理；
- Kanban 任务/SQLite 继续完全由 Kanban 拥有，UI 不直接碰数据库。

非目标：

- Studio core 内置 Plugin catalog、静态页面或 HTTP framework；
- 自动扫描所有 npm package 或从网络下载 Plugin；
- Vite development/preview server 成为产品运行时；
- UI 取得 Agent checkpoint、Studio 内部 event queue 或 Plugin 私有 state；
- 本阶段实现浏览器登录、跨机器公网访问或 interaction resume。

## 2. CLI 的通用 Plugin module loader

目前 `StudioPluginResolver` 已是正确的 Host port，但 standalone CLI 没有默认 resolver，
因此一旦 `studio.json` 配置 Plugin 就无法自行启动。补齐的是 CLI adapter，而非 Studio
core registry。

配置把安装入口显式写在每一个 Plugin 项：

```json
{
  "plugins": [
    {
      "id": "http",
      "module": "@pinpawo-plugin/studio-http",
      "options": { "port": 4310 }
    },
    {
      "id": "kanban",
      "module": "@pinpawo-plugin/kanban",
      "options": { "databasePath": ".pinpawo/kanban/tasks.sqlite" }
    },
    {
      "id": "kanban-console",
      "module": "@pinpawo-plugin/kanban/console/studio-plugin",
      "options": { "httpPlugin": "http", "mountPath": "/" }
    }
  ]
}
```

这里的 `module` 只是 CLI 的通用安装定位符，不是 Studio 领域字段：

- CLI 只接受 package specifier（第一阶段不支持任意相对/绝对脚本）；
- 同一 module 可被 cache，但每一条 config 都调用自己的 factory 来支持多个实例；
- loader 验证 module 导出的 `id` 与配置 `id` 一致，factory 返回普通 `StudioPlugin`；
- `options` 仍由对应 factory 校验，Studio schema 不读取 HTTP token、SQLite 路径或 UI
  mount 的含义；
- workdir 只作为 factory 的启动环境传入；具体 Plugin 自己决定 state/secret 的位置与
  生命周期，Studio 不分配 Plugin 数据目录。

概念上的 factory contract 如下（名称可在实现时调整）：

```ts
export type StudioCliPluginModule = {
  id: string;
  createStudioPlugin: (
    options: Record<string, unknown> | undefined,
    environment: { workdir: string },
  ) => StudioPlugin | Promise<StudioPlugin>;
};
```

CLI 在构造 `StudioHost` 前由这个 loader 生成 `StudioPluginResolver`。`StudioHost` 之后
仍只接受 resolver，嵌入式调用者也仍可以传自己的 resolver；不会产生对 concrete Plugin
的静态依赖。

## 3. 一个 HTTP 容器，不是第二个 Web server

`@pinpawo-plugin/studio-http` 已拥有 listener、可选 Bearer/Origin、body 限制、SSE、route
注册和生命周期。Console 不应启动 Vite、Express、Hono 或自己的 Node server；它应作为
零 Toolkit 的 `kanban-console` Studio Plugin，在 `start()` 里向已安装 HTTP Plugin 贡献
静态资源 mount。

HTTP Plugin 应从现有的 `routes` hook 扩展为两个 HTTP-owned hook：

```text
http/routes   -> authenticated JSON/text APIs（已有）
http/static   -> packaged static asset mounts（新增）
```

`static` 的设计应是 asset provider，而不是把任意本机目录交给 HTTP：

```ts
type StudioHttpStaticAsset = {
  body: Uint8Array;
  contentType: string;
  cacheControl: string;
};

type StudioHttpStaticMount = {
  mountPath: string; // e.g. "/" or "/kanban/"
  resolve: (relativePath: string) => Promise<StudioHttpStaticAsset | undefined>;
  fallback?: 'index.html';
};
```

HTTP Plugin 负责：mount path 和 request path 校验、最长前缀选择、固定 body 上限、响应和
cache header。Provider 必须只从自己打包的 manifest/bundle 中读取；不能接受浏览器传来的
filesystem path，也不暴露 `ServerResponse`。

Kanban Console Plugin 只把 Vite build 的 manifest 包成该 provider。它不定义 Toolkit、
不读取 Kanban SQLite，也不执行 dispatch；浏览器使用 Kanban/HTTP 已公开的 API 和 SSE。
这样 UI 与 Kanban data domain 仍相互独立，但它们作为同一个 `plugins/kanban/` 产品目录
共同发布和启动。

`hooks.contribute()` 已支持 HTTP 先启动或 Console 先启动：provider 出现后即挂载，任一
Plugin 停止时自动卸载。因此 config 顺序只决定观察性的 start 顺序，不形成 UI 对 HTTP 的
脆弱启动竞态。

## 4. 本地 Web security

- server 继续只 bind `127.0.0.1`；
- 静态 HTML/JS/CSS 与同源 API 默认都不要求认证；当前仅支持本机单用户 loopback 场景；
- 嵌入方可显式提供 Bearer token，为 `/dispatch`、`/events`、Kanban API 和未来 interaction
  command 启用认证；token 不写入 `studio.json`；
- HTTP Plugin 应自动接受它自己已监听的 same-origin，外部 Origin 仍需要显式 allowlist。

首版不实现 cookie session 或新的 authentication domain。跨机器或多用户访问必须先补充
该边界，不能通过放宽 loopback bind 来实现。

## 5. 第三方 HTTP 容器

当前 HTTP Plugin 直接基于 `node:http` 实现了 route matching、method handling、body
读取、CORS、可选 Bearer middleware、SSE client 管理和错误响应。这使它已经在重复通用 Web
framework 的职责；新增 static mount 后继续手写会放大维护与安全面。

使用 **Hono + `@hono/node-server`** 作为
`@pinpawo-plugin/studio-http` 的内部依赖。它不是新的 Studio Plugin，也不进入
`@pinpawo/studio`：

```text
Studio core ─X─> Hono
Studio HTTP Plugin ──> Hono / Node adapter
other Studio Plugins ──> HTTP Plugin hook contracts only
```

HTTP Plugin 仍拥有且不能让给第三方库的部分是：Studio dispatch/event adapter、Plugin
hook lifecycle、loopback-only bind policy、Plugin route/mount validation，以及 shutdown
顺序。Hono 只承接通用 HTTP concerns：router、method/404、middleware composition、CORS、
request body、response，以及静态文件传输。

现有 `StudioHttpRoute`、未来 `StudioHttpStaticMount` 仍是我们的稳定 Plugin contract；它们
由 HTTP Plugin 转成 Hono route/middleware。这样将来替换 Hono 也不会影响 Kanban 或其他
Plugin。

Vite 仍只负责 React bundle。它的官方文档明确将 build 输出视为可由静态服务托管的资产，且
`vite preview` 仅用于本地预览、不是 production server。[Vite static deploy guide](https://vite.dev/guide/static-deploy)

Hono 的 Node adapter 支持 Node server 和 `serveStatic`，可在 HTTP Plugin 内实现受限的
Console bundle mount。[Hono Node adapter](https://hono.dev/docs/getting-started/nodejs)

## 6. 实施顺序

1. ~~以 Hono 重构 HTTP Plugin 内部实现，同时保持既有 HTTP contract 与 SSE/E2E 测试不变；~~（已完成）
2. ~~扩展 config 的通用 `plugins[].module`，实现 CLI module loader 和 factory validation；~~（已完成）
3. ~~给 HTTP Plugin 增加受限 `http/static` hook，并为静态挂载与 lifecycle 写测试；~~（已完成）
4. ~~将 Console 的 production bundle 纳入 `plugins/kanban` 发布产物，新增
   `kanban-console` zero-Toolkit Plugin factory；~~（已完成）
5. ~~用一个 workdir config 启动 `http + kanban + kanban-console`，验收静态页面、dispatch、
   SSE、route unmount 与 SIGINT shutdown；~~（静态页面、同源 API 与生命周期已验收）
6. 独立设计 interaction Plugin、durable Kanban event read model 与 token bootstrap，
   再把静态 prototype 换成真实 adapter。
