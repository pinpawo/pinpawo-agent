# Artifacts Toolkit

`@pinpawo-toolkit/artifacts` provides `publish_artifact(path, title?)`,
`list_artifacts()` and `download_artifact(uri, path?)`. A Capability must include
`artifacts` in `uses`. The Host creates the Toolkit with `createArtifactsToolkit`
and supplies its `ArtifactStore`, `ArtifactSourceReader` and
`ArtifactDownloadWriter` adapters.

Publishing takes a local file, saves a snapshot, and returns a stable
`artifact://` reference plus `ToolMessage.artifact.deliverables`. It rejects
files over 100 MiB without truncation. Store adapters must enforce the same
`MAX_ARTIFACT_BYTES` limit for direct calls and remove incomplete uploads.

Listing uses the execution scope’s session ID. Downloads accept a shared stable
reference from any session. The Host resolves an omitted destination into the
current session’s temporary directory and resolves relative paths against the
execution workdir. Downloads need no review, including explicit workdir and
temporary destinations. Download writers must consume the stream and remove
incomplete files on error or cancellation.

The Toolkit does not infer deliverables from text, register existing URLs, or
add shared runtime state. Signed storage URLs are used only for the current
download and are not returned as stable references.
