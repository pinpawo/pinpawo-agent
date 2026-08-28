# Studio Kickstart workdir

This is the runnable Studio Hello World: a small, observable project-delivery
loop. It starts four resident Pets and composes HTTP, Kanban, Scheduler, and
Trigger Plugins. Studio core imports none of these concrete
packages; the standalone resolver loads only the packages listed in
`.pinpawo/studio.json`.

```text
external request -> planner -> executor -> reviewer
Kanban task.* event -----------------> Trigger binding -> wiki Pet -> wiki/PROJECT.md
```

Kanban owns task, dependency, status, and history. The Wiki Pet owns Markdown
knowledge alignment. The Trigger Plugin owns the binding from qualifying task
events to a Wiki dispatch; no Wiki-specific integration Plugin is required.

The Trigger reads its secret from the environment so the repository does not
contain a credential:

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

The example also demonstrates the per-Pet Capability directory convention:

```text
.pinpawo/pets/<petId>/capabilities/<capability>/CAPABILITY.md
```
