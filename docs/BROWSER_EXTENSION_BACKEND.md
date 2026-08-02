# Chrome extension browser backend

The Chrome extension backend uses an existing Chrome installation and its login state. Protocol v2 supports `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_wait`, `browser_extract`, `browser_screenshot` and `browser_close` (debugger detach). Named sessions, custom profiles and headless mode remain Playwright-only semantics.

Architecturally, the extension is a driver of the Browser capability, not a top-level local-agent subsystem. Its Native Messaging host is a private companion process of that driver. Local-agent lifecycle and health code depend only on the Browser runtime boundary; no generic host-server abstraction is introduced until another concrete integration proves the shared contract.

## Fixed backend selection

Set `PINPAWO_BROWSER_BACKEND=extension` (or save `browser_backend: "extension"`) to force the extension. A `BrowserSession` still selects one implementation for its lifetime. There is no dynamic router, mid-session fallback or provider abstraction.

In `auto`, local-agent listens for the installed extension and chooses it first for compatible default-session, visible-browser operations. If no extension is connected, or the initial open explicitly requires headless, a named session or a custom profile, selection uses Playwright. Selection is still one-time for that active `BrowserSession`.

Toolkit availability is structural and cached when the runtime registry is built; transient extension connectivity does not remove the Browser Toolkit. Browser Runtime owns one live extension snapshot that distinguishes bridge listening, Native Host connectivity, extension registration and command readiness. Session selection, Toolkit diagnostics and HTTP health consume that projection instead of independently combining Bridge booleans. A listening bridge without a registered extension remains routable but is not command-ready, so a later reconnect can recover without rebuilding the agent registry.

## Process boundary

