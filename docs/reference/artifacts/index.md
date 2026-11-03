# Artifacts

This reference describes the Session Artifacts implementation. The
[design](../../design/agent-runtime/session-artifacts.md) remains a draft.
The retired Capability Artifact Pipeline is
[historical documentation](../../history/artifacts/pipeline/index.md).

An artifact is an explicitly published file snapshot. A file in the workdir or
temporary directory becomes an artifact only when `publish_artifact` succeeds.
Each publication gets a new stable `artifact://` reference. Later source edits
or deletion do not change that snapshot.

## Toolkit and ports

The independent `@pinpawo-toolkit/artifacts` package provides:

| Tool | Input and result | Review |
|---|---|---|
| `publish_artifact` | `{ path, title? }` → file metadata, a Markdown link, and `ToolMessage.artifact.deliverables` | No additional review |
| `list_artifacts` | `{}` → publications for this workspace and Agent session | No additional review |
| `download_artifact` | `{ uri, path? }` → `{ uri, path }` for a verified local copy | The default or explicitly selected current-session managed temporary destination needs no review. Other selected paths require exact write authorization, as Files writes do. |

A Capability must declare `artifacts` in `uses`; built-in Capabilities follow
the same rule. General declares it explicitly. Thread identity comes from the
tool execution scope, not a model argument.

The Host injects two ports:

```ts
type ArtifactStore = {
  put(input: {
    threadId: string; name: string; title?: string; mimeType: string;
    body: ReadableStream<Uint8Array>;
  }): Promise<ArtifactRef>;
  list(threadId: string): Promise<ArtifactRef[]>;
  fetch(uri: string): Promise<
    | { ref: ArtifactRef; body: ReadableStream<Uint8Array> }
    | { ref: ArtifactRef; url: string; expiresAt: string }
  >;
};

type ArtifactSourceReader = (input: { path: string; workdir: string | null }) => Promise<{
  name: string; mimeType: string; body: ReadableStream<Uint8Array>;
}>;
```

`ArtifactRef` contains `uri`, `name`, optional `title`, `mimeType`, byte `size`,
`sha256` and `createdAt`. It is defined in
[agent-contracts](../../../packages/agent-contracts/src/artifact.ts).
The store handles bytes and references, while the Toolkit owns call policy.
See the [package README](../../../toolkits/artifacts/README.md) for composition.

The local source reader follows ordinary Files path semantics: absolute paths
are used directly, and relative paths resolve against the invocation workdir.
It accepts ordinary file targets, including file symlinks, and rejects
directories or special files such as FIFOs. Common extensions supply a MIME
type; unknown extensions use `application/octet-stream`.

Publishing streams at most **100,000,000 bytes per file** and errors on excess,
without truncation. The contract has no session-wide quota. Downloads stream
to a temporary file, verify size and SHA-256, then replace the destination.
Failure retains earlier destination bytes. Managed temporary destinations must
belong to the receiving session.

## Stable references and sharing

Built-in adapters use a key with workspace, session, publication UUID and name:

```text
artifact://<encoded-workspace>/<base64url-session>/<publication-uuid>/<encoded-name>
```

The session segment encodes the complete opaque runtime session ID. It is not
a new identifier restriction. Treat the URI as a reference returned by the
store, rather than constructing paths or decoding ownership from it.

Listing stays within the configured workspace and current session. Fetching
accepts a received reference from another session or workspace within the same
configured storage namespace. This shares a published file, not the other
session's messages, checkpoint or execution records. HTTP access still requires
the Host's existing authentication; the store does not add a Channel ACL.

Share the stable reference. COS signed URLs are temporary, used for one fetch,
and do not replace references in messages or tool results. Changing the adapter
does not copy existing publications between backends.

## Host configuration

The default adapter is `local`. It stores snapshots under the shared workspaces
base, normally `~/.pinpawo/workspaces`:

```text
<workspaces-base>/<encoded-workspace>/artifacts/
  <base64url-session>/<publication-uuid>/<encoded-name>
  <base64url-session>/.metadata/<publication-uuid>.json
```

`PINPAWO_WORKSPACES_DIR` changes the workspaces base. Local fetch uses the shared
base to resolve received references across workspaces; list remains scoped.
The implementation reuses Host path containment, hashing and atomic-file
facilities, with streaming content writes and a fresh UUID for each snapshot.

Choose COS in the **global** `~/.pinpawo/config.json`, never a workdir config:

```json
{
  "artifacts": {
    "adapter": "cos",
    "bucket": "example-1250000000",
    "region": "ap-guangzhou",
    "prefix": "session-artifacts",
    "secretId": "<secret-id>",
    "secretKey": "<secret-key>"
  }
}
```

The equivalent environment overrides are:

