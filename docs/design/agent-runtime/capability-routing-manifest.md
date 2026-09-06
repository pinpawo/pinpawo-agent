# Capability routing manifest

Status: draft.

## Goal

Give the Run Supervisor enough registry vocabulary to form precise
`capability_search` terms before any Capability document has been disclosed.

The routing manifest is a compact, immutable view of the effective Capability
registry. It helps the Supervisor discover an executor. It does not replace
`CAPABILITY.md`, authorize execution, or describe how a Capability performs its
work.

This is a derived Supervisor input, not a package format or a revival of the removed
Capability `manifest.json` plugin contract.

## Current problem

The current disclosure flow initially provides the complete document for the
configured default Capability. Other Capability documents remain invisible until
`capability_search` finds literal text inside them. After an empty search, the
Supervisor may learn some undisclosed Capability names, but names alone often do not
provide enough domain vocabulary for the next search.

This produces two undesirable biases:

- the default Capability is semantically overrepresented before discovery;
- the first search depends on the model guessing words used by an unknown
  Capability document.

For example, a user may ask to inspect GitHub Issues while the relevant
Capability is described using repository, issue-triage, or project-maintenance
language. The Toolkit is available, but the Supervisor cannot reliably discover the
Capability that owns it.

## Decision

The compiled registry exposes a deterministic source manifest. The Supervisor
initialization step turns that source into a compact routing manifest before
normal planning begins.

The source manifest contains only validated registry facts:

```ts
type CapabilityRegistryManifest = {
  defaultCapabilityName?: string;
  capabilities: Array<{
    name: string;
    description: string;
    toolkits: Array<{
      name: string;
      description: string;
    }>;
  }>;
};
```

The model-facing routing manifest has this shape:

```yaml
default: studio_planning

capabilities:
  - name: project_review
    purpose: 审查工作区改动、提交、分支和 Pull Request
    cues: [review, pull request, diff, code quality]
    toolkits:
      - name: git
        description: 本地 Git 与 GitHub PR/Issue 协作

  - name: github_project
    purpose: 查询和维护 GitHub Issue、PR 与仓库内容
    cues: [github, issue, pull request, repository]
    toolkits:
      - name: git
        description: 本地 Git 与 GitHub PR/Issue 协作

  - name: studio_planning
    purpose: 探索项目状态并拆分、安排和跟踪任务
    cues: [project planning, task breakdown, kanban, progress]
    toolkits:
      - name: workspace
        description: 本地文件、代码搜索与受控命令执行
      - name: kanban
        description: 共享任务的查看、拆解、完成与阻塞
```

Every available Capability remains present. Compression reduces the description
of each responsibility; it never compresses several Capabilities into an opaque
group or removes an apparently less relevant entry.

The default remains a normal Capability. `defaultCapabilityName` identifies the
preferred general candidate when no more specific responsibility is suitable,
but its complete document is not preloaded and it is not forced into a plan.

## Information boundary

The manifest answers only:

> Which registered responsibility may be relevant to this request?

Each entry includes:

- the canonical Capability name;
- one concise `purpose` sentence describing the positive responsibility;
- three to six short `cues` that help relate user intent to the registered
  responsibility;
- the names and registered descriptions of Toolkits resolved from the
  Capability's compiled `uses`, retained as deterministic execution-scope
  facts rather than model-authored summaries;
- whether the registry designates it as the default, represented once at the
  manifest level.

`purpose` and `cues` are routing aids rather than new Capability contract facts.
They may restate the authored description but cannot widen the responsibility
expressed by it.

The manifest excludes:

- Capability instructions and execution workflow;
- individual tool names and schemas, Toolkit instructions, and runtime state;
- authorization and safety policy;
- examples and implementation notes;
- document paths, digests, and provenance.

Those fields either do not help responsibility routing or disclose execution
detail before the Supervisor has selected a candidate. Registry digests may remain
internal cache and invalidation keys; they are not model context.

## Supervisor flow

```text
compiled Capability registry
  -> deterministic source manifest
  -> initialize compact routing manifest
  -> initialize run-scoped Supervisor session with that routing manifest
  -> Supervisor selects a candidate from user request + manifest
  -> capability_search uses its canonical Capability name to disclose the complete CAPABILITY.md
  -> Supervisor submits a plan or another state-changing command
```

The manifest is available in both Supervisor modes:

- `entry` uses it to discover the initial executor responsibilities;
- execution `boundary` invocations reuse the information prepared for the plan;
- when a user supplements an unfinished task or confirms a plan adjustment, the
  message enters main with the current delegation retained. The new run's first
  Supervisor decision may use the manifest and discovery to prepare the needed
  information, including in Boundary mode, before execution resumes.

