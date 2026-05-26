# Web Research Brief Capability

This is a complete example project for a user-defined PinPawo capability. It is intentionally dependency-free so it can be copied into `~/.pinpawo/capabilities/web_research_brief` and loaded by `services/local-agent`.

## What This Example Demonstrates

- A searchable `manifest.json` description with user-facing keywords.
- An `index.js` that defines a focused execution capability, not a plugin-authoring assistant.
- Runtime instructions that state scope, preferred tools, fallback rules, output shape, and safety boundaries.
- A smoke test that validates the exported capability and checks for the important behavioral instructions.

## Files

- `manifest.json`: UI metadata and capability discovery text.
- `index.js`: runtime entry loaded by local-agent.
- `index.test.mjs`: dependency-free smoke test.
- `package.json`: optional local test script.

## Capability Boundary

This capability handles public static web content and API-style responses through `http_fetch`.

It does not handle:

- logged-in pages
- browser cookies
- JavaScript-rendered pages
- clicks, forms, or interactive flows
- actions that mutate local files or remote services

Those cases should route to a browser or another more specific capability.

## Validate

```bash
npm test
```

or:

```bash
node index.test.mjs
```

## How To Adapt This Example

When creating a new capability:

1. Keep the project shape: `manifest.json`, `index.js`, `README.md`, and a smoke test.
2. Rewrite `description` with terms a user would actually type.
3. Rewrite `runtime.instructions` around the target task's execution workflow.
4. Name preferred tools explicitly, and state when generic tools such as `run_shell` are only a fallback.
5. Remove meta-instructions about creating or validating capability files unless the capability itself is for plugin maintenance.
