# Studio instance credentials at tool execution

Studio owns stable Pet instances and their credential bindings. Definitions remain
reusable behavior/configuration; a definition never holds a credential reference
that would implicitly grant all its instances access. Studio's current instance
record already supplies individual identity, name and creation metadata. This
change needs no extra profile table or speculative JSON settings. Future individual
profile fields can belong to the instance without duplicating definitions or
storing Secret plaintext.

## Default storage and relationships

Studio core adds two tables through its existing SQLite/Postgres Kysely migrations:

- `studio_secrets`: `secret_id` primary key, name, encrypted value, created/updated
  timestamps. Values have a fresh nonce and authenticated AES-256-GCM encryption;
  the Secret ID is authenticated data, so moving ciphertext to another row fails.
- `studio_pet_credentials`: `(pet_id, env_name)` primary key, `secret_id` reference.
  Foreign keys require a real Studio Pet and Secret. One instance can have several
  fixed variables, and several instances may deliberately share one Secret.

The database is the authoritative business credential source for a normal Studio
Host. Each command reads current bindings/current values without a cache. Replacing
a Secret value affects new commands for all instances bound to it, without changing
`petId`; existing processes retain their startup environment. Rebinding one instance
does not affect another. Binding replacement is transactional; an invalid reference
preserves the prior set. Reads are serialized with local replacements so SQLite's
shared connection does not expose an intermediate empty set.

An existing Pet with no bindings receives `{}` and keeps its normal tool behavior.
An unknown Pet, missing Secret, locked source, malformed ciphertext or failed
provider lookup stops execution rather than selecting another identity. Multiple
reference resolutions are not a transactional snapshot during concurrent rotation.

There is no delete/archive lifecycle in this change. Clearing one Pet's bindings
only detaches it; it never deletes shared Secrets. Future Pet deletion may cascade
its bindings (the FK already expresses this), while Secret deletion must explicitly
handle references. No delete API or automatic garbage collector is introduced.

## Deployment key and startup

The deployment supplies exactly 32 key bytes as `secretsKey: Uint8Array` to
`StudioHost`, `startStudioHost`, `runStudioHostProcess` or `prepareStudio/createStudio`.
The implementation copies those bytes into private runtime memory. It does not
read key bytes from `process.env`, search the user's machine, generate a production
key, or store the key beside ciphertext in the database. A trusted launcher can
read a separately mounted deployment key file and pass the bytes directly; keep
that file and database backups under separate operational control. The ordinary
CLI does not auto-discover a key. Master-key replacement/rewrapping is not a
supported rotation platform; an incorrect key fails when decrypting existing data.

Without a key, Studio still starts and reports Secrets as locked. Metadata and
binding-reference reads work; Secret writes/binding changes and decrypting existing
bindings fail explicitly. There is no plaintext fallback. Invalid key length fails
construction. Unbound Pets continue working; bound Pets fail before command start
until the correct deployment key is supplied.

Host **and RS service** global environments are still inherited by the existing
process execution path. This feature does not filter or sandbox them. Integrations
must keep the deployment master key and all per-Pet business tokens out of both
global environments. Provide the master key through the explicit in-memory input,
not an inherited environment variable; use the source as the single authoritative
business credential store. The implementation never installs key/token bytes in
`process.env`, and adds no variable-name blacklist.

## Management integration

Studio's management port and trusted Plugins receive `secrets` with metadata/write
operations only. They never receive a decrypt method. The composing Host separately
receives `PreparedStudio.credentialSource`; this is not exposed on ordinary `Studio`
or Plugin APIs. Studio HTTP reserves these management routes and requires the
existing local Studio token, including metadata reads. Ordinary client keys cannot
read another Pet's binding references or mutate any Secret/binding.

```text
GET  /secrets
     -> {unlocked, secrets: [{secretId, name, createdAt, updatedAt}]}
POST /secrets
     {secretId, name, value} -> {secret: metadata}   (create or replace)
GET  /pet-credentials?petId=INSTANCE
     -> {bindings: {SERVICE_TOKEN: SECRET_ID}}
POST /pet-credentials
     {petId, bindings: {SERVICE_TOKEN: SECRET_ID}} -> {bindings}
```

`POST /pet-credentials` atomically replaces the complete binding set; `{}` explicitly
unbinds it. There is no HTTP Secret-value read endpoint. Authorization integrations
save the granted value, then bind its Secret ID to the trusted instance. They own
login/consent/issuance and fixed env names; Studio owns generic persistence. This
adds no business roles, token issuer semantics or permission tables. Responses and
errors never echo submitted values; no plaintext credential fields are added to
events, logs or checkpoints. Request-body capture by external infrastructure is
outside this implementation; trusted integrations must not log authorization bodies.

## Runtime source and injection

The Runtime remains independent of the database through the exported Host contract:

```ts
interface PetCredentialSource {
  readBindings(petId: string): Promise<Readonly<Record<string, string>>>;
  resolve(ref: string): Promise<string>;
}
```

`StudioHost` defaults to its own core database source. Trusted embeddings can supply
`credentialSource` explicitly (including to `HostCapabilityAssembly`). A caller
supplying its own capability assembly must wire that source itself. Host code binds
the instance identity around the shared resident turn runner for interactive,
dispatch and resumed turns. Async identity expires when the turn settles. This
identity is separate from dispatch attribution, so interactive roots still clear
inherited dispatch scope. No model/tool argument can select an instance or ref.

Before each ShellRS `exec`, the Host resolves this instance's bindings and adds
values only to that request's `env`, overriding same-name toolkit request variables.
Shell, git, GitHub, project inspection and optional Office reuse their shared client;
other runtimes do not automatically receive credentials. Provider errors are
replaced with generic failures before transport, without retaining a sensitive cause.

`FilePetCredentialSource(path)` remains an explicit alternative for non-Studio or
specialized embeddings. Its single owner-private regular JSON file contains
`{bindings: {petId: {ENV_NAME: ref}}, values: {ref: value}}`. It rejects final-path
symlinks and checks opened-file ownership/mode; provision atomically in an owner-only
directory. Studio's default authorization path does not write business tokens to
this file adapter. It is not an upload/artifact storage mechanism.

## Boundary and evidence

This is process environment injection, **not an OS sandbox**. Shell can read/print
its own environment; arbitrary command output is not redacted. Same-user process or
file access and malicious toolkit code remain outside the isolation guarantee.
The deployment key is excluded from automatic env injection; this does not promise
that a same-user shell cannot read a deployment file it has OS permission to read.

The real graph integration uses fake key/token bytes, production resident admission,
HostGraphService, review/resume, the Shell Toolkit, a private ShellRS service and a
real child process. It proves the child receives the database Secret after approval,
the master key is absent from inherited child env, and normal model inputs/events/
snapshots/checkpoint data do not contain the automatically injected value. SQLite
and in-process Postgres tests cover ciphertext, bad/missing keys, authenticated
row identity, persistence, shared bindings and concurrent replacement/read behavior.
