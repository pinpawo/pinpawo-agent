# Agent model context assembly

Status: implemented draft. The three-channel assembly contract is now present
in runtime code; the draft remains open while production eval evidence is
collected and the API names settle.

## Goal

Every Agent model call should make three questions independently visible:

1. Which trusted policy must this model obey?
2. Which canonical conversation history may it see?
3. Which typed facts apply only to this invocation?

The answer must not depend on whether a value is simple enough to interpolate
or complex enough to need a builder. Placement is determined by meaning and
authority, not serialization complexity.

This contract governs Agent decision, execution, review, routing, and
finalization calls. A closed maintenance transform such as history
summarization does not receive general Agent context: it receives one fixed
maintenance instruction and one explicitly selected data input. Its output may
later become Conversation History, but the maintenance call is not another
route for injecting Agent System Policy.

## The three context channels

```text
                    +-> System Policy ----------------------+
Typed invocation ---+                                       +-> model.invoke
context             +-> Conversation History                |
                    |      + Invocation Context ------------+
                    +-----------------------------------------+
```

| Channel | Question it answers | Provider representation |
|---|---|---|
| **System Policy** | What must this model obey? | One node-owned `SystemMessage` |
| **Conversation History** | Which existing interactions may it see? | Canonical messages selected by `queryAgentMessages()` |
| **Invocation Context** | What must it know or process now? | Synthetic, invocation-only messages appended after selected history |

The channels may share a validated typed source. They never read one another's
rendered output and meet only at the model invocation boundary.

## System Policy

System Policy contains code-owned objectives, decision policy, registered
Capability instructions, and provider output protocol. Ordinary nodes build it
the same way as any other prompt: select a domain template and render typed
variables.

```ts
const systemPrompt = ENTRY_ANSWER_SYSTEM_PROMPT.render({
  repairInstruction,
});
```

System Policy is a context channel, not a generic runtime request object. A
node does not restate its target, source list, or actor identity just to render
one template.

### Variant selection

A variant selects one of a finite set of code-owned templates. Its discriminator
must be typed and must come from Framework control flow or validated runtime
configuration.

Planner `entry | boundary` mode is the current reference example. A future
node may define another finite variant, but the selection remains in its
domain builder rather than a shared prompt-construction protocol.

A variant must never be inferred from conversation text, an Announce result, a
tool result, or unconstrained model prose.

Planner mode is the reference case:

```text
CapabilityPlannerInput.mode
  +-> select entry/boundary System Policy
  +-> build entry/boundary Invocation Context
  `-> select valid terminal tools
```

These branches share one typed discriminator. None derives its value by parsing
another branch's rendered prompt.

### Registered instruction composition

Most model calls render one template and need no instruction-source structure.
Capability execution is the exception because a subagent combines instructions
registered by multiple owners:

| Source | Examples |
|---|---|
| `framework` | governing policy and role objective |
| `capability` | instructions from a validated compiled Capability |
| `toolkit` | instructions from Toolkits in the compiled Capability `uses` set |

Conditional instructions, such as informing a Capability that context
summarization is enabled, remain Framework instruction sources. Their presence
does not create another base variant.

That narrow composition contract is:

```ts
composeCapabilitySystemPolicy(systemInstructions);
```

It validates registered instruction ownership, joins the sections, and emits
content-free diagnostics. It is not used by Entry, Answer, Planner, routing,
review, or compaction prompt builders.

A model-selected Capability name becomes eligible only after the terminal
commit is validated, the active delegation is materialized, and the name is
resolved against the compiled registry. Toolkit instructions then follow
deterministically from the compiled Capability definition.

## Conversation History

Conversation History is the only channel that reads canonical Agent messages:

```ts
const history = queryAgentMessages(state.messages)
  .main()
  .delegation(scope)
  .select();
```

The query owns message selection and canonical chronology. It does not own:

- System Policy;
- current task or Planner boundary meaning;
- runtime-environment facts;
- provider output protocol;
- typed domain-message rendering.

Canonical conversation must not be a second System Policy channel. A
`SystemMessage` supplied inside root history must therefore be rejected at the
canonical ingress or checkpoint-validation boundary. Host-owned instructions
use the System Policy path instead. Lane query remains role-agnostic and does
not silently reinterpret or discard canonical input.

Capability-private messages remain selected by exact delegation scope. The
lane and query contract is defined by
[`agent-message-lanes.md`](agent-message-lanes.md).

## Invocation Context

Invocation Context contains typed facts, evidence, task boundaries, and runtime
facts that apply to exactly one model invocation. The owning domain builds the
structure; the message query owns only its final position:

```ts
const contextMessage = buildInvocationContextMessage(typedContext);

const input = queryAgentMessages(state.messages)
  .main()
  .delegation(scope)
  .append(contextMessage)
  .select();
