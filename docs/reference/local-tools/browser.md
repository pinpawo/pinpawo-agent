# Chrome Extension Browser Contract

> **Status: current operation reference.** For installation and diagnosis,
> follow [Browser bridge setup](../../guides/browser-bridge.md).

The Chrome extension uses an existing Chrome installation and its login state. Protocol v3 supports `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_wait`, `browser_extract`, `browser_screenshot` and `browser_close` (debugger detach). This is Browser's only execution path: there is no Playwright driver, backend selection, named session, custom profile or headless mode.

Architecturally, the extension is a driver inside BrowserRS
(`ChromeExtensionBrowserRS`), not a driver of the Browser Capability and not a
top-level host subsystem. Its Native Messaging host is a private
companion process of that RS. BrowserRS runs in the local RS service (#862),
which owns the one bridge, its live snapshot and every Agent session's
`BrowserSession`; Hosts reach it through `BrowserRSClient`, so several Hosts
share one extension connection and a Browser session survives a Host restart.
The Browser Capability only declares `uses: ['browser']`. No Browser-specific
branch belongs in the generic Host or Agent lifecycle. See
[Toolkit RS](../extensions/toolkit-rs.md) and the accepted
[domain constraints](../../design/host-agent-capability-toolkit.md).

## Availability

Toolkit availability is structural and cached when the runtime registry is built; transient extension connectivity does not remove the Browser Toolkit. Browser Runtime owns one live extension snapshot that distinguishes bridge listening, Native Host connectivity, extension registration and command readiness. Session selection and Browser-specific status views consume that projection instead of independently combining Bridge booleans. Under #645, a generic Toolkit Runtime diagnostics surface will carry the same state as Browser-owned details rather than creating a Browser-only diagnostics lifecycle. A listening bridge without a registered extension remains routable but is not command-ready, so a later reconnect can recover without rebuilding the agent registry.

## Process boundary

```text
Host (Chat / Studio) ── BrowserRSClient
        │ RS service socket + token (~/.pinpawo/rs/rs.sock)
        ▼
RS service: ChromeExtensionBrowserRS / BrowserSession per Agent session
        │ versioned JSONL + per-run token
        ▼
Unix socket (~/.pinpawo/run/browser-bridge.sock)
        │
        ▼
independent Native Messaging host (stdio framing only)
        │ chrome.runtime.connectNative
        ▼
MV3 service worker ── chrome.debugger / allowlisted CDP ── one Chrome tab
```

The RS service owns commands, deadlines and final payload normalization; the Host keeps review and origin approval. The native host only translates Chrome's length-prefixed messages to authenticated Unix-socket JSONL. The extension owns tab binding and the narrow CDP execution allowlist.

Only one native-host/extension connection is active. Once an extension is active, additional native-host connections are rejected until it disconnects; this prevents an unpacked development extension and the Web Store extension from displacing each other. A service-worker reconnection for the active extension replaces its old `connectionId` and rejects its pending requests; commands are never replayed across a connection change. Both the extension and Native Host use bounded exponential reconnect backoff with jitter, resetting only after a stable connection; extension diagnostics preserve Chrome's disconnect reason when available. If the host bridge restarts while the native host remains alive, the host drops results and lifecycle events from the disconnected bridge epoch and replays only the latest extension registration so the new bridge can recover safely. Current registrations carry a complete target/debugger state snapshot with a connection-scoped monotonic revision; the bridge ignores duplicate or older revisions. Registrations without that snapshot remain readable for compatibility with an older installed extension.

## Snapshot contract

Snapshots follow the industry shape (#873): an accessibility-tree outline rather than flattened page text. The extension renders Chrome's `Accessibility.getFullAXTree` as indented lines, `- role "name" [state] [ref=…]` per meaningful node and `- text: "…"` for page text; `parseBrowserRawSnapshot()` validates it before `buildBrowserSnapshotPayload()` creates the agent-facing payload.

- Roles, names and states (`checked`, `expanded`/`collapsed`, `disabled`, `selected`, `pressed`, `required`, `focused`, `level`) come from Chrome's own accessibility computation. The extension only prunes: ignored nodes and unnamed layout containers are dropped with their children lifted, inline text boxes, line breaks and list markers are skipped, text a named ancestor already carries (a link's or heading's own label) is not repeated, and adjacent text runs merge.
- Interactive roles (links, buttons, form controls, options, tabs, …) carry accessibility refs bound to the document they were read from (see #869 P1): `ax:<first 8 characters of the main-frame loaderId>:<backendNodeId>:<role>`. The loader is read before the tree, so a navigation in between leaves refs stale rather than mislabelled.
- Field values appear as `[value="…"]`. Values of passwords, card data and one-time codes are `[value=redacted]`: after reading the tree the extension asks the page for those inputs (including open shadow roots), maps each to its backend node through `Runtime.getProperties` and `DOM.describeNode`, and releases the handles. If the lookup fails or any input cannot be mapped, every field value is redacted.
- When Chrome's tree is unavailable, the page-side DOM snapshot (body text plus interactive elements with page-registry refs) stands in, rendered in the same outline shape with `source: "dom"`.
- `browser_snapshot` can narrow the tree (#873 3b): `ref` / selector renders only that element's subtree (an accessibility ref is checked against the current loader; a DOM ref or selector is mapped to its backend node through `DOM.describeNode`), `depth` stops at that many levels and reports `depthLimited`, and `interactiveOnly` lists only interactive nodes, flat and without page text. Interaction results always carry the full tree. A narrowed request never falls back to the DOM snapshot, and the extension echoes the options it `applied` so the Host reports an extension that ignores them as `browser_extension_outdated`.
- The raw tree is UTF-8 bounded for IPC and reports its full `treeLength`. The final payload shows at most 50,000 characters of tree, cut at a line boundary, with `truncated`, `refCount` and a `note` that points to `browser_extract` for long text.

These builders are a reusable normalization boundary, not a frozen cross-backend schema. New backend fields must be runtime-validated and covered by compatibility tests before being exposed in the final payload.

## P1 interaction contract

- `browser_click`, `browser_type` and selector-based `browser_wait` accept either the opaque `ref` from the latest snapshot or a CSS / `text=...` selector. Prefer `ref`; take a new snapshot after `stale_element_reference`.
- Click activates the bound target inside the extension, then sends mouse move, hover delay, press and release through CDP `Input.dispatchMouseEvent`. This keeps trusted pointer input reliable if the user switched tabs after binding.
- Type focuses through the trusted click path and selects existing text with a CDP editing command. Normal input uses per-character `Input.dispatchKeyEvent` sequences; large input uses bounded `Input.insertText` chunks so the public `browser_type` contract does not gain a backend-specific length limit.
- Scroll uses `Input.dispatchMouseEvent` with `mouseWheel`; it can be targeted at an element or use the page viewport.
- Wait supports backend-neutral `visible` and `hidden` target conditions. Extension selector waits poll within the caller deadline; stale refs remain explicit except that a detached stale ref already satisfies `hidden`.
- Extract slices text inside the page before IPC and host validates and builds the final chunk metadata.
- Screenshot captures the attached viewport by default, one element (`ref` / selector), or the whole scrollable page (`fullPage`) through allowlisted CDP (#873). Element and full-page captures clip in document coordinates (`Page.getLayoutMetrics` after the target is scrolled into view); regions taller than 8,000 CSS px keep only their top part and report `truncated`. Region scales are expressed in CSS pixels and divided by `devicePixelRatio` (CDP `clip.scale` multiplies it): an element starts at native sharpness, a full page at one output pixel per CSS pixel, and oversized results step down in JPEG quality and scale, then host stores the image under `.pinpawo/browser/screenshots/` with mode `0600` and records the captured `scope`. An extension that returns a different scope than requested (built before #873) is reported as `browser_extension_outdated` instead of being passed off as the region.

## Security and tab binding

- The extension requests `debugger`, `nativeMessaging`, `storage` and `tabs`; it has no broad host permission.
- `browser_open` creates an agent-owned tab if none is bound.
- Each Agent session's tabs live in its own Chrome tab group (#867), titled once, with a paw mark and the site of the first page the session opens (`🐾 github.com`); colors rotate in creation order so sessions on one site still differ (the extension never learns which conversation a context belongs to). The group is created on the session's first `browser_open`; the tab it opens and same-window popups join it. Tabs Chrome refuses to group (for example in a popup window) remain usable through the extension's target history.
- The user hands a tab to a session by dragging it into that session's group. This approves only the tab's current http(s) origin and makes it the session's current tab, with the previous one kept as the fallback; the next result carries a one-time `handoff` note so the model knows the page changed. Dragging a tab out, or ungrouping it, releases it from the session (the debugger detaches if it was attached, and no other tab is focused). Like the extension-action binding it replaces, the approval is held only in the live extension state, is not persisted, and is never updated by later user navigation. `browser_open` never navigates a handed-over tab; it opens an agent tab in the group and keeps the handed-over tab as a fallback.
- The extension reports every context's current tab and user grant in its registration state (`state.contexts`); each Host session reads only its own context, so one session's hand-off never changes another session's approved origin (#871). The extension action no longer binds tabs. This Browser-only binding is unrelated to delegation execution ownership.
- Browser commands and target-binding changes run through one extension-owned serial queue. The host tool layer remains backend-neutral and does not impose extension scheduling semantics.
- Tool cancellation propagates through the Browser session and local bridge as a connection-scoped `browser.cancel` message. The extension observes cancellation before a queued command begins and at bounded wait/type/action safe points; it does not undo an input event that Chrome has already dispatched, and cancelled commands are never retried or replayed. Take a fresh snapshot before deciding what, if anything, needs to happen next.
- A popup/new tab whose `openerTabId` is the current target becomes the active browser target. The extension keeps a bounded in-memory target history so closing a popup can return to its live parent.
- Same-origin popups remain fully readable and interactive. A cross-origin popup is followed only for lifecycle recovery: its content, screenshots and trusted input remain blocked, and the user must complete that step manually in visible Chrome. After the popup closes or returns to the previously approved origin, the agent can take a new snapshot and continue.
- Cross-origin popup errors are non-retryable and include `manualActionRequired: true`; a post-click/type failure also includes `interactionDispatched: true` so callers do not replay an interaction that was already sent. There is intentionally no API for silently adopting the popup origin in this phase.
- Each navigation carries an origin already authorized by the host review policy.
- Before and after every read, interaction result and screenshot, the extension reads the committed top-level URL through CDP and refuses access if the origin changed. Trusted mouse/key events and bulk text chunks also re-check the origin immediately before dispatch. The extension checks returned payload URLs, and host repeats that check before building final payloads.
- CDP remains allowlisted. Protocol v3 permits only the `Input.dispatch*`, viewport screenshot, DOM box/scroll and read-only page identity, layout and node lookups (`Page.getFrameTree`, `Page.getNavigationHistory`, `Page.getLayoutMetrics`, `DOM.describeNode`, `Runtime.getProperties`, `Runtime.releaseObjectGroup`) commands required by the declared Browser operations; arbitrary CDP is never relayed.
- The socket directory is mode `0700`; the socket and per-run random token file are mode `0600`. The token is removed when the RS service stops.
- Protocol messages include `protocolVersion`, `connectionId`, `requestId` and `deadlineAt`; malformed, stale and oversized messages fail closed.
- Driver failures retain structured `code`, `retryable` and safe `details` fields through the bridge. Cross-origin failures expose origins only, never an unapproved URL path or query.

## Attribution

The Native Messaging/extension architecture and selected registration patterns were adapted with reference to [`hangwin/mcp-chrome`](https://github.com/hangwin/mcp-chrome). The upstream project is MIT licensed; its notice is retained in `toolkits/browser/src/hosts/chromeExtension/extension/THIRD_PARTY_NOTICES.md`.
