# Studio Kickstart workdir

This is the runnable Studio Hello World: a small, observable project-delivery
loop. It starts four resident Pets and composes HTTP, Kanban, Scheduler,
Trigger, and Project Files Plugins. Studio core imports none of these concrete
packages; the standalone resolver loads only the packages listed in
`.pinpawo/studio.json`.

```text
external request -> planner -> Kanban tasks -> user assignment -> Trigger -> executor / reviewer
Kanban task.done event --------------> Trigger binding -> wiki Pet -> wiki/PROJECT.md
```

Kanban owns task, dependency, status, history, and the user-selected execution
target. It does not discover Studio Pets or dispatch work. Trigger owns the
rules that route qualifying events—both `task.assigned` and `task.done` in this
example—to Pets. The Wiki Pet owns Markdown knowledge alignment; no
Wiki-specific integration Plugin is required.

From the repository root, build and start the Host plus the independent Console
with one command. A local Trigger secret is generated when the environment does
not already provide one:

```bash
npm run studio:hello
```

The command initializes an isolated temporary workdir, waits for both HTTP and
Console readiness, and prints the runtime workdir, Console URL, Studio HTTP URL,
Pet TUI command, current Bearer token, and Trigger secret. The temporary workdir
is removed after shutdown, so running the demo never mutates this published
template or inherits a previous run's task/checkpoint state.

For a terminal dashboard, start or reuse the same demo through tmux:

```bash
npm run studio:hello:tmux
```

This creates a `pinpawo-studio` session. When port `3210` is not already in use,
the `host` window starts `studio:hello`; the `pets` window contains tiled
`planner`, `executor`, `reviewer`, and `wiki` TUIs. Mouse mode is enabled for
pane selection and scrolling. Reattach or rebuild the dashboard with:

```bash
tmux attach-session -t pinpawo-studio
npm run studio:hello:tmux -- --reset
```

Use `--detached` to prepare the session without attaching. To start the two
processes separately against a persistent initialized workdir instead:

```bash
export PINPAWO_HELLO_TRIGGER_SECRET='replace-with-a-local-secret-at-least-16-chars'
npm run build
HELLO_WORKDIR="$(mktemp -d)"
node packages/studio/dist/cli.js init --workdir "$HELLO_WORKDIR"
npm run start -w @pinpawo/studio -- --workdir "$HELLO_WORKDIR" --pet-port 3210
```

In another terminal, start the independent pure frontend:

```bash
npm run dev -w @pinpawo/studio-console
```

Open `http://127.0.0.1:5173`, then enter the local-agent bearer token. The
Console is not served by a Plugin and does not directly access Studio core or a
Plugin database.

To run the real project-delivery loop from the Console, open **studio**, keep
`planner` selected, and dispatch a concrete goal such as:

```text
Create a concise HELLO.md in the project root, then have an independent reviewer verify it.
```

Watch **kanban** for the Planner-created dependency flow. Expand each ready task,
select its executor, and choose **ASSIGN**; Trigger records the resulting delivery
and routes it to the selected Pet. Then watch **knowledge** for the Wiki Pet's
`PROJECT.md` reconciliation. Knowledge is an ordinary project file rather than a
Studio event projection, so use its explicit **REFRESH** action after the final
`task.done` event.

The same entry can be exercised as an external HTTP Trigger using the secret
printed by `npm run studio:hello`:

```bash
curl -X POST http://127.0.0.1:3211/triggers/invoke \
  -H 'Authorization: Trigger <printed-trigger-secret>' \
  -H 'Content-Type: application/json' \
  --data '{"triggerId":"hello","idempotencyKey":"hello-1","payload":{"goal":"Create a concise HELLO.md, then review it."}}'
```

The optional Project Files Plugin only lists and reads Markdown under `wiki/`
for the Console Knowledge page. The Wiki Pet still owns file updates; the Plugin
does not write knowledge or interact with an Agent.

The example also demonstrates the per-Pet Capability directory convention:

```text
.pinpawo/pets/<petId>/capabilities/<capability>/CAPABILITY.md
```
