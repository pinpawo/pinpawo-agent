# Agent Message Lanes and Views

Status: draft.

## Goal

Make message lanes an operational Agent-internal context mechanism rather than
an inert metadata field. Every model invocation that consumes conversation or
runtime data should obtain those messages from one shared view composer that can
answer:

- which canonical messages were selected;
- which delegation scope they belong to;
- which invocation-only overlays were appended;
- which provider projections were applied;
- which messages were removed to repair tool-call protocol;
- why another lane was excluded.

This draft starts from the current `main` implementation. It does not depend on
the terminal-finalization PR stack.

## Prior problem

Before this package, `orchestrator/messageLanes.ts` mixed several responsibilities:

- reading and writing `additional_kwargs.pinpawo` metadata;
- selecting main conversation messages;
- selecting a Capability transcript;
- repairing dangling tool-call sequences;
- reconciling child results into root state;
- finding delegation announces;
- accepting a delegation through handoff.

Consumers then built their own views again:

- Entry and Answer select main history and project accepted Announces;
- Capability selects main plus one delegation transcript and appends a briefing;
- Planner selects main history separately from current-delegation Announces;
- context compaction independently decides which main and lane messages survive.

The `lane` value therefore identified storage but did not own visibility. The
same visibility policy is distributed across selectors, prompt builders, and
nodes, which makes Boundary context especially easy to drift.

## Domain model

### Canonical message

A canonical message is stored in graph state. It is either:

- **main**: no lane; part of the user-facing Agent conversation;
- **delegation-scoped**: belongs to one exact tuple of lane, transcript run, and
  delegation id.

The tuple is indivisible:

```ts
type DelegationMessageScope = {
  lane: `capability:${string}`;
  transcriptRunId: string;
  delegationId: string;
};
```

Selecting by lane alone is not a valid delegation transcript operation.

### Message view

A message view is an invocation-only projection over canonical state:

```ts
type AgentMessageViewSpec = {
  name: string;
  audience: string;
  sources: MessageViewSource[];
  overlays?: MessageViewOverlay[];
  projector?: MessageViewProjector;
  toolProtocol?: 'safe' | 'preserve';
};
```

Canonical sources are evaluated against the original message sequence, so main
messages and a selected delegation transcript retain chronological order.
Overlays are appended after canonical selection and are never persisted merely
because they appear in a view.

The result contains both provider messages and a composition manifest:

```ts
type AgentMessageView = {
  messages: BaseMessage[];
  messagesBySource: Readonly<Record<string, readonly BaseMessage[]>>;
  manifest: AgentMessageViewManifest;
};
```

The manifest records source, scope, canonical id, projection status, overlay
status, and tool-protocol removals without copying message content. Named source
partitions let a domain consume one composition in more than one representation;
for example, Planner Boundary passes the `main` partition as provider history
and serializes the `delegation` partition as structured boundary evidence.

### Query, manager, and location API

Message handling has three layers:

```text
queryAgentMessages
  -> AgentMessageManager
    -> createOrchestratorMessageViews
```

- `queryAgentMessages` is the single canonical selection implementation. It
  assigns each selected message to a named source and records why every other
  canonical message was excluded. It also validates source identity and rejects
  ambiguous main or delegation source definitions at this boundary.
- `AgentMessageManager` adds invocation-only overlays, provider projection,
  tool-protocol sanitation, named partitions, and the final manifest.
- `createOrchestratorMessageViews` exposes location-level methods such as
  `entryAnswer`, `capabilityPlannerBoundary`, and `capabilityModel`. Nodes choose
  their location without re-declaring lane policy.

The manifest includes excluded message identities, lanes, and reason codes such
as `scope_mismatch`, `not_announce`, and `invocation_only`; it never includes the
message body.

## Standard views

### Main conversation

```text
sources = [main]
```

Used by Entry, Answer, guards, and compaction. Accepted typed Announces are main
facts and may receive an ephemeral provider projection.

### Capability delegation

```text
sources = [main, delegation(scope, transcript)]
overlays = [delegation briefing, optional artifact context]
```

Only the exact active delegation scope is visible. A different delegation using
the same Capability lane does not inherit its transcript. Invocation-only
briefings are overlays, not checkpoint messages.

### Planner Entry

```text
sources = [main]
overlays = [Planner entry input]
```

### Planner Boundary

```text
sources = [main, delegation(activeScope, announces_only)]
overlays = [Planner boundary input]
```

The only private execution evidence eligible for Boundary comes from the exact
active delegation. Other Capability lanes and non-announce executor transcript
are excluded. Selected Announces are serialized inside the Boundary input, and
that Planner input is an invocation-only `planner_input` overlay. The model call
uses the resulting view directly.

## Ownership boundaries

The Agent message package owns:

- lane and scope metadata;
- canonical source selection;
- chronological composition;
- invocation-only overlays;
- provider projection hooks;
- tool-protocol sanitation;
- view manifests and observability events;
- child transcript reconciliation.

The orchestrator still owns:

- what counts as an Announce;
- accepting a delegation and constructing a handoff;
- Planner plan/session state;
- task completion and terminal outcomes;
- context compaction policy.

Lane state is not a replacement for typed orchestration state.

## Package shape

The implementation lives under `agent/messages/`:

```text
agent/messages/
  metadata.ts       lane/scope metadata and stamps
  query.ts          canonical selection and exclusion reasons
  protocol.ts       tool-call-safe sequence handling
  manager.ts        canonical selection, overlays, projection, manifest
  reconciliation.ts child transcript reconciliation
  observability.ts  composition event emission
  index.ts           internal package surface
```

Orchestrator-specific Announce and handoff operations move to a focused
delegation-message module and consume the shared package. Location-level view
conveniences live in `orchestrator/messageViews.ts`.

## Invariants

1. Main messages never acquire a delegation scope implicitly.
2. A delegation-scoped message must carry lane, transcript run id, and
   delegation id together.
3. A Capability transcript view includes main plus exactly one delegation scope.
4. A Planner Boundary view includes private messages only from the active scope
   and only those selected as Announces.
5. Overlays are marked invocation-only in the manifest and are never returned as
   canonical state updates.
6. Provider projection never mutates the canonical message object.
7. Tool-call sanitation runs after selection and projection and is visible in
   the manifest.
8. View observation contains identities and counts, not user/tool message text.

## Implementation sequence

1. Introduce `agent/messages` and direct behavior tests.
2. Move metadata, protocol sanitation, and reconciliation into the package.
3. Split orchestrator Announce/handoff logic from the old monolith.
4. Migrate Capability to a delegation transcript view with briefing overlay.
5. Migrate Planner Entry and Boundary; Boundary uses the active delegation
   announce source.
6. Migrate Entry, Answer, guards, and compaction to main views.
7. Delete the old `messageLanes.ts` aggregation after all imports move.

## Non-goals

- Persisting model-specific XML projections.
- Exposing raw Capability tool transcripts to Planner.
- Encoding Planner plan/search state as messages.
- Treating the latest message by chronology as the active delegation.
- Changing terminal-response behavior in the same refactor.
