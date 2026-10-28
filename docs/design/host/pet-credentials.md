# Instance credentials at tool execution

This opt-in Host composition contract supplies credentials to ShellRS-backed
Toolkits. Pet definitions, Studio instance identity and Channel semantics do not
change. Binding keys are stable Studio `petId`s, never `definitionId`, Channel IDs
or model arguments. One Pet can use the same bindings in any of its Sessions.

## Integration

```ts
import { FilePetCredentialSource } from 'pinpawo/host-runtime';
import { StudioHost } from '@pinpawo/studio-core';

const host = new StudioHost({
  credentialSource: new FilePetCredentialSource('/private/host/credentials.json'),
});
```

Embedded Hosts can pass `credentialSource` through `startStudioHost` or
`runStudioHostProcess`, or directly to `HostCapabilityAssembly`. The ordinary CLI
does not automatically discover or enable a credential source.
Custom adapters implement the exported `PetCredentialSource`:

```ts
interface PetCredentialSource {
  readBindings(petId: string): Promise<Readonly<Record<string, string>>>;
  resolve(ref: string): Promise<string>;
}
```

`readBindings` returns fixed environment variable names mapped to opaque references.
The configured source owns the reference namespace. `resolve` retrieves the current
value from its single authoritative store. A binding may deliberately share a
reference across instances. Missing instances/references must throw; `{}` explicitly
means this instance needs no credentials. Adapter configuration and writes belong
to trusted Host composition, outside tools and ordinary Studio HTTP APIs.

The local file adapter stores both mappings and values in one protected JSON file:

```json
{
  "bindings": {
    "pet-instance-a": { "SERVICE_TOKEN": "account-a" },
    "pet-instance-b": { "SERVICE_TOKEN": "account-b" }
  },
  "values": {
    "account-a": "fake-example-a",
    "account-b": "fake-example-b"
  }
}
```

Only the binding reference associates the instance with a credential. No values go
in reusable Pet definitions, Studio instance projections, logs or checkpoints.
The file must be a regular file owned by the Host user with no group/other mode
bits (0600 recommended), in an owner-only directory. The adapter rejects symlinks
at the final path and checks the opened file descriptor. Provision and atomically
replace it through a trusted operator/integration; this feature supplies no public
credential creation/read API. It never uploads credential files as artifacts.

## Execution and failure

The resident Host binds an internal execution identity around the shared turn
runner, covering interactive, dispatch and resumed turns. Async context is revoked
when the turn settles. This is separate from dispatch attribution: interactive
roots still clear inherited dispatch scope.

Before every ShellRS `exec`, the Host resolves this instance's bindings and sends
the result only in that request's `env`. The fixed credential variables override
same-name toolkit request variables. Host and RS service global environments
are still inherited by the existing process execution path; this feature does
not filter or sandbox them. Integrations must never put per-Pet business tokens
in either global environment. The configured source must be the single
authoritative source of those business credentials; instance values are never
installed in `process.env`. Shell, git,
GitHub, project inspection and optional Office reuse their existing ShellRS client.
Other runtimes do not automatically receive credentials.

With a source configured, absent execution context, absent binding/reference,
invalid variable names or provider failures stop the command before transport.
Provider error details are replaced with a generic failure to avoid leaking values.
There is no fallback to another instance or default credential. Without a source,
existing ShellRS behavior is unchanged.

Each command rereads the source: replacing a value or rebinding a reference takes
effect on new commands without changing `petId` or restarting the Host. Bindings
survive Host restart because they are source-owned persistent data. No cache,
version service or live process environment update is promised. File reads of
multiple references are not a transactional snapshot during concurrent replacement.

## Boundary

This is process environment injection, **not an OS sandbox**. Shell can read its
own environment and deliberately print it; model/tool output can therefore contain
credentials if a command exposes them. Same-user processes and a malicious toolkit
are outside this isolation guarantee. Do not promise that secrets are absolutely
invisible to the model. The Host adds no plaintext credential fields to normal
APIs, logs or checkpoints, but does not redact arbitrary command output.

Business applications own account login, consent, credential issuance, persistence
updates and authorization policy. They coordinate only the trusted instance ID,
fixed variable names, source reference format and source provisioning with Host
composition. No business identity schema, permission table or login flow belongs
in this contract. Real authorization, production connection and deployment are
separate work.
