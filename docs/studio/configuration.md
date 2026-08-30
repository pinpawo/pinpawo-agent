# Studio Configuration

[简体中文](../zh-CN/studio/configuration.md)

> **Status: current local-host configuration.** The schemas are in
> [`packages/studio/src/configSchema.ts`](../../packages/studio/src/configSchema.ts)
> and Host assembly is in
> [`packages/studio/src/host/buildStudio.ts`](../../packages/studio/src/host/buildStudio.ts).

One workdir has one Studio configuration at
`<workdir>/.pinpawo/studio.json`. Pet files live beside it in
`<workdir>/.pinpawo/pets/<petId>.json`. Each Pet owns a conventional
Capability collection at
`<workdir>/.pinpawo/pets/<petId>/capabilities/`.

## `studio.json`

```json
{
  "studioId": "content-studio",
  "name": "Content Studio",
  "description": "A drafting and review workflow",
  "entryPetId": "planner",
  "pets": ["planner", "writer", "reviewer"],
  "plugins": [
    { "id": "@pinpawo-plugin/studio-http", "options": { "port": 3211 } },
    { "id": "@pinpawo-plugin/kanban" },
    { "id": "@pinpawo-plugin/project-files", "options": { "directory": "wiki" } }
  ]
}
```

| Field | Required | Meaning |
|---|---:|---|
| `studioId` | Yes | Stable name for this Studio instance. |
| `entryPetId` | Yes | Default target for an external request. It has no other privilege. |
| `pets` | Yes | Non-empty ordered list of referenced pet IDs. |
| `name`, `description` | No | Display metadata. |
| `plugins` | No | Explicit plugin list; order is plugin start order. |
| `plugins[].id` | When a Plugin is listed | Installed Plugin package name resolved by `StudioPluginResolver`. |
| `plugins[].options` | No | Opaque object passed to that Plugin resolver. |

The configuration rejects an empty or duplicate `pets` list, an entry pet that
is not listed, or a referenced pet file that is missing. A configured Plugin
fails fast when no resolver is installed or the resolver cannot resolve it.
`plugins` may be omitted for manual host dispatch, but no plugin will then drive
workflow progress. Extra legacy fields are not a migration mechanism and should
be removed; in particular, do not use `plannerPetId`, `agents`, queue, retry,
or scheduler fields.

The same Plugin ID may appear more than once with different options. Each
resolved Plugin instance must still expose a unique `name`, because that name
is its lifecycle and event-source identity inside Studio.

## Pet configuration

```json
{
  "petId": "writer",
  "name": "Writer",
  "role": "Turn outlines into complete drafts",
  "serviceSummary": "Long-form writing and structured rewriting",
  "modelProfileId": "qwen-max",
  "defaultCapabilityName": "studio-planning"
}
```

`petId` and `name` are required. `petId` must be one safe path segment because
it also identifies the Pet's Capability directory. `general` is the default
Capability only when `defaultCapabilityName` is omitted; an explicit default
selects from that Pet's Capability directory instead.
`modelProfileId` selects a host model profile when present. The old inline
`model` field and the old `capabilities` name list are rejected explicitly.
`defaultCapabilityName` marks one available Capability as the preferred default
in the Planner's compact routing manifest. Its complete document still uses the
same discovery path as every other Capability, and the setting does not bypass
availability or Toolkit binding.

## Per-Pet Capability directory

Directory membership is the Pet's Capability selection. No additional directory
configuration or name allowlist is required:

```text
<workdir>/.pinpawo/pets/writer/capabilities/
├── explore/
│   └── CAPABILITY.md
└── studio-planning/
    └── CAPABILITY.md
```

Every immediate child must be a valid Capability directory. Invalid documents
or duplicate Capability names fail Host startup. Directory symlinks are allowed,
so multiple Pets can select one shared Capability without copying it. Capability
names are scoped per Pet: two Pets may load different definitions with the same
name, while duplicates inside one Pet remain an error.

The Host merges normal Toolkits and Toolkits defined by configured Studio Plugins
into its unified Toolkit inventory. Each loaded Capability's `uses` declaration
selects the tools available to that Pet. A Toolkit such as `kanban` is therefore
named in `CAPABILITY.md` under `uses`, never in Pet JSON.

The repository includes a complete layout example under
`packages/studio/examples/kanban-workdir/`.

## Plugin assembly