| Variable | Meaning |
|---|---|
| `PINPAWO_ARTIFACTS_ADAPTER` | `local` or `cos`; overrides global selection |
| `PINPAWO_ARTIFACTS_COS_BUCKET` | Required COS bucket |
| `PINPAWO_ARTIFACTS_COS_REGION` | Required COS region |
| `PINPAWO_ARTIFACTS_COS_SECRET_ID` | Required credential ID |
| `PINPAWO_ARTIFACTS_COS_SECRET_KEY` | Required credential secret |
| `PINPAWO_ARTIFACTS_COS_PREFIX` | Optional object-key prefix |
| `PINPAWO_ARTIFACTS_COS_SECURITY_TOKEN` | Optional temporary-credential token; global field `securityToken` |

Nonempty environment values override matching global fields. Host assembly
selects the adapter at startup. Credentials stay in global configuration or the
process environment and are not stored in the workdir or shared references.

The COS adapter uses the official `cos-nodejs-sdk-v5` package, pinned to 3.0.0.
It streams content, stores metadata separately, pages session listings, and
creates signed GET URLs with a 3600-second expiry when fetching. It does not
offer a migration or artifact-management service.

## HTTP and clients

Standalone Agent Session HTTP and Studio HTTP expose the same route:

```text
GET /agent-session/artifacts?uri=<URL-encoded-artifact-reference>
Authorization: Bearer <existing-Host-or-Studio-client-token>
```

The standalone listener uses its existing Host authority and Origin checks.
Studio registers the route with `client` authorization, so the local Host token
and authorized Studio client keys/JWTs can use it. Embedded Hosts must provide
the same adapter's fetch function; an absent adapter returns 503.

Local storage returns a stream with MIME type, length and attachment filename.
COS returns a 302 to a newly signed URL. Invalid references return 400 and
missing objects return 404; these responses do not create a session. Responses
use `Cache-Control: no-store`.

Console renders structured deliverables and Markdown `artifact://` links as
downloads. It fetches with the connection's Bearer token, follows the redirect
without cookies, then downloads a Blob. The token is not part of the saved URI
or forwarded to the cross-origin object store.

TUI reference projection renders titles and stable references, including after
a snapshot redraw. Address wiring is under verification: an existing WebSocket
connection uses its actual Host port to display the authenticated HTTP GET
address. Default stdio does not start an HTTP listener; the read-only
`artifact.address.get` / `artifact.address.result` control exchange resolves an
existing local snapshot path or a temporary COS URL for display. These addresses
stay out of Agent history, Channel messages and checkpoints. Address resolution
does not automatically download the file or add a TUI command. See the
[Agent Session address contract](../runtime/session-projection.md#artifact-display-addresses).
The control result goes only to the requesting stdio/WebSocket peer. HTTP
message POST rejects that request type; HTTP readers use the authenticated
artifact GET route, not a session event carrying an address.

**COS browser downloads require bucket CORS configuration.** The redirected
signed GET must permit the browser's actual origin. The Chromium fixture
observed `Origin: null` after the cross-origin redirect, so allowing only the
Console's fixed origin is insufficient for that chain. A no-credentials signed
GET can use `Access-Control-Allow-Origin: *` and allow `GET`; expose
`Content-Disposition` when the browser needs the response filename. This is
object-store CORS, not an exception to Host authentication. An existing bucket
is not assumed to work without configuration.

## Boundaries and verification

This implementation does not add owner lookup, deletion APIs, retention rules,
garbage collection or an administration platform. Old pipeline files remain on
disk; removing a session does not promise to remove its published files. The
optional artifact-inventory system section in the design is not implemented.

Tests cover port behavior, local streams and snapshots, signed-URL handling,
authenticated HTTP and cross-Pet delivery. Real SDK tests use an isolated HTTP
fixture and offline signing. Chromium fixtures cover local binary downloads,
Markdown links and a cross-origin COS-style redirect without Bearer leakage.
These fixtures do not establish access, permissions or CORS for a real COS
bucket. The real-model evaluation could not start: the default model profile
read failed with `ENOENT` for `/home/agent/.pinpawo/config.json`, before any model
call. This was not a network failure. Live COS acceptance remains unverified.
The [design implementation status](../../design/agent-runtime/session-artifacts.md#实现状态)
separates completed fixture checks from final branch validation.

Source: [Toolkit](../../../toolkits/artifacts/src/toolkit.ts),
[local adapter](../../../services/host/src/artifactStore.ts),
[source reader](../../../services/host/src/artifactSourceReader.ts),
[adapter selection](../../../services/host/src/artifactStoreFactory.ts),
[COS adapter](../../../services/host/src/cosArtifactStore.ts), and
[HTTP result handling](../../../services/host/src/artifactHttp.ts).
