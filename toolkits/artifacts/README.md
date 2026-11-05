# Artifacts Toolkit

`@pinpawo-toolkit/artifacts` provides `publish_artifact(path, title?)`,
`list_artifacts()` and `download_artifact(uri, path?)`. A Capability must include
`artifacts` in `uses`. The Host creates the Toolkit with `createArtifactsToolkit`
and supplies its `ArtifactStore`, `ArtifactSourceReader` and
`ArtifactDownloadWriter` adapters.

Publishing takes a local file, saves a snapshot, and returns a stable
`artifact://` reference. The Toolkit declares a `publishedRefs` execution-state
field, initially empty. Successful `publish_artifact` calls update this field
through a native `Command`; its reducer merges publications by URI in publication
order. The normal ToolMessage carries the `ArtifactRef` receipt and a Markdown
link. The Toolkit’s `getResult(state)` validates the accumulated references and
returns the public result `{ deliverables }` for the Capability to collect.

Toolkit instructions guide the model to select files for delivery according to
the task when it creates a file or receives a local path from another tool.
The Capability’s `uses` declaration supplies these instructions and tools.

Files over 100 MiB produce a publication error. Store adapters enforce the same
`MAX_ARTIFACT_BYTES` limit for direct calls and remove incomplete uploads.

Listing uses the execution scope’s session ID. Downloads accept a shared stable
reference from any session. The Host resolves an omitted destination into the
current session’s temporary directory and resolves relative paths against the
execution workdir. Downloads need no review, including explicit workdir and
temporary destinations. Download writers must consume the stream and remove
incomplete files on error or cancellation.

Store adapters use temporary signed URLs for the current download; published
snapshots use stable `artifact://` references.
