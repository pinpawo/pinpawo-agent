# Kanban Studio workdir

This example shows the per-Pet Capability directory convention and standalone
CLI Plugin composition. From a checkout, build the selected Plugin packages,
configure a local model profile as usual, then run:

```sh
npm run build -w @pinpawo-plugin/studio-http
npm run build -w @pinpawo-plugin/kanban
npm run start -w @pinpawo/studio -- --workdir . --port 4311
```

Run the command from this directory (or provide its absolute path as
`--workdir`). Open `http://127.0.0.1:4310/` for the Kanban Console. The HTTP
Plugin listens on `4310`, the Kanban Plugin owns `.pinpawo/kanban/tasks.sqlite`,
and the zero-Toolkit Console Plugin contributes the bundled UI through the HTTP
Plugin's static hook. The CLI dynamically resolves only the explicit package
specifiers in `.pinpawo/studio.json`; Studio itself does not contain a concrete
Plugin catalog.

The example registers a `planner` Pet whose default Capability is
`kanban_planning`, plus a `worker` whose default Capability is
`kanban_task_execution`. The Kanban Toolkit exposes the current Studio Pet
registry to the Planner and rejects unknown assignees before a task is
persisted. The Worker can use normal local Toolkits and must report completion
or a block through the Kanban Toolkit.
