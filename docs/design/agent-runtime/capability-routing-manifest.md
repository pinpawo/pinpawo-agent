# Capability routing manifest

Status: draft, aligned with the Supervisor simplification on 2026-09-08.

## Purpose and ownership

The Run Supervisor receives the complete set of Host-allowed Capability names,
authored responsibility descriptions, and compiled Toolkit names and descriptions.
This is enough to select responsibilities and arrange a plan. Complete Capability
instructions are disclosed only when their additional detail is needed.

The manifest is a deterministic projection of the compiled registry. It does not
introduce a package format, widen a Capability's responsibility, or authorize
execution. Root continues validating every selected name against the effective
registry and Host allowlist.

## Data flow

```text
compiled registry + Host allowlist
  -> immutable in-memory CapabilityCatalog
  -> deterministic routing manifest
  -> Supervisor decision
  -> optional capability_details exact-name reads
  -> plan, current-task review, or natural reply
```

`createCapabilityCatalog` copies the effective registry into immutable entries.
Each entry contains the Capability name, authored description, compiled Toolkit
metadata, and complete document content. File-backed definitions retain their
already-loaded `document.content`; inline definitions render the same
`CAPABILITY.md` shape in memory. Supervisor does not reopen authored paths.

`createCapabilityRoutingManifest` projects these entries into:

```ts
type CapabilityRoutingManifest = {
  defaultCapabilityName?: string;
  capabilities: ReadonlyArray<{
    name: string;
    purpose: string; // the authored Capability description
    toolkits: ReadonlyArray<{ name: string; description: string }>;
  }>;
};
```

The configured default is included only if available in the effective catalog.
It remains a candidate; its complete document is not automatically preloaded.
Every allowed Capability appears once. No model rewrites descriptions, invents
search cues, or drops Toolkit metadata.

The model-facing manifest excludes complete instructions, individual tool schemas,
Toolkit instructions, paths, digests, and provenance. Dynamic registry facts enter
invocation context, not the stable system prompt or canonical root messages.

## Disclosure and lifetime

`capability_details` accepts exact names from the manifest. It returns newly read
complete documents, already-disclosed names, and unknown names. It does not search
document text. A plan does not require a detail call when the manifest already
provides sufficient responsibility information.

Disclosure state stores the registry digest and disclosed names. A content digest
identifies the effective catalog; a registry change invalidates previous disclosure.
New runs may seed names referenced by active and remaining tasks for recovery.
The manifest and documents always come from the same catalog for an invocation.

Each Supervisor invocation owns a document reader. The existing 64 KiB document
budget counts both previously disclosed documents injected into context and newly
read details. Complete documents are never truncated to fit. Parallel tool results
merge disclosed names through the existing reducer. Detail availability continues
to follow the existing Entry/Boundary middleware policy.

There is no elapsed-time deadline owned by Supervisor. Caller cancellation is
passed directly through RunnableConfig and checked around invocation. Provider
errors and cancellation continue through the existing root error handling.

## Removed implementation

The previous disk snapshot, cache directory, lock, snapshot verification and repair,
filesystem/memory search backends, and backend configuration are removed. The
compiled registry already supplies all document content needed by exact-name reads.

The separate model call to initialize a compressed routing manifest is removed,
along with generated cues, validation/fallback branches, and the shared in-flight
cache with independent cancellation. Creating routing metadata is now synchronous
and independent of model availability. No compatibility adapter is retained for
these internal interfaces or the obsolete backend setting.

Pause/resume routing is outside this change and is tracked in
[issue #785](https://github.com/pinpawo/pinpawo-agent/issues/785).

## Verification

Behavioral tests cover Host scope isolation, stable content identity, authored
content preservation without filesystem access, direct Toolkit metadata projection,
per-invocation document budgets, caller cancellation, exact-name disclosure, and
Entry/Boundary control outcomes. Mock-model tests ensure a decision does not first
invoke a routing initializer. Real-model evals exercise responsibility selection,
optional details, and task acceptance/continuation independently of prompt wording.
