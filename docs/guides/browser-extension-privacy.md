# PinPawo Browser Bridge Privacy Notice

Last updated: July 25, 2026

PinPawo Browser Bridge connects a Chrome tab explicitly approved by the user to
a locally running PinPawo agent. This notice describes the data handled by the
Chrome extension and its Native Messaging connection.

## Data the extension handles

For the tab currently bound to PinPawo, the extension may process:

- the current page URL and title;
- visible page text, links, and interactive-element metadata;
- viewport screenshots requested by the user or agent workflow;
- navigation, click, typing, scrolling, waiting, extraction, and detach
  commands requested through the local agent.

DOM snapshots redact password fields and fields identified by standard browser
autocomplete tokens for passwords, one-time codes, and payment-card numbers or
security codes. Screenshots may still contain any information visibly rendered
in the captured viewport.

## How data is used and transferred

The extension sends data only through Chrome Native Messaging to the PinPawo
native host installed on the same computer. The native host forwards the data
to the locally running PinPawo agent so it can complete the browser task
requested by the user.

Depending on the user's local-agent configuration, the local agent may send
page content or screenshots to the model provider selected by the user to
interpret the page and decide the requested browser actions. Processing by that
provider is governed by the provider configuration and terms selected by the
user.

PinPawo does not sell browser data, use it for advertising, use it to determine
creditworthiness, or transfer it for purposes unrelated to the browser task
requested by the user.

## Storage and retention

The extension stores only the bound-tab and session metadata needed to recover
safely after a Manifest V3 service-worker suspension. It does not persist page
snapshots, extracted text, screenshots, or browsing history in
`chrome.storage`.

The local agent may retain conversation or session records according to the
user's local configuration. Users control the local files and configured model
provider associated with those records.

## User controls

The user explicitly binds a tab or asks the local agent to open a dedicated
tab. The extension checks the approved origin before reading or interacting
with a page and does not automatically approve a cross-origin popup. Users can
detach the browser connection or unregister the Native Messaging host at any
time.

## Permissions

- `debugger` provides bounded page snapshots, screenshots, and trusted browser
  interactions in the bound tab.
- `nativeMessaging` connects the extension to the locally installed PinPawo
  native host.
- `storage` preserves bound-tab and session metadata across service-worker
  suspension.
- `tabs` tracks the bound tab and its approved popup lifecycle.

## Contact

Questions and privacy requests can be submitted through the
[PinPawo issue tracker](https://github.com/pinpawo/pinpawo-agent/issues).
