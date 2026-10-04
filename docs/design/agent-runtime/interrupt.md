# Native human review interrupts

Current implementation draft, updated 2026-10-04.

Only human review is a resumable Runtime interrupt. The graph checkpoints a
`review` or `review_batch` payload; the Runtime decodes it as `human_review`,
and the Host projects `{ interruptId, payload: { kind: 'human_review', interactions } }`.
The public projection contains presentation and response choices, never internal
review decisions or authorization effects. `interrupt.resume` names the pending
interrupt and passes its explicit response to the original checkpoint.

Approval resumes the reviewed tool action under its authorization rules.
A valid respond choice supplies new guidance to the reviewed child. Invalid
responses re-interrupt without executing tools or repeating auto-review.
Fresh chat input cannot bypass a pending review.

Rejection or cancellation stops the current round. The reviewed action is not
executed; rejection retains its paired cancellation tool results, while
cancellation removes the unexecuted proposed action. A runtime-written final AI
message explains that the action was not executed. The child returns an ordinary
terminal result with its review decision; Capability finalize and further
Supervisor/model/tool calls are skipped. Root commits its actual tool result and
public explanation, then reaches END. Goal, plan and prior completed evidence
remain factual. A later explicit ordinary input enters Entry, which may choose
continue and let Supervisor reassess the plan in a fresh run.

No task pause signal, paused result, pauseGate, interrupt input policy map, TUI
pause mode, empty-input resume, or held Capability execution remains. Ordinary
questions and iteration limits end normally. Aborting execution creates no
synthetic interrupt; an already-pending human review remains pending.

The Channel queue waits only for genuine pending human review. Review decline
settles as completed and releases the queue. Channel stores historical review
notifications separately from message context; the existing TUI approval surface
resumes human review. A TUI-origin restored run has no Channel publication scope.

Legacy pause checkpoints are unsupported. The Runtime reports a clear error
instructing the user to start a new session, preserving the checkpoint and its
unexecuted action. Raw checkpoint interrupts and the obsolete non-null task-pause state are validated before graph reconstruction: LangGraph
otherwise omits removed nodes from its state view. Session/protocol parsers reject legacy pause projections;
they never silently reinterpret them as idle. No migration deletes stored data.

Implementation: `reviewInterrupt.ts`, `reviewStop.ts`, `readPendingInterrupt.ts`,
`createSubagent.ts`, `capabilityExecution/runner.ts`, `afterCapability.ts` and the
shared `agent-session` projection/parser. The former pause design remains
historical in [delegation-pause-interaction.md](../tui/delegation-pause-interaction.md).