```

Typical Invocation Context includes:

- Planner Entry or Boundary input;
- a Capability delegation briefing;
- terminal answer/finalization facts;
- Auto Review action facts;
- workdir and runtime-environment facts;
- currently available optional interfaces;
- current plan, Announce evidence, and accepted results.

The provider `HumanMessage` role is a transport choice. A synthetic invocation
message is not another user turn. It must carry stable metadata identifying it
as synthetic, invocation-only, and non-authoritative, and its model-visible
envelope must describe whether it is a fact or task boundary.

Each domain owns its model-visible schema:

| Domain | Invocation Context shape |
|---|---|
| Planner | Entry input or `<planning_boundary_event>` |
| Delegation | `<delegation_briefing>` |
| Finalization | `<answer_input>` or its successor |
| Auto Review | `<auto_review_facts>` |

The shared layer may create and stamp the synthetic message, but it must not
invent one generic XML payload for unrelated domains.

## Placement rule

Use this rule before choosing an API:

> Content that changes what the model must obey belongs to System Policy.
> Content that changes what the model knows or must process now belongs to
> Invocation Context. Existing interaction belongs to Conversation History.

| Content | Channel |
|---|---|
| Agent identity, objective, and decision policy | System Policy |
| Planner mode | System Policy variant selector |
| Capability and Toolkit instructions | System Policy instruction sources |
| Structured-output protocol | System Policy template variable |
| User goal, task, plan, Announce, and execution evidence | Invocation Context |
| Workdir and runtime environment | Invocation Context |
| Available optional interfaces | Invocation Context |
| Existing main and delegation-private messages | Conversation History |
| Message, tool, or Announce prose proposed as policy | Rejected |

## Shared selectors, not cross-channel dependencies

Capability execution is the strongest legitimate intersection:

```text
Validated active delegation + compiled Capability
  +-> Capability/Toolkit instructions -> System Policy
  +-> delegation scope                -> Conversation History
  `-> task, goal, runtime facts       -> Invocation Context
```

The resolved typed identity is shared. System rendering does not inspect the
selected history, and history selection does not inspect the rendered system
prompt.

Auto Review follows the same rule. Registered Toolkit policy is trusted System
Policy; action inputs and review views are Invocation Context. A raw `reviews[]`
object should not remain the long-term API for constructing both channels.

## Provider boundary

Provider rendering is downstream of channel assembly. It may:

- convert typed domain messages into provider-compatible messages;
- repair tool-call and ToolMessage ordering;
- apply provider transport requirements.

It must not select lanes, reinterpret Invocation Context, or add business
policy. Provider rendering is not a fourth context channel.

## Implementation status

- Ordinary System Prompts use their domain template plus typed render variables.
- `composeCapabilitySystemPolicy(systemInstructions)` belongs to the Capability
  subagent domain; it preserves registered instruction order and emits
  content-free digests.
- `createInvocationContextMessage()` preserves each domain-owned visible
  schema while applying the shared synthetic, invocation-only, and
  non-authoritative transport metadata.
- Entry, Answer, Planner, routing, review, and compaction select and render their
  own templates directly.
- Entry's execution-announcement retry supplies the template's typed repair
  variable; it does not inject a synthetic user instruction.
- Planner entry and boundary are explicit agents selected by the typed mode;
  middleware no longer replaces their policy or terminal-tool set.
- Capability workdir, runtime environment, and optional-interface facts are one
  invocation-only `<capability_runtime_context>` message before the delegation
  briefing.
- Auto Review selects registered Toolkit policies separately from action facts.
- Root ingress rejects canonical `SystemMessage` values; legacy checkpoint
  history containing one fails closed and is cleared rather than migrated.

Capability System Policy diagnostics contain source, owner, and content digest
only. Invocation Context identity remains observable through message selection
diagnostics and stable synthetic-message metadata.

## Invariants

1. Every Agent decision or execution call has exactly one node-owned System
   Policy; closed maintenance calls have one fixed maintenance instruction.
2. Ordinary policy variables are typed; composed Capability instruction sources
   are finite, typed, and trusted.
3. Root conversation cannot introduce another `SystemMessage` authority.
4. All current facts and task boundaries use Invocation Context.
5. Invocation Context is not persisted merely because it was appended.
6. Conversation query, Invocation Context rendering, and System Policy rendering
   do not read one another's rendered output.
7. The three channels meet only at the model invocation boundary.
8. Provider projection changes transport shape, not authority or ownership.

## Validation

- unit tests assert exact channel shape at each real model boundary;
- tests prove canonical `SystemMessage` values cannot bypass node ownership;
- Planner context audit renders both variants, tools, history, and current input;
- Capability tests distinguish trusted instruction sections from runtime facts;
- model evals cover Entry routing, Planner Boundaries, Capability continuation,
  Auto Review, and terminal synthesis after channel migration.

## Non-goals

This design does not introduce a generic prompt manager, a second message
collection, a persisted invocation-context object, or a shared XML schema for
unrelated domains. It standardizes channel ownership and construction while
leaving domain-specific content with its current owner.
