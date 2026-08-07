# Chrome Web Store release

- Store item ID: `dkbghohaagjejhckdigepccecifkbklo`
- Distribution: Private
- Category: Developer Tools
- Primary language: English (United States)
- Privacy notice: `docs/browser-extension-privacy.md`

## Package

Run:

```bash
npm run test -w @pinpawo-toolkit/browser
npm run build -w @pinpawo-toolkit/browser
```

Create the upload ZIP from the contents of `toolkits/browser/dist/hosts/chrome-extension/extension` so
`manifest.json` is at the archive root. Do not zip the `dist` directory itself.

The package version must be higher than the version most recently uploaded to
the Store item.

## Private test installation

1. Add the tester account or a tester-owned Google Group in the Web Store
   publisher settings.
2. Install the Private Store item while signed in as that tester.
3. Install PinPawo local-agent and run
   `pinpawo browser extension register`.
4. Start local-agent with the extension browser backend enabled.
5. Bind a safe test tab through the extension action and verify snapshot,
   navigation, click, type, scroll, screenshot, popup recovery, and detach.

An unpacked development extension can coexist with the Store build. Register
its ID once with `--extension-id`; subsequent registration of the Store build
preserves both exact origins.
