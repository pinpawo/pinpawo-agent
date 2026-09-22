# `@pinpawo-toolkit/browser`

Browser Tools use one CDP Runtime in the local runtime service. Hosts register
`createBrowserToolkit()` with `runtimeKind: 'cdp'` in Host assembly and inject a
`BrowserRuntimePort` into `ToolRuntime.context.toolkitRuntime`.
Each call supplies the current execution scope and abort signal.

The service constructs `createCdpRuntime(config)` and calls
`call(method, args, { clientId, toolkitName, execution, signal })`.
`args` contains the arguments after the port's first context parameter.
Disconnecting a Host calls `releaseClient(clientId)`; stopping the service calls
`close()`. `diagnose()` returns aggregate connection and resource state.

Configure either a local CDP `endpoint`, or a managed Chrome `executablePath`,
`userDataDir` and `headless` setting. Without an endpoint the Runtime starts
Chrome with its own debugging port, then connects using CDP. An omitted profile
uses a temporary directory removed at shutdown. Explicit profiles are retained.
The underlying `playwright-core` package is a CDP client library; there is no
second browser backend or fallback.

An existing browser is borrowed: the Runtime creates and closes only its own
pages and contexts. It never closes the user's browser or adopts existing tabs.
The default context can share the browser's login state. Named sessions use
separate contexts and retain state within the Host connection; they do not
persist across connection loss. Client, Toolkit and thread identify page ownership.
Tool-level profile/headless settings must match a managed Runtime; borrowed
browser startup settings are unsupported and return explicit errors.

Only HTTP(S) targets are supported. An explicit, reviewed open establishes the
approved origin. Redirects and popups to other origins cannot be read or operated
until their URL is opened explicitly for review. Cancellation closes the affected
session's pages; an already dispatched interaction is never automatically repeated.
Screenshots are private artifacts under the execution workdir and are removed
when their owning session is released.

Run `npm test` for unit contracts and `npm run test:cdp` for real Chrome tests.
The latter starts temporary headless Chrome profiles and local HTTP fixtures;
Chrome must be installed. It covers CDP attachment, owned/borrowed shutdown,
client isolation, refs, popups, origin enforcement, extraction, screenshots and
cancellation. The tests do not use extension or Native Messaging components.
