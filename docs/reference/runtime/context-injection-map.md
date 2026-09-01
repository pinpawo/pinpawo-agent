# Context Injection Map

> **Status: current implementation inventory.** This page records what every
> production model call receives today. The target assembly contract is
> [`model-context-assembly.md`](../../design/agent-runtime/model-context-assembly.md).

Read this page before changing a model input or its eval cases. Prompt prose
lives in `agent/orchestrator/prompts/templates/`; this page records assembly
rather than duplicating prompt text.

## Context channels

The target vocabulary has three channels:

| Channel | Current representation | Owner |
|---|---|---|
| **System Policy** | node-owned `SystemMessage` or `createAgent.systemPrompt` | model-calling node or subagent runtime |
| **Conversation History** | canonical messages selected by `queryAgentMessages()` | Agent message runtime |
| **Invocation Context** | synthetic messages appended for one call | Planner, Delegation, finalization, or review domain |

System Policy is authoritative instruction. Invocation Context is a fact or
task boundary, not another user request. Conversation History preserves the
roles and chronology of selected canonical messages.

Root ingress rejects canonical `SystemMessage` values, while checkpoint
validation fails closed and clears legacy history that contains one. The query
remains role-agnostic rather than becoming a hidden policy filter.

## Graph and model calls

```text
START
  `-> prepare -> compactContext --+-> captureUserRequest -> entryAnswer
                                  +-> plannerBoundaryIterationGuard
                                  `-> capability

entryAnswer --plan_request--> capabilityPlanner --+-> capability
                                                   `-> answer
capability -> plannerBoundaryIterationGuard -> capabilityPlanner
```

In addition to graph nodes, routing-manifest initialization and Auto Review make
isolated model calls.

| Model call | System Policy | Conversation History | Invocation Context |
|---|---|---|---|
| Entry Answer | rendered Entry template | main | none |
| Capability Planner | explicit entry/boundary policy | main | Planner input |
| Capability | governing + Toolkit + Capability instructions | main + exact delegation | runtime facts + delegation briefing |
| Capability history summary | fixed maintenance instruction | none | selected older Capability input history |
| Answer | rendered Answer template | none | closed answer facts |
| Context compaction | static summary policy | none | rendered old main history |
| Routing manifest | static manifest policy | none | compiled registry manifest |
| Auto Review | global policy + registered Toolkit policy + provider output protocol | none | action and runtime facts |

## Shared structures

| Structure | Channel | Source |
|---|---|---|
| `<run_user_request>` | Invocation Context | `runUserRequest` |
| `<delegation_briefing>` | Invocation Context | active delegation and current run goal |
| `<capability_runtime_context>` | Invocation Context | workdir, runtime environment, and optional interfaces |
| `<planning_boundary_event>` | Invocation Context | active delegation, ordered Announces, and prior plan proposal |
| `<answer_input>` | Invocation Context | terminal root state and accepted results |
| `<auto_review_facts>` | Invocation Context | current reviewed action batch |
| `<context_summary>` | Conversation History | context compaction |

Free text inside model-visible XML uses `xmlTextBlock()` so a CDATA terminator
cannot change structure. Fact and evidence envelopes carry explicit
non-authoritative roles. Their schemas remain owned by their domains rather
than one generic context serializer.

## Entry Answer

Entry Answer decides whether to reply from current conversation context or call
`plan_request`.

```text
SystemMessage(ENTRY_ANSWER_SYSTEM_PROMPT.render(vars))
queryAgentMessages(messages).main().select()
```

The selected main conversation is passed through the internal provider boundary
for typed Announce rendering and tool-protocol repair. Entry Answer appends no
separate fact block because it needs the latest conversation to resolve the
current request and its references.

`plan_request(goal)` is the only model-authored goal transition. Its private AI
tool call and result do not enter root messages.

## Capability Planner

Planner has two finite variants selected by `CapabilityPlannerInput.mode`:

| Variant | System objective | Current input |
|---|---|---|
| `entry` | form the shortest complete executable plan | run goal, routing manifest, disclosed Capability documents |
| `boundary` | evaluate current execution evidence and choose the next state | entry facts plus active delegation, ordered Announces, and prior plan proposal |

Current provider shape:

```text
SystemMessage(entry or boundary policy)
Clean main conversation
HumanMessage(typed Planner input)
```

The main conversation and current input are assembled explicitly through the
message query. The same typed mode selects an entry or boundary template and
its terminal-tool set. Planner middleware only owns lifecycle and
terminal-commit transport.

Private Capability Human, AI, and Tool messages never enter Planner history.
Boundary extracts typed Announces from the exact active delegation scope and
renders them in its current input. Planner provider messages remain invocation
private. The run-scoped session retains only typed plan, disclosure, and commit
state.

See [`run-scoped-planner-session.md`](../../design/agent-runtime/run-scoped-planner-session.md)
for lifecycle ownership and run `npm run planner:context-audit` to render the
complete production contract for both variants.

## Capability execution

Current provider shape:

```text
SystemMessage(
  Framework governing policy
  + optional context-summary policy
  + Toolkit instructions
  + Capability instructions
)
Main conversation + exact delegation-private history
HumanMessage(current Capability runtime facts, when present)
HumanMessage(current Delegation Briefing)
```

The message path is already explicit:

```ts
queryAgentMessages(messages)
  .main()
  .delegation(scope)
  .append(runtimeContextMessage, delegationBriefing)
  .select();