`@pinpawo/studio` declares a `StudioPluginResolver` port but contains no concrete
Plugin registry and imports no concrete Plugin. The standalone CLI resolves an
explicit package name from `plugins[].id` and requires that installed package to
export `createStudioPlugin(options, environment)`. Embedded callers can replace
that resolver entirely. Options pass through unchanged for the Plugin to validate.
Install each configured package beside `@pinpawo/studio`; configuration does not
download missing packages at startup.

`@pinpawo-plugin/kanban` provides a concrete Kanban Plugin and is not a
Studio dependency. The Plugin defines its Kanban Toolkit but does not contribute
the matching `studio_planning` Capability. A Pet selects that independent Agent
Capability by placing its `CAPABILITY.md` directory under the conventional
per-Pet root. The resolver loads only packages named explicitly by configuration;
it does not scan directories or discover Plugins implicitly.

Durable Plugin state remains Plugin-owned. The installed Kanban package defaults
to `<workdir>/.pinpawo/kanban/tasks.sqlite`; an embedded application can instead
construct `createKanbanPlugin({ databasePath: ... })` with an absolute path such as
`<workdir>/.pinpawo/kanban/<instance>/kanban.sqlite`; Studio core neither derives
that path nor reads task state. Direct `createKanbanPlugin()` remains explicitly
in-memory. A larger Kanban application can instead own a
`KanbanTaskService` itself and inject it into the Studio adapter.

Kanban dispatch defaults to `"automatic"`: each dependency-ready task is claimed
and sent through Studio dispatch. Set Plugin option `"dispatchMode": "manual"`
to keep ready tasks queued until an operator calls `POST /kanban/control` with
`{"action":"start","taskId":"..."}`. The same explicit start can retry a
blocked task after its dependencies are complete. This control remains Kanban
domain/API behavior; Studio core does not interpret task state.

`@pinpawo-plugin/trigger` binds either an HTTP source or a Studio event
condition to one Pet dispatch. For example, a `studio_event` trigger matching
Kanban `task.*` can dispatch a Wiki Pet; the Pet maintains ordinary workdir
Markdown through its own Capability rather than through a Wiki-specific
Toolkit or Plugin. Its current contract is documented in the
[Studio automation Plugins draft](../design/studio/automation-plugins.md).

A Trigger `request` may remain a string, or use a logic-free template with an
explicit context projection:

```json
{
  "request": {
    "template": "Reconcile task {{payload.taskId}} after {{event.type}}.",
    "context": ["payload.taskId", "payload.note", "event.occurredAt"]
  }
}
```

The normalized template envelope contains `triggerId`, `source`, optional
`event`, and `payload`. Templates only render the outgoing dispatch request;
they do not select Agent Capabilities, Toolkits, models, or threads.

A GitHub webhook binding uses `source.kind: "github"`, a `secretEnv`, and the
GitHub webhook `event` (plus optional payload `action`). GitHub sends it to
`POST /triggers/github`; the Trigger Plugin verifies `X-Hub-Signature-256` and
deduplicates `X-GitHub-Delivery` before dispatching the configured Pet.

`@pinpawo-plugin/project-files` is an optional, read-only projection of Markdown
under a workdir-relative directory (default `wiki`). It contributes
`GET /knowledge` and `GET /knowledge/document?path=...` through the HTTP route
hook. It defines no Toolkit, does not write files, and does not make Studio or
the HTTP Plugin own project knowledge.

Existing file-backed `kanban.json` state is not loaded implicitly. Before changing
an existing resolver to `databasePath`, run the explicit
`migrateKanbanSnapshotToSqlite({ snapshotFile, databaseFile })` export once; it
keeps the JSON source and refuses to write into a non-empty destination.

Installed Plugins may compose through the opaque `StudioPluginContext.hooks`
broker. Studio only matches Plugin and hook names and owns lifecycle cleanup; it
does not import or interpret extension contracts. The HTTP Plugin exposes a
`routes` hook, while Kanban optionally contributes its `/kanban` snapshot,
history, and control routes.
Kanban remains valid when HTTP is absent, and HTTP never depends on Kanban.

The Host first calls `resolveStudioHostConfig()` to read files and resolve Plugins,
then initializes its unified Toolkit inventory, and finally calls `buildStudio()`
to build pet runtime adapters and the filesystem-independent `createStudio()` core.
After a Studio Host has built a Studio for a workdir, it keeps that resident instance;
restart the host to pick up configuration changes.

For dispatch, gate, and event behavior, read the [Studio API](../reference/api/studio.md).
