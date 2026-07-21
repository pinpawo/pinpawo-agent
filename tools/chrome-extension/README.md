# PinPawo Browser Bridge

This MV3 extension connects one Chrome tab to a running PinPawo local agent through Chrome Native Messaging. The P0 capability set is intentionally limited to navigation, snapshot and debugger detach.

## Development setup

1. Run the repository `npm run build` (or `npm run build` in this directory).
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `tools/chrome-extension/dist`. A packaged local-agent also reports its bundled extension path through `pinpawo-agent browser-extension status`.
3. Copy the extension ID shown by Chrome.
4. Run `pinpawo-agent browser-extension register --extension-id <id>`.
5. Set `PINPAWO_BROWSER_BACKEND=extension` and start the local agent.

`browser_open` creates a dedicated agent-owned tab by default. To bind a user tab explicitly, focus it and click the extension action. Chrome shows its debugger disclosure while PinPawo is attached.

The extension refuses to snapshot a tab after it leaves the origin approved for the current browser operation.
