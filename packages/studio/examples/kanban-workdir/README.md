# Studio Kickstart workdir

This is the runnable Studio Hello World: a small, observable project-delivery
loop. It starts four resident Pets and composes HTTP, Kanban, Scheduler,
Trigger, and Project Files Plugins. Studio core imports none of these concrete
packages; the standalone resolver loads only the packages listed in
`.pinpawo/studio.json`.

```text
external request -> planner -> executor -> reviewer
Kanban task.* event -----------------> Trigger binding -> wiki Pet -> wiki/PROJECT.md
```

Kanban owns task, dependency, status, and history. The Wiki Pet owns Markdown
knowledge alignment. The Trigger Plugin owns the binding from qualifying task
events to a Wiki dispatch; no Wiki-specific integration Plugin is required.

From the repository root, build and start the Host plus the independent Console
with one command. A local Trigger secret is generated when the environment does
not already provide one:

```bash
npm run studio:hello
```

The command prints the Console URL, Studio HTTP URL, Pet TUI command, current
Bearer token, and Trigger secret. To start the two processes separately instead:

```bash
export PINPAWO_HELLO_TRIGGER_SECRET='replace-with-a-local-secret-at-least-16-chars'
npm run build
npm run start -w @pinpawo/studio -- --workdir "$PWD/packages/studio/examples/kanban-workdir" --pet-port 3210
```

In another terminal, start the independent pure frontend:

```bash
npm run dev -w @pinpawo/studio-console
```

Open `http://127.0.0.1:5173`, then enter the local-agent bearer token. The
Console is not served by a Plugin and does not directly access Studio core or a
Plugin database.

The optional Project Files Plugin only lists and reads Markdown under `wiki/`
for the Console Knowledge page. The Wiki Pet still owns file updates; the Plugin
does not write knowledge or interact with an Agent.

The example also demonstrates the per-Pet Capability directory convention:

```text
.pinpawo/pets/<petId>/capabilities/<capability>/CAPABILITY.md
```
