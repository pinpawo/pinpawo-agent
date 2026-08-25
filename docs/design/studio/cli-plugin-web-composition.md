# Studio CLI Plugin Web Composition

> 状态：Draft composition design
> 更新：2026-08-26
> 依赖：[Independent Host Runtime](independent-host-runtime.md)、
> [HTTP Plugin](http-plugin.md)、[Kanban Console UI](../kanban/ui-console.md)

本文只定义 standalone `pinpawo-studio` CLI 如何把已安装 Plugin 装配成可运行的本地 Web
surface。它不把 module loading、HTTP 或 UI 提升为 Studio core 领域。

```text
pinpawo-studio CLI
  └─ generic Plugin module loader
       ├─ HTTP Plugin             -> one loopback HTTP/SSE server
       ├─ Kanban Plugin           -> task APIs + dispatch/event integration
       └─ Kanban Console Plugin   -> packaged static Web bundle

browser
  └─ same-origin UI -> HTTP Plugin routes/SSE -> Studio Plugin surface
```

`createStudio()`、`StudioHost` 与 `StudioPluginContext` 不 import、枚举或解释 HTTP、Kanban、
Console 等 concrete Plugin。

## 1. 当前缺口

`StudioPluginResolver` 已是 Host 的注入 port，`StudioHostProcessOptions` 也允许嵌入方提供
resolver；但是 standalone CLI 没有默认 resolver。当前 `.pinpawo/studio.json` 一旦声明
Plugin，CLI 无法仅凭该配置自行启动。

HTTP Plugin 已提供 route hook，`http/static` 仍只有目标描述，尚无稳定 TypeScript contract
与 packaged asset implementation。这个缺口在实现完成之前不能只由
[Independent Host Runtime](independent-host-runtime.md) 的 composition prose 代替。

## 2. CLI module loader

安装定位属于 CLI/application composition，不属于 Studio config 领域。实现可以使用单独的
CLI deployment config，或由 CLI 在读取 Studio config 前将安装清单解析成 resolver；无论
选择哪种文件布局，Studio core 仍只收到 `id + options` 和注入的 resolver。

概念 factory contract：

```ts
export type StudioCliPluginEnvironment = {
  workdir: string;
};

export type StudioCliPluginModule = {
  id: string;
  createStudioPlugin(
    options: Record<string, unknown> | undefined,
    environment: StudioCliPluginEnvironment,
  ): StudioPlugin | Promise<StudioPlugin>;
};
```

loader 必须满足：

- 只解析 application 明确安装/允许的 package specifier，不扫描目录或从网络下载 Plugin；
- module 可以缓存，但每个配置实例单独调用 factory；
- 校验 module `id`、factory 和返回的 `StudioPlugin`，错误必须阻止 Host ready；
- `options` 由 Plugin factory 校验，CLI/Studio 不解释 HTTP token、SQLite path 或 UI mount；
- workdir 只是 factory environment，Plugin 自己拥有 state、secret 与 lifecycle；
- loader 输出普通 `StudioPluginResolver`，不改变嵌入式调用者注入 resolver 的能力。

是否把 module specifier 放入 `.pinpawo/studio.json` 尚未接受。若未来加入，该字段也只能由
standalone CLI adapter 消费，`@pinpawo/studio` 的 runtime contract 不得依赖 npm module
identity。

## 3. Packaged static UI hook

HTTP Plugin 是唯一 loopback listener。Console Plugin 不启动 Vite、Express、Hono 或第二个
Node server，而是向 HTTP Plugin 贡献受限的 packaged asset provider：

```ts
export type StudioHttpStaticAsset = {
  body: Uint8Array;
  contentType: string;
  cacheControl: string;
};

export type StudioHttpStaticMount = {
  mountPath: string;
  resolve(relativePath: string): Promise<StudioHttpStaticAsset | undefined>;
  fallback?: 'index.html';
};

export type StudioHttpStaticHook = {
  register(mount: StudioHttpStaticMount): () => void;
};
```

HTTP Plugin 负责 mount/path 校验、最长前缀匹配、SPA fallback、body/cache 限制、认证边界和
lifecycle unmount。Provider 只能读取自己的 build manifest/bundle，不能接受请求提供的
filesystem path，也不暴露 Node `ServerResponse`。

Kanban Console Plugin 只贡献 bundle；它不定义 Toolkit、不读取 Kanban SQLite，也不执行
dispatch。浏览器继续使用 Kanban/HTTP 已公开的 API 与 SSE。

## 4. Token bootstrap

- server 只监听 `127.0.0.1`；
- static HTML/JS/CSS 可以公开，但不得内嵌 token、task 或 checkpoint；
- dispatch、SSE 与 contributed API 默认仍要求 Bearer；
- Console 首版只在内存保存用户输入的 token，不写 cookie、localStorage 或 query；
- 若 CLI 后续支持 `--open`，token 只能短暂位于 URL fragment，页面读取后立即通过
  `history.replaceState()` 清除；
- same-origin 与外部 Origin 的判断仍由 HTTP Plugin 统一执行。

首版不引入新的 login/session domain，也不能为了 UI 启动便利绕开 HTTP Plugin 的认证边界。

## 5. 实施顺序

1. 确定 CLI deployment config 与 Studio config 的边界；
2. 实现 generic module loader、factory validation 和默认 `StudioPluginResolver`；
3. 在 HTTP Plugin 中实现上述 `static` hook 与 lifecycle/security tests；
4. 将 Console production bundle 包装成 zero-Toolkit Studio Plugin；
5. 用一个 workdir 启动 `http + kanban + kanban-console`，验收 route/static/SSE/unmount/shutdown；
6. 单独收敛 token bootstrap，不能把 token 变成 Studio config 字段。

## 6. 验收

- standalone CLI 能从明确安装清单解析配置中的 Plugin；
- Studio package 不 import concrete Plugin 或 npm loader；
- 一个 Host 只有一个 HTTP listener；
- Console 与 Kanban 数据层之间只有 HTTP/API，不直接打开 SQLite；
- static provider 不能逃逸 bundle manifest；
- partial-start failure 按 Studio Host lifecycle 完整 rollback。