```

The briefing is always last and is never persisted merely because it was
appended. It contains the run goal as read-only background and the current task
as the execution boundary. A continuation reuses the exact delegation scope
and may add current guidance.

The Capability node derives declared System Prompt variables from the compiled
Capability, resolved Toolkits, and context-summary configuration, then renders
one Capability template before calling the subagent runtime. The subagent
runtime receives the rendered `systemPrompt`; it does not receive a section
array or reconstruct domain state. Workdir, runtime environment,
artifact-discovery availability, and other runtime facts use the invocation
message and never become instruction authority.

When the Capability input history reaches its token watermark, LangChain's
summarization middleware performs a closed maintenance call with the fixed
`SUBAGENT_CONTEXT_SUMMARY_PROMPT` and the selected older messages. It
does not receive the Capability's normal System Policy or current briefing. Its
summary is inserted back into private Conversation History before the next
Capability model call.

See [`agent-message-lanes.md`](../../design/agent-runtime/agent-message-lanes.md)
for private-history ownership and
[`model-context-assembly.md`](../../design/agent-runtime/model-context-assembly.md)
for the channel migration.

## Answer

Answer currently receives no canonical conversation history:

```text
SystemMessage(ANSWER_SYSTEM_PROMPT.render({}))
HumanMessage(<answer_input>)
```

`<answer_input>` contains the current run goal and closed facts for the reply
mode, accepted results, requested user input, or blocked reason. Accepted
results are selected by completed delegation identity rather than inferred from
history prose.

The current `answer` node remains an implementation of the terminal
finalization boundary. The target separation between deterministic rendering,
optional synthesis, and cleanup is defined by
[`terminal-response.md`](../../design/agent-runtime/terminal-response.md).

## Auto Review

Auto Review is an isolated, closed invocation:

```text
SystemMessage(global review policy + registered Toolkit policies + output protocol)
HumanMessage(<auto_review_facts>)
```

Toolkit auto-review policy is trusted registered instruction. Tool input,
review view, current task, and workdir are non-authoritative action facts. The
call site first selects deduplicated Toolkit policies, then renders System
Policy and action facts through separate typed inputs.

## Routing manifest and compaction

Routing-manifest initialization uses a static System Policy and a closed Human
fact containing the compiled Capability registry manifest. It does not consume
root conversation history.

Context compaction uses a static summary policy and a Human message containing
rendered old main history. The main-history query excludes lane messages from
summary input. The retention pass still operates on the full root message array
so it can preserve the recent suffix and pin unaccepted typed Announces.

Compaction output is one canonical `<context_summary>` plus retained messages.
It does not summarize Planner private invocation history.

## `runUserRequest` projections

One root-owned goal is projected differently by each consumer:

| Consumer | Projection |
|---|---|
| Planner | primary goal in Planner Invocation Context |
| Capability | read-only goal background inside the delegation briefing |
| Answer/finalizer | target inside the closed terminal facts |

The value is provisionally captured from the latest main Human message, replaced
only by a validated Entry `plan_request(goal)`, and replayed from the active
delegation snapshot on explicit resume. Fresh-turn guidance does not silently
replace it.

## Assembly implementation

Every node selects a domain template and renders typed variables directly.
Capability's multiple registered instruction sources become declared Capability
template variables, not a shared section-composition protocol.
`queryAgentMessages()` is the shared history boundary. Domain builders own
Invocation Context messages, and query `.append()` owns their final order.
Provider projection happens after those channels meet.

## Checklist for changing model context

1. Select the domain System Prompt template and prepare its typed variables.
2. For Capability composition only, verify every registered instruction comes
   from Framework, Capability, or Toolkit authority.
3. Put current goal, task, plan, evidence, environment, and interface facts in
   Invocation Context.
4. Select existing history only through `queryAgentMessages()`.
5. Keep invocation messages synthetic, non-authoritative, and non-persistent.
6. Preserve domain-owned structure and escape free text.
7. Check provider ordering after append and tool-protocol repair.
8. Update observable behavior tests and the relevant real-model eval; do not
   test prompt wording as a literal string contract.
