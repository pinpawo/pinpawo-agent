---
name: studio
description: 'Operate a running PinPawo Studio: inspect Pet progress and pending reviews, dispatch work, manage Kanban assignments, and follow execution through HTTP and SSE.'
---

# Studio

Use the bundled `scripts/studio.py` with Python 3. It reads the existing local
Bearer token without printing it. Defaults: Studio HTTP `http://127.0.0.1:3211`,
Agent Session HTTP `http://127.0.0.1:3212`. Override with `--studio-url`,
`--agent-url`, and `--token-file` when the running Host uses other settings.

## Inspect and coordinate

```sh
python3 scripts/studio.py pets
python3 scripts/studio.py kanban
python3 scripts/studio.py snapshot executor
python3 scripts/studio.py events executor --seconds 30
python3 scripts/studio.py dispatch planner --file /tmp/task.txt
python3 scripts/studio.py assign TASK_ID executor --note 'Start this task'
```

Resolve the script relative to this skill directory. Snapshot prints a compact
projection including the full pending interrupt; use `--full` for delivered
tool messages and other session evidence. Read actual code/test artifacts when
assessing delivery quality; a completed invocation alone is not acceptance.

`assigned` / a dispatch receipt only mean work was submitted. Look for the
session's active run, live events, and Kanban transitions to establish execution.
Queue `waiting` means pending interrupt; queue `blocked` means the Host could not
read settled session state. Kanban status is independent: restart recovery can
mark a task blocked while the session is still waiting for review.

Kanban relationships are not execution dependencies. Assign the next ready task
after its prerequisites are delivered. Preserve the user's scope; do not turn a
request for status into a new task or an approval.

## Review and continue

Read snapshot first. For a human review, inspect each view and its actual options.
Submit only decisions covered by the user's authorization. Do not infer option
IDs, auto-approve an entire unknown batch, or change the global review policy to
unblock a task.

Send the existing Agent Session message using a JSON file:

```sh
python3 scripts/studio.py send executor --file /tmp/resume.json
```

For `human_review`, the message has this shape (replace IDs from the snapshot):

```json
{
  "type": "interrupt.resume",
  "requestId": "a-new-unique-request-id",
  "interruptId": "from-pendingInterrupt",
  "value": {
    "decisions": [
      {"interactionId": "from-review", "selectedOptionId": "from-options"}
    ]
  }
}
```

Other interrupt kinds own their value shape; inspect the protocol/runtime
documentation for that kind rather than sending review decisions. Ordinary
continuation without a pending interrupt uses `chat_request` with requestId and
message. `run.interrupt` uses the active run's requestId.

POST returns 202 before execution finishes. Subscribe to events before sending
when live feedback matters, then verify with snapshot. HTTP commands are owned
by the Host: leaving the SSE connection does not cancel the run. SSE is live
only, with no replay; after disconnect read snapshot again. Do not blindly retry
accepted commands or uncertain mutations. A 404 on these Agent Session routes
can mean the Host predates HTTP support; report that and arrange a controlled
upgrade, rather than taking over the TUI WebSocket connection.
