# CDP browser guide

The default `browser` Toolkit uses Chrome DevTools Protocol (CDP). Its Runtime
runs in the shared local Runtime service; Chat and Studio use clients of that
service. Browser operations have one execution path. Chrome Extension, Native
Messaging, backend selection and automatic fallback have been removed.

This guide keeps its existing URL. The former extension implementation is
recorded in the [Browser package history](../design/toolkits/browser-package.md).
The [Runtime design](../design/toolkits/local-execution-runtime.md) explains the
shared process and instance boundaries.

## Configure the Runtime

The service reads `~/.pinpawo/runtime/config.json`. `PINPAWO_RUNTIME_DIR` selects
a different configuration directory. This example preserves the default Shell
bindings and borrows a local Chrome CDP endpoint:

~~~json
{
  "instances": {
    "local": { "type": "shell" },
    "browser": {
      "type": "cdp",
      "endpoint": "http://127.0.0.1:9222"
    }
  },
  "toolkitBindings": {
    "bash": "local",
    "git": "local",
    "project-inspection": "local",
    "browser": "browser"
  }
}
~~~

Chrome must already expose that debugging endpoint. The endpoint may be an
HTTP(S) or WebSocket URL on localhost, 127.0.0.1 or ::1. The Runtime creates its own
pages; it never adopts a user's existing tab or closes the borrowed browser.
Default-session pages share the browser's default context and may share its
login state.

Alternatively, remove `endpoint` and configure a managed browser:

~~~json
{
  "type": "cdp",
  "executablePath": "/absolute/path/to/chrome",
  "headless": false,
  "userDataDir": "/absolute/path/to/dedicated-profile"
}
~~~

This object replaces the `instances.browser` entry in the full configuration.
The Runtime starts Chrome with a local debugging port and connects using CDP.
The executable is optional when Chrome is installed at a supported platform
location. An omitted `userDataDir` uses a temporary profile, removed on shutdown;
an explicit profile remains on disk. Avoid using a profile that another Chrome
process already has open.

`endpoint` cannot be combined with `executablePath`, `userDataDir` or `headless`.
Paths must be absolute, `headless` must be boolean, and optional `env` values must
be strings. If omitted, env uses the service's startup snapshot; an empty object
inherits nothing. Invalid configuration fails explicitly.

Host startup ensures the shared service is running. Operators can also use:

~~~bash
pinpawo runtime start
pinpawo runtime status
pinpawo runtime stop
~~~

Configuration changes require an explicit service restart and fresh Host
connections. Stopping the service affects all attached Hosts. Closing one Host
releases only its pages and resources; it does not stop the shared service.

## Use browser tools

Open an explicitly reviewed HTTP(S) URL with `browser_open`, then use snapshot,
click, type, scroll, wait, extract and screenshot as needed. There is no arbitrary
CDP-command tool.

- Snapshot previews contain at most 50,000 text characters and 20 interactive
  elements. When `hasMore` is true, use `browser_extract` with successive offsets
  and limits until all required content has been read.
- Click, type and wait accept a CSS/text selector or the latest snapshot's opaque
  `ref`. Refs expire after a new snapshot or navigation. A stale ref requires a
  fresh snapshot.
- Wait supports visible and hidden conditions. Cancelled operations close the
  affected session's owned pages; dispatched interactions are not replayed.
- A popup opened by the active page becomes the active target. When it closes,
  the Runtime returns to its live parent.
- Named sessions use separate browser contexts within the current Host
  connection and thread. They are not Chrome profile names and do not recover
  across a disconnected Host.
- Tool-level `headless` and `userDataDir` requirements must match a managed
  Runtime's configuration. A borrowed browser cannot change these startup
  settings. Configure the intended instance before opening it.

Client, Toolkit and thread identify a session. Two Hosts with the same thread
string cannot access each other's pages, even when they share one Runtime
instance. This resource isolation does not isolate login state in a shared
default browser context.

## Origin checks and browser data

An explicit open establishes the approved origin. Cross-origin redirects and
popups cannot be read, screenshotted or operated until their URL is opened
explicitly for review. A cross-origin popup can be completed manually in a
visible browser, or closed to return to the approved page. Errors indicate when
an interaction may already have been dispatched; do not blindly repeat it.
Pending locator actions are cancelled if their owned page navigates to an
unapproved origin.

Snapshots and text extraction read visible page content. Screenshots may contain
anything visible in the viewport. These results become part of the Agent
conversation and may be sent to the configured model provider. Screenshots are
stored under the execution workdir's `.pinpawo/browser/screenshots/` with private
file permissions, then removed when the owning session is released. Conversation
retention follows the Host's existing configuration.

CDP disconnection invalidates page handles. It does not trigger backend fallback,
transparent reconnection or replay. Runtime diagnostics distinguish borrowed and
managed ownership and report connection state. Unconfirmed cleanup is reported
as an error.

## Verify the installation

~~~bash
npm run typecheck --workspace @pinpawo-toolkit/browser
npm test --workspace @pinpawo-toolkit/browser
npm run test:cdp --workspace @pinpawo-toolkit/browser
~~~

The CDP test starts temporary headless Chrome profiles and loopback-only HTTP
fixtures. It checks real CDP connection, borrowed/managed cleanup, separate
clients, named-context storage isolation, refs, popups, origin enforcement,
bounded extraction, screenshots and cancellation. Chrome must be installed;
unit tests alone do not establish browser support.

Implementation and evidence:
[CDP connection](../../toolkits/browser/src/connection.ts),
[Runtime ownership](../../toolkits/browser/src/runtime.ts),
[page operations](../../toolkits/browser/src/session.ts),
[real Chrome tests](../../toolkits/browser/src/cdp.integration.test.ts).
