# Chrome extension browser backend

The Chrome extension backend uses an existing Chrome installation and its login state. Protocol v2 supports `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_wait`, `browser_extract`, `browser_screenshot` and `browser_close` (debugger detach). Named sessions, custom profiles and headless mode remain Playwright-only semantics.

Architecturally, the extension is a driver of the Browser capability, not a top-level local-agent subsystem. Its Native Messaging host is a private companion process of that driver. Local-agent lifecycle and health code depend only on the Browser runtime boundary; no generic host-server abstraction is introduced until another concrete integration proves the shared contract.

## Fixed backend selection

Set `PINPAWO_BROWSER_BACKEND=extension` (or save `browser_backend: "extension"`) to force the extension. A `BrowserSession` still selects one implementation for its lifetime. There is no dynamic router, mid-session fallback or provider abstraction.

In `auto`, local-agent listens for the installed extension and chooses it first for compatible default-session, visible-browser operations. If no extension is connected, or the initial open explicitly requires headless, a named session or a custom profile, selection uses Playwright. Selection is still one-time for that active `BrowserSession`.

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

Only one native-host/extension connection is active. Reconnection replaces the old `connectionId` and rejects its pending requests; commands are never replayed across a connection change.

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
- Click sends mouse move, hover delay, press and release through CDP `Input.dispatchMouseEvent`.
- Type focuses through the trusted click path and selects existing text with a CDP editing command. Normal input uses per-character `Input.dispatchKeyEvent` sequences; large input uses bounded `Input.insertText` chunks so the public `browser_type` contract does not gain a backend-specific length limit.
- Scroll uses `Input.dispatchMouseEvent` with `mouseWheel`; it can be targeted at an element or use the page viewport.
- Extract slices text inside the page before IPC and local-agent validates and builds the final chunk metadata.
- Screenshot captures the exact attached viewport through allowlisted CDP, retries with bounded JPEG quality, then local-agent stores the image under `.pinpawo/browser/screenshots/` with mode `0600`.

## Security and tab ownership

- The extension requests `debugger`, `nativeMessaging`, `storage` and `tabs`; it has no broad host permission.
- `browser_open` creates an agent-owned tab if none is bound.
- Clicking the extension action explicitly binds the current user tab. The health response distinguishes `agent` and `user` ownership.
- Browser commands and target-binding changes run through one extension-owned serial queue. The local-agent tool layer remains backend-neutral and does not impose extension scheduling semantics.
- Each navigation carries an origin already authorized by the local-agent review policy.
- Before and after every read, interaction result and screenshot, the extension reads the committed top-level URL through CDP and refuses access if the origin changed. Trusted mouse/key events and bulk text chunks also re-check the origin immediately before dispatch. The extension checks returned payload URLs, and local-agent repeats that check before building final payloads.
- CDP remains allowlisted. Protocol v2 adds only the `Input.dispatch*`, viewport screenshot and DOM box/scroll commands required by the declared Browser operations; arbitrary CDP is never relayed.
- The socket directory is mode `0700`; the socket and per-run random token file are mode `0600`. The token is removed when the local-agent stops.
- Protocol messages include `protocolVersion`, `connectionId`, `requestId` and `deadlineAt`; malformed, stale and oversized messages fail closed.

## Build and install

```bash
npm run build
```

Then:

1. Open `chrome://extensions` and enable Developer mode.
2. Load `tools/chrome-extension/dist` as an unpacked extension. For an installed npm package, use the bundled `extensionPath` printed by `pinpawo-agent browser extension status`.
3. Copy the extension ID shown by Chrome.
4. Register the exact allowed extension origin:

   ```bash
   pinpawo-agent browser extension register --extension-id <id>
   ```

5. Restart the agent. `auto` uses the connected extension first; set `PINPAWO_BROWSER_BACKEND=extension` when you want to require it.

Inspect host registration and bridge runtime-file diagnostics with:

```bash
pinpawo-agent browser extension status
```

The running local-agent HTTP health response exposes separate host, extension, debugger and target fields while extension mode is selected. Remove registration with `pinpawo-agent browser extension unregister`.

## Attribution

The Native Messaging/extension architecture and selected registration patterns were adapted with reference to [`hangwin/mcp-chrome`](https://github.com/hangwin/mcp-chrome). The upstream project is MIT licensed; its notice is retained in `tools/chrome-extension/THIRD_PARTY_NOTICES.md`.