This follows the [Supervisor–Root interaction design](delegation-boundary-protocol.md#supervisor-asks-the-user-directly).
Execution evidence alone does not authorize new scope or replanning. User input
does not first close or replace the current delegation, and no separate planning
mode is added. Current code exposes discovery in every Boundary; restricting it
to preparation for execution is pending implementation.

`capability_search` remains the document-disclosure boundary. Its filesystem and
memory backends continue searching complete immutable Capability documents and
return complete matching documents. The manifest does not become another search
backend.

Toolkit descriptions let the Supervisor select a candidate from known execution
scope, but do not replace the Capability document. The candidate's canonical
name is the stable literal lookup term; semantic phrases are only useful when
they are expected verbatim in the document. The Supervisor is instructed to
disclose a Capability's complete document before using workflow or contract
details that are absent from the routing manifest. This applies to the configured
default as well. The default document uses the same discovery path as every other
Capability; an exact search for its manifest name is always available when the
Supervisor needs the default's complete contract. This remains a Supervisor
information-boundary rule rather than a new command protocol field; the root
trust boundary continues validating canonical registry membership.

Continuation seeds may disclose Capabilities already referenced by canonical
active or remaining tasks. That is execution recovery, not initial registry
routing, and remains separate from the manifest.

## Lifetime and ownership

The compiled registry owns the manifest. The Supervisor reads an immutable snapshot
corresponding to the same effective registry generation as its Capability
Document Workspace.

A new root run initializes a new Supervisor session with that snapshot. Boundary
invocations in the same run reuse the same registry view. If the effective
registry changes, the next Supervisor session receives the new manifest together
with the new document workspace.

The manifest is not:

- a root conversation message;
- Supervisor-generated working memory;
- a checkpoint compatibility format;
- a replacement for typed disclosure state.

Disclosure state tracks only registry generation, disclosed document names, and
search-round accounting. The configured default belongs exclusively to the
routing manifest and is not duplicated into disclosure state.

Invocation projection may render the manifest as structured model context, but
must not copy it into canonical `messages`.

## Initialization and compression

Initialization is a distinct runtime-owned phase, not an optional tool call in
the normal Supervisor loop. When no routing manifest exists for the current registry
generation, the runtime invokes the Supervisor model with the source manifest and
only one commit tool for the structured routing result. Normal entry or boundary
planning starts after that result passes validation.

The compression result must satisfy these invariants:

- every source Capability appears exactly once;
- canonical names and the configured default are unchanged;
- `purpose` is one concise sentence;
- each entry has three to six short, non-duplicated cues;
- cues describe user intent, domain objects, or requested outcomes rather than
  Toolkit names and implementation details;
- generated text cannot add a responsibility absent from the source description.

The model owns only `purpose` and `cues`. Toolkit names and descriptions are
copied from the compiled source into the validated routing result after model
initialization. A model may use those facts while compressing, but cannot omit or
rewrite them. This prevents lossy summarization from hiding a registered ability
such as GitHub Issue access from normal Supervisor routing.

The initialized result is cached by the internal registry generation together
with the configured default identity and is not regenerated for each Supervisor
invocation or root run. The internal cache key does not enter model context.
An in-flight initialization belongs to that cache generation rather than to one
Supervisor invocation. Each caller still observes its own cancellation signal, but
canceling one caller does not cancel initialization for other callers.

If initialization fails validation or the model call is unavailable, planning
falls back to a deterministic projection: each Capability keeps its authored
description as `purpose`, while its canonical Capability and Toolkit names form
the minimum cues. Registered Toolkit names and descriptions remain present. This
keeps Capability discovery available without treating generated routing text as
authoritative registry state.

## Migration

1. Derive `CapabilityRegistryManifest` from the effective compiled registry.
2. Add a validated routing-manifest initialization result and deterministic
   fallback.
3. Add the immutable routing manifest to Supervisor entry and boundary invocation
   context.
4. Stop seeding the configured default into initial disclosed Capability names.
5. Allow the default document to be found through the same
   `capability_search` path as other documents.
6. Keep `defaultCapabilityName` as candidate policy and preserve registry
   validation of all committed Capability names.
7. Update behavioral tests and model evals before changing prompt wording.
8. Update the public Capability reference only after the implementation and
   routing behavior stabilize.

No compatibility layer is required for the old default-document preload because
it is invocation context rather than a persisted public contract.

## Verification

Behavioral coverage should demonstrate that:

- every available Capability is represented once in the manifest;
- unavailable or uncompiled Capabilities are absent;
- initialized names and the default exactly match the source manifest;
- each Capability retains the compiled Toolkit names and descriptions from its
  `uses`, even when model compression omits that scope from `purpose` or `cues`;
- each initialized entry satisfies the `purpose` and `cues` bounds;
- invalid initialization output uses the deterministic fallback;
- the configured default is identified but its complete document is not
  initially disclosed;
- an exact search can disclose the default document;
- existing filesystem and memory search backends return the same complete
  documents as before;
- entry and boundary use the same registry generation;
- registry changes replace, rather than merge with, the previous manifest;
- continuation disclosures remain distinct from initial routing context.

Model evals should include lexical-mismatch cases where the user request does
not contain the authored Capability name. Success means the Supervisor uses the
manifest description to form a search that discloses the correct Capability,
rather than immediately returning unavailable or selecting the default solely
because it was preloaded.

## Model ownership

The resolver that owns this cache is created with one Supervisor model instance.
Registry generation plus configured default is therefore sufficient as its local
cache identity; a resolver is never shared across different model profiles. The
source manifest and Capability contract remain model-independent.
