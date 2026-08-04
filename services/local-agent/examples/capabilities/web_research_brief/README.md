# Web Research Brief Capability

This is a complete Capability V2 example. It is intentionally dependency-free so it can be copied into `~/.pinpawo/capabilities/web_research_brief` and loaded by `services/local-agent`.

## What This Example Demonstrates

- A searchable `CAPABILITY.md` description with user-facing routing keywords.
- A minimal `uses` list that forms the complete Toolkit permission boundary.
- Instructions that state scope, preferred tools, fallback rules, output shape, and safety boundaries.
- A portable smoke test that checks the document structure after the directory is copied.

## Files

- `CAPABILITY.md`: routing metadata, Toolkit dependencies, and immutable instructions.
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

1. Keep `CAPABILITY.md` as the only required file; README, package metadata, and smoke tests are optional.
2. Rewrite `description` with terms a user would actually type.
3. Rewrite the Markdown body around the target task's reusable execution workflow.
4. Name preferred tools explicitly, and state when generic tools such as `run_shell` are only a fallback.
5. Keep `uses` to the smallest set of registered Toolkits needed by that workflow.
6. Add `entry: ./index.js` only when deterministic finalize-only result processing is required.
