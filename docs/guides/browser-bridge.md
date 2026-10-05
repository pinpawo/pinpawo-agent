# Chrome extension browser

**Audience:** operators who need the agent to use an existing Chrome session.
Install the CLI first with [Getting started](getting-started.md).
For supported operations and security rules, use the
[Browser contract](../reference/local-tools/browser.md).

## Build and install

If you use a repository checkout, build it first:

```bash
npm run build
```

If you use an installed npm package, find the bundled extension with:

```bash
pinpawo browser extension status
```

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Load the extension directory as an unpacked extension.

   For a checkout, use `toolkits/browser/dist/hosts/chrome-extension/extension`.
   For an installed package, use the reported `bundledExtensionPath`.

4. Copy the extension ID shown by Chrome.
5. Register that ID:

   ```bash
   pinpawo browser extension register --extension-id <id>
   ```

6. Reload the extension.

The RS service keeps the bridge listening. You do not need to restart the agent.

Inspect host registration and the RS service's bridge state with:

```bash
pinpawo browser extension status
```

The `host.healthy` field verifies the Native Messaging wrapper is executable, its
entry exists, and at least one installed manifest points at that wrapper with an
allowed extension ID. The `service` field reports whether the RS service runs and,
for BrowserRS, the extension state and whether it is command-ready. If
`host.repairRecommended` is true, repair registration with the same extension ID:

```bash
pinpawo browser extension repair --extension-id <id>
```

After repair, reload the extension and run the status command again.
Use extension status for Browser details. `/health` reports Host service health.
The [availability contract](../reference/local-tools/browser.md#availability)
explains diagnostics ownership.

To remove registration, run:

```bash
pinpawo browser extension unregister
```

## Developer acceptance checks

After the extension and Native Host are registered, run the service smoke check
from a repository checkout:

```bash
npm run test:browser-rs-service-smoke -w pinpawo
```

`test:browser-rs-service-smoke` drives the scenario the way a Host does: through
`BrowserRSClient` and the RS service (started if none runs, and left running).
Its last phase restarts the "Host" — a new client continues the same Agent
session on the page opened before. `test:browser-extension-smoke` runs the same
scenario straight against the bridge, and its last phase restarts the bridge to
verify re-authentication; the RS service normally holds the bridge socket, so
run `pinpawo rs stop` first.

The smoke test uses a loopback-only fixture: delayed SPA-style content,
long-content extraction in consecutive chunks, opaque-ref form type/click, scrolling,
and parent page → popup → parent fallback. It requires the unpacked extension and
registered Native Host in the user’s Chrome. It also verifies the cross-origin popup safety path:
the dispatched click reports manual takeover without exposing its URL path, then the
fixture closes the popup so the agent can recover the original page, and then proves one
recovery (a Host restart through the service, or a bridge restart). It is the baseline
regression set, not evidence that iframe, dialogs, file transfer, or shadow-DOM support
is complete.

The smoke ends with one URL-free `[browser-evaluation]` JSON record. It includes the
driver, scenario, overall status, first-pass and recovery outcomes, per-phase duration,
and a stable final error code/category when a phase fails. Categories cover
snapshot/content, ref/selector, frame/shadow, stability/wait, target lifecycle,
origin/manual takeover, dialog, file transfer, and bridge lifecycle. Keep these records
with CI or manual run output when deciding whether a repeated failure should become a
focused Browser issue; they are not product telemetry and do not persist page content
or URLs.

## Contract details

The following headings preserve existing links to the protocol documentation.

## Availability

See [Availability](../reference/local-tools/browser.md#availability).

## Process boundary

See [Process boundary](../reference/local-tools/browser.md#process-boundary).

## Snapshot contract

See [Snapshot contract](../reference/local-tools/browser.md#snapshot-contract).

## P1 interaction contract

See [P1 interaction contract](../reference/local-tools/browser.md#p1-interaction-contract).

## Security and tab binding

See [Security and tab binding](../reference/local-tools/browser.md#security-and-tab-binding).

## Attribution

See the [implementation attribution](../reference/local-tools/browser.md#attribution).
