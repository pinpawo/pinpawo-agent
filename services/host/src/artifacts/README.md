# Host artifact storage

The `artifacts` Toolkit publishes immutable snapshots. The default local adapter stores
files at `~/.pinpawo/workspaces/<workspaceId>/artifacts/<threadId>/<artifactId>/<name>`.
`PINPAWO_WORKSPACES_DIR` changes the workspace directory. Small JSON sidecars store
snapshot metadata beside each artifact directory; no reverse ownership index is used.
Only the current session is listed. A shared `artifact://` reference can be fetched
from another session or workspace using the same configured storage.

Select COS in the global `~/.pinpawo/config.json`, never a project configuration:

```json
{
  "artifacts": {
    "adapter": "cos",
    "bucket": "example-1234567890",
    "region": "ap-example",
    "prefix": "published"
  }
}
```

Provide credentials through `PINPAWO_COS_SECRET_ID` and `PINPAWO_COS_SECRET_KEY`,
or the global configuration's `secretId` and `secretKey`. Environment overrides are
`PINPAWO_ARTIFACT_STORE` (`local` or `cos`), `PINPAWO_COS_BUCKET`,
`PINPAWO_COS_REGION`, and `PINPAWO_COS_PREFIX`. COS object keys retain the workspace,
session, artifact and filename; listing uses session-scoped metadata objects.
Signed download URLs expire after 15 minutes and are created only when fetched.

Both Host HTTP listeners and the Studio HTTP Plugin expose authenticated
`GET /agent-session/artifacts?uri=...`. Local files stream as attachments;
COS returns a 302 to its temporary signed URL. Console requests use Bearer
authentication; following the redirect with browser `fetch` requires the bucket
to allow the Console origin through COS CORS. A reference does not grant new
source-tool permissions or extend a source URL's lifetime.

Publishing and downloading reject files above 100 MiB. Downloads check size and
SHA256 before replacing the destination. The default destination is a unique
directory under the current session's temporary directory. The download tool
does not request review for either default or explicit destinations. Destination
paths still resolve against the execution workdir and use the existing download
writer.

Tests cover local snapshots, sharing, limits, downloads, HTTP authentication and
redirects, plus a mock COS transport. No live COS bucket or credentials were used.
