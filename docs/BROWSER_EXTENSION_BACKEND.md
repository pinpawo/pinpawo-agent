# Chrome extension browser backend

The Chrome extension backend is an opt-in P0 path for using an existing Chrome installation and its login state. It is deliberately smaller than the Playwright backend: it supports `browser_open`, `browser_snapshot` and `browser_close` (debugger detach). Click, type, wait, extract, named sessions, custom profiles and headless mode are not part of P0.

## Fixed backend selection

Set `PINPAWO_BROWSER_BACKEND=extension` (or save `browser_backend: "extension"`). A `BrowserSession` selects one implementation for its lifetime. There is no dynamic router, runtime fallback or provider abstraction.

`auto` continues to mean Playwright detection. It does not select or fall back to the extension backend, because extension use requires explicit installation and Chrome permission.

## Process boundary

```text
local-agent BrowserSession
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
- The shared final builder caps previews at 50,000 characters and 20 interactive elements.
- The builder normalizes each hint to include its stable `[index]` prefix.
- `Runtime.evaluate` is primary. `Accessibility.getFullAXTree` is the fallback when runtime evaluation is unavailable.

These builders are a reusable normalization boundary, not a frozen cross-backend schema. New backend fields must be runtime-validated and covered by compatibility tests before being exposed in the final payload.

## Security and tab ownership

- The extension requests `debugger`, `nativeMessaging`, `storage` and `tabs`; it has no broad host permission.
- `browser_open` creates an agent-owned tab if none is bound.
- Clicking the extension action explicitly binds the current user tab. The health response distinguishes `agent` and `user` ownership.
- Each navigation carries an origin already authorized by the local-agent review policy.
- Before and after every snapshot, the extension reads the committed top-level URL through CDP and refuses data access if the origin changed. The extension also checks the snapshot's own URL, and local-agent repeats that check before building the final payload.
- Only `Page.navigate`, `Page.getNavigationHistory`, `Runtime.evaluate` and `Accessibility.getFullAXTree` are issued in P0, plus debugger attach/detach.
- The socket directory is mode `0700`; the socket and per-run random token file are mode `0600`. The token is removed when the local-agent stops.
- Protocol messages include `protocolVersion`, `connectionId`, `requestId` and `deadlineAt`; malformed, stale and oversized messages fail closed.

## Build and install

```bash
npm run build
```

Then:

1. Open `chrome://extensions` and enable Developer mode.
2. Load `tools/chrome-extension/dist` as an unpacked extension. For an installed npm package, use the bundled `extensionPath` printed by `pinpawo-agent browser-extension status`.
3. Copy the extension ID shown by Chrome.
4. Register the exact allowed extension origin:

   ```bash
   pinpawo-agent browser-extension register --extension-id <id>
   ```

5. Set `PINPAWO_BROWSER_BACKEND=extension` and restart the agent.

Inspect host registration and bridge runtime-file diagnostics with:

```bash
pinpawo-agent browser-extension status
```

The running local-agent HTTP health response exposes separate host, extension, debugger and target fields while extension mode is selected. Remove registration with `pinpawo-agent browser-extension unregister`.

## Attribution

The Native Messaging/extension architecture and selected registration patterns were adapted with reference to [`hangwin/mcp-chrome`](https://github.com/hangwin/mcp-chrome). The upstream project is MIT licensed; its notice is retained in `tools/chrome-extension/THIRD_PARTY_NOTICES.md`.