```text
local-agent Browser runtime / BrowserSession
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

The local-agent owns commands, deadlines, authorization context and final payload normalization. The native host only translates Chrome's length-prefixed messages to authenticated Unix-socket JSONL. The extension owns tab binding and the narrow CDP execution allowlist.

Only one native-host/extension connection is active. Once an extension is active, additional native-host connections are rejected until it disconnects; this prevents an unpacked development extension and the Web Store extension from displacing each other. A service-worker reconnection for the active extension replaces its old `connectionId` and rejects its pending requests; commands are never replayed across a connection change. Both the extension and Native Host use bounded exponential reconnect backoff with jitter, resetting only after a stable connection; extension diagnostics preserve Chrome's disconnect reason when available. If the local-agent bridge restarts while the native host remains alive, the host drops results and lifecycle events from the disconnected bridge epoch and replays only the latest extension registration so the new bridge can recover safely. Current registrations carry a complete target/debugger state snapshot with a connection-scoped monotonic revision; the bridge ignores duplicate or older revisions. Registrations without that snapshot remain readable for compatibility with an older installed extension.

## Snapshot contract

The extension returns a bounded, backend-level raw snapshot. `parseBrowserRawSnapshot()` validates it before `buildBrowserSnapshotPayload()` creates the agent-facing payload.

The raw and final contracts are intentionally separate:

- Raw extension text is UTF-8 bounded for IPC and includes `textLength` for the full source length.
- Raw interactive elements are capped at 200 and may include CDP `backendNodeId` metadata.
- Runtime snapshots assign opaque element `ref` values backed by a page-local registry; accessibility fallback refs use CDP backend node IDs.
- The shared final builder caps previews at 50,000 characters and 20 interactive elements.
- The builder normalizes each hint to include its stable `[index]` prefix.
- `Runtime.evaluate` is primary. `Accessibility.getFullAXTree` is the fallback when runtime evaluation is unavailable.

These builders are a reusable normalization boundary, not a frozen cross-backend schema. New backend fields must be runtime-validated and covered by compatibility tests before being exposed in the final payload.

## P1 interaction contract

- `browser_click`, `browser_type` and selector-based `browser_wait` accept either the opaque `ref` from the latest snapshot or a CSS / `text=...` selector. Prefer `ref`; take a new snapshot after `stale_element_reference`.
- Click activates the bound target inside the extension, then sends mouse move, hover delay, press and release through CDP `Input.dispatchMouseEvent`. This keeps trusted pointer input reliable if the user switched tabs after binding.
- Type focuses through the trusted click path and selects existing text with a CDP editing command. Normal input uses per-character `Input.dispatchKeyEvent` sequences; large input uses bounded `Input.insertText` chunks so the public `browser_type` contract does not gain a backend-specific length limit.
- Scroll uses `Input.dispatchMouseEvent` with `mouseWheel`; it can be targeted at an element or use the page viewport.
- Wait supports backend-neutral `visible` and `hidden` target conditions. Extension selector waits poll within the caller deadline; stale refs remain explicit except that a detached stale ref already satisfies `hidden`.
- Extract slices text inside the page before IPC and local-agent validates and builds the final chunk metadata.
- Screenshot captures the exact attached viewport through allowlisted CDP, retries with bounded JPEG quality, then local-agent stores the image under `.pinpawo/browser/screenshots/` with mode `0600`.

## Security and tab ownership

- The extension requests `debugger`, `nativeMessaging`, `storage` and `tabs`; it has no broad host permission.
- `browser_open` creates an agent-owned tab if none is bound.
- Clicking the extension action explicitly binds the current user tab and approves only its current http(s) origin for the local-agent Browser session. The approval is held only in the live extension state, is not persisted by the extension, and is never updated by subsequent user navigation; after an extension/service-worker restart the user must click the action again. The health response distinguishes `agent` and `user` ownership.
- Browser commands and target-binding changes run through one extension-owned serial queue. The local-agent tool layer remains backend-neutral and does not impose extension scheduling semantics.
- A popup/new tab whose `openerTabId` is the current target becomes the active browser target. The extension keeps a bounded in-memory target history so closing a popup can return to its live parent; Playwright applies the same active-target behavior inside its own driver.
- Same-origin popups remain fully readable and interactive. A cross-origin popup is followed only for lifecycle recovery: its content, screenshots and trusted input remain blocked, and the user must complete that step manually in visible Chrome. After the popup closes or returns to the previously approved origin, the agent can take a new snapshot and continue.
- Cross-origin popup errors are non-retryable and include `manualActionRequired: true`; a post-click/type failure also includes `interactionDispatched: true` so callers do not replay an interaction that was already sent. There is intentionally no API for silently adopting the popup origin in this phase.
- Each navigation carries an origin already authorized by the local-agent review policy.
- Before and after every read, interaction result and screenshot, the extension reads the committed top-level URL through CDP and refuses access if the origin changed. Trusted mouse/key events and bulk text chunks also re-check the origin immediately before dispatch. The extension checks returned payload URLs, and local-agent repeats that check before building final payloads.
- CDP remains allowlisted. Protocol v2 adds only the `Input.dispatch*`, viewport screenshot and DOM box/scroll commands required by the declared Browser operations; arbitrary CDP is never relayed.
- The socket directory is mode `0700`; the socket and per-run random token file are mode `0600`. The token is removed when the local-agent stops.
- Protocol messages include `protocolVersion`, `connectionId`, `requestId` and `deadlineAt`; malformed, stale and oversized messages fail closed.
- Driver failures retain structured `code`, `retryable` and safe `details` fields through the bridge. Cross-origin failures expose origins only, never an unapproved URL path or query.

## Build and install

```bash
npm run build
npm run test:browser-smoke -w pinpawo
npm run test:browser-extension-smoke -w pinpawo
```

Both smoke tests use the same loopback-only fixture: delayed SPA-style content,
long-content extraction in consecutive chunks, opaque-ref form type/click, scrolling,
and parent page → popup → parent fallback. The first runs headless with Playwright;
the extension smoke requires the unpacked extension and registered Native Host in the
user’s Chrome. The extension smoke also verifies the cross-origin popup safety path:
the dispatched click reports manual takeover without exposing its URL path, then the
fixture closes the popup so the agent can recover the original page, and restarts the
local bridge to verify re-authentication and target recovery. It is the baseline
regression set, not evidence that iframe, dialogs, file transfer, or shadow-DOM support
is complete.

Each smoke ends with one URL-free `[browser-evaluation]` JSON record. It includes the
driver, scenario, overall status, first-pass and recovery outcomes, per-phase duration,
and a stable final error code when a phase fails. Keep these records with CI or manual
run output when deciding whether a repeated failure should become a focused Browser
issue; they are not product telemetry and do not persist page content or URLs.

Then:

1. Open `chrome://extensions` and enable Developer mode.
2. Load `tools/chrome-extension/dist` as an unpacked extension. For an installed npm package, use the bundled `extensionPath` printed by `pinpawo browser extension status`.
3. Copy the extension ID shown by Chrome.
4. Register the exact allowed extension origin:

   ```bash
   pinpawo browser extension register --extension-id <id>
   ```

5. Restart the agent. `auto` uses the connected extension first; set `PINPAWO_BROWSER_BACKEND=extension` when you want to require it.

Inspect host registration and bridge runtime-file diagnostics with:

```bash
pinpawo browser extension status
```

The `host.healthy` field verifies the Native Messaging wrapper is executable, its
entry exists, and at least one installed manifest points at that wrapper with an
allowed extension ID. If `host.repairRecommended` is true, repair the registration
and restart the local agent:

```bash
pinpawo browser extension repair
```

The running local-agent HTTP health response keeps the cached Toolkit selection in `browser_mode`, while always exposing the live extension runtime state plus separate bridge, host, extension command-readiness, debugger and target fields. This keeps Extension diagnostics visible even when `auto` initially selected Playwright for Toolkit availability. Remove registration with `pinpawo browser extension unregister`.

## Attribution

The Native Messaging/extension architecture and selected registration patterns were adapted with reference to [`hangwin/mcp-chrome`](https://github.com/hangwin/mcp-chrome). The upstream project is MIT licensed; its notice is retained in `tools/chrome-extension/THIRD_PARTY_NOTICES.md`.
