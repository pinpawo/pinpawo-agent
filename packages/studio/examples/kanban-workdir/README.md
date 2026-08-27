# Kanban Studio workdir

This example is the runnable Studio Hello World. It starts one resident Planner
with the `studio_planning` Capability and composes API-only HTTP, Kanban,
Scheduler, and Trigger Plugins. Studio core does not import those concrete
packages; the standalone resolver loads only the packages listed in
`.pinpawo/studio.json`.

The Trigger reads its secret from the environment so the repository does not
contain a credential:

```bash
export PINPAWO_HELLO_TRIGGER_SECRET='replace-with-a-local-secret-at-least-16-chars'
npm run build
npm run start -w @pinpawo/studio -- --workdir "$PWD/packages/studio/examples/kanban-workdir"
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
.pinpawo/pets/planner/capabilities/studio-planning/CAPABILITY.md
```
