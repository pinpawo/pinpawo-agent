# PinPawo Browser Bridge

This MV3 extension is the Browser Toolkit's Chrome companion. It connects one Chrome tab to a running PinPawo local agent through Chrome Native Messaging. Protocol v3 supports navigation, snapshot, trusted click/type/scroll input, wait, chunked text extraction, viewport screenshots and debugger detach.

The extension is developed as a standalone workspace package. A local-agent build bundles its output beside the Browser Toolkit native host at `dist/toolkits/browser/chrome-extension`.

## Development setup

1. Run the repository `npm run build` (or `npm run build` in this directory).
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `tools/chrome-extension/dist`. A packaged local-agent also reports its `bundledExtensionPath` through `pinpawo browser extension status`.
3. Copy the extension ID shown by Chrome.
4. Run `pinpawo browser extension register --extension-id <id>`. Registration preserves previously approved development and Web Store extension IDs.
5. Set `PINPAWO_BROWSER_BACKEND=extension` and start the local agent.

For the official Chrome Web Store build, `pinpawo browser extension register`
uses the Store extension ID by default, so `--extension-id` is not required.

`browser_open` creates a dedicated agent-owned tab by default. To bind a user tab explicitly, focus it and click the extension action. Chrome shows its debugger disclosure while PinPawo is attached.

The extension refuses to read or interact with a tab after it leaves the origin approved for the current browser operation. Interaction commands prefer the opaque `ref` returned by the latest snapshot and fall back to CSS or `text=...` selectors. Re-snapshot after a stale reference error.

The service worker serializes browser commands and tab-binding changes. Normal typing uses trusted key events; large text is inserted in bounded trusted chunks without changing the `browser_type` tool contract.
