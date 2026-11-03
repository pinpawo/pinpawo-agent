# Artifacts Toolkit

`@pinpawo-toolkit/artifacts` provides explicit session file publishing and
on-demand downloads. The Host supplies storage and local-file access; the
Toolkit defines tool calls, instructions and review policy.

```ts
import {
  createArtifactsToolkit,
  type ArtifactSourceReader,
  type ArtifactStore,
} from '@pinpawo-toolkit/artifacts';

function assembleArtifacts(store: ArtifactStore, sourceReader: ArtifactSourceReader) {
  return createArtifactsToolkit({ store, sourceReader });
}
```

A Capability must declare `artifacts` in its `uses` allowlist. Host composition
registers the Toolkit, and the built-in General Capability declares it explicitly.
The toolkit requires an Agent session execution context; session identity is
not a model-supplied tool argument.

| Tool | Behavior | Review |
|---|---|---|
| `publish_artifact(path, title?)` | Copies a file snapshot into the configured store. Returns its stable reference and Markdown link, and declares it as a deliverable. | No additional review |
| `list_artifacts()` | Lists publications for the current workspace and session. | No additional review |
| `download_artifact(uri, path?)` | Resolves a received reference and writes verified bytes locally. Returns a local path for ordinary file tools. | Default session temporary path needs no review; a selected path outside the managed temporary area requires exact write authorization. |

Publishing has a 100,000,000-byte limit and reports an error without truncation.
Publishing the same file again creates a new snapshot. Editing or deleting the
source file does not alter an earlier publication. There is no session-wide
storage quota in this contract.

`ArtifactStore` exposes streaming `put`, session-scoped `list`, and `fetch`.
Fetch returns either a readable body or a temporary download URL with an expiry.
`ArtifactSourceReader` resolves a file path using the call's workdir and returns
a filename, MIME type and readable body. The Toolkit has no dependency on a
concrete local or COS adapter.

Share `artifact://` references, never temporary signed URLs. A recipient can
download a reference from another session or workspace supported by the Host's
configured store. Listing remains scoped to the current session. Downloads
verify the stored size and SHA-256 before replacing the destination.

See [Artifacts reference](../../docs/reference/artifacts/index.md) for adapter
configuration, HTTP access and browser CORS requirements, and
[Deliverables](../../docs/reference/deliverables.md) for reply propagation.
The [Session Artifacts design](../../docs/design/agent-runtime/session-artifacts.md)
remains a draft; its implementation status separates tests from live-service
validation.

Development commands from the repository root:

```sh
npm run typecheck -w @pinpawo-toolkit/artifacts
npm run test -w @pinpawo-toolkit/artifacts
npm run build -w @pinpawo-toolkit/artifacts
```
