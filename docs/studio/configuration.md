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
`<workdir>/.pinpawo/pets/<petId>/capabilities/`. A Pet can also define stable,
cross-Capability behavior in `<workdir>/.pinpawo/pets/<petId>/PET.md`.

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
    { "id": "@pinpawo-plugin/channel" },
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
  "modelProfileId": "qwen-max",
  "defaultCapabilityName": "studio_planning"
}
```

`petId` and `name` are required. `petId` must be one safe path segment because
it also identifies the Pet's Capability directory. `general` is the default
Capability only when `defaultCapabilityName` is omitted; an explicit default
selects from that Pet's Capability directory instead.
`modelProfileId` selects a host model profile when present. The old inline
`model` field and the old `capabilities` name list are rejected explicitly.
`defaultCapabilityName` marks one available Capability as the preferred default
in the Supervisor's compact routing manifest. Its complete document still uses the
same discovery path as every other Capability, and the setting does not bypass
availability or Toolkit binding.

The former `personality`, `species` and `stage` fields are rejected with guidance
to move their authored content into `PET.md`. `serverBinding` is also rejected:
there is no active cloud Pet synchronization consumer. The implicit Pet Profile
Toolkit and cloud memory/history hydration have been removed. Conversation
history remains owned by session checkpoints. The former `role` and
`serviceSummary` fields are removed; no consumer ever read them.

## Per-Pet root document

`PET.md` is the conventional, optional root document for one Pet:

```text
<workdir>/.pinpawo/pets/writer/PET.md
```

Studio owns this per-Pet location. The ordinary single-Pet Chat Host resolves
the same document contract from `<workdir>/PET.md`; the agent receives a
`PetDocument` and does not interpret either filesystem convention.

PET.md defines identity, responsibilities, principles and durable conventions;
CAPABILITY.md owns executable responsibilities and Toolkit dependencies, JSON owns
machine settings, and repository AGENTS.md owns project development rules.
The full model-scope contract is in [Pet root document](../design/pet-document.md).
Studio snapshots PET.md at startup; restart after edits. Tools and Capabilities
still come from the compiled registry, and framework security remains authoritative.

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
selects the tools available to that Pet. A Toolkit such as `channel` is therefore
named in `CAPABILITY.md` under `uses`, never in Pet JSON.

Run `pinpawo-studio init --workdir <directory>` to create the initial layout in
a selected project. The package ships its source template under
`packages/studio/templates/default/`; it is not itself a runnable workdir.

## Plugin assembly

`@pinpawo/studio` declares a `StudioPluginResolver` port but contains no concrete
Plugin registry and imports no concrete Plugin. The standalone CLI resolves an
explicit package name from `plugins[].id` and requires that installed package to
export `createStudioPlugin(options, environment)`. Embedded callers can replace
that resolver entirely. Options pass through unchanged for the Plugin to validate.
Install each configured package beside `@pinpawo/studio`; configuration does not
download missing packages at startup.

`@pinpawo-plugin/channel` owns goal/message history and fixed Channel/Pet sessions.
Its [current design](../design/studio/channel-addressing-and-execution.md) specifies
unified message addressing, Reply defaults, server-assigned source envelopes and limits.
Default PET.md and Capability templates contain the runtime protocol; existing
workdirs must compare and update those files manually, preserving local instructions.
A link to a design document does not replace the instructions loaded by the Host.

`@pinpawo-plugin/trigger` binds an HTTP, signed GitHub webhook or Studio event source
to a Pet request. Static strings and logic-free templates remain supported; source
credentials, template projection, deduplication and endpoints are documented once in
[Automation Plugins](../design/studio/automation-plugins.md). The default external
request Trigger requires `PINPAWO_STUDIO_TRIGGER_SECRET`; it does not automatically
update Wiki on task or dispatch completion.

`@pinpawo-plugin/project-files` is an optional, read-only projection of Markdown
under a workdir-relative directory (default `wiki`). It contributes
`GET /knowledge` and `GET /knowledge/document?path=...` through the HTTP route
hook. It defines no Toolkit, does not write files, and does not make Studio or
the HTTP Plugin own project knowledge.

Installed Plugins may compose through the opaque `StudioPluginContext.hooks`
broker. Studio matches Plugin and hook names and owns lifecycle cleanup without
importing or interpreting extension contracts. The HTTP Plugin exposes a
`routes` hook; Channel, Scheduler, Trigger, Notice, and Project Files can
contribute their own routes. Each Plugin retains ownership of its stored data.

## Retired Kanban workdirs

The Kanban package, API, tools, task assignment pipeline, and task completion
Wiki Trigger have been retired. Keep existing databases and snapshots as history;
startup does not read, migrate, delete, or clean their schemas.

For an existing workdir, manually compare its files with the shipped template:

1. Remove `@pinpawo-plugin/kanban` from `.pinpawo/studio.json`; install and enable
   `@pinpawo-plugin/channel` when adopting the current Pet template.
2. Remove `dispatch-assigned-kanban-task` and `wiki-on-task-done`. Rewrite any
   external-request prompt that still requires planning into a board.
3. Update Pet `PET.md` and `CAPABILITY.md` documents, preserving local instructions.
   Remove `kanban`, `kanban-planning`, `kanban-execution`, `kanban-reporting`, and
   `kanban-observation` bindings and calls. The old `studio_reporting` Capability
   can be removed: confirmed results now return through the ordinary public reply.
4. Keep the four roles and their valid defaults: `studio_planning`,
   `studio_execution`, `studio_review`, and `wiki_maintenance`. Explicitly request
   work through a Pet session, generic dispatch, or Channel execution. Request
   Wiki maintenance with the changes and evidence that should be reconciled.
5. Preserve `.pinpawo/kanban/`, any `kanban.json`, existing Wiki, and other user data.
   Restart the Host after reviewing the configuration changes.

`init` refuses to overwrite an existing workdir. No empty compatibility Plugin,
automatic assignment replacement, or implicit Wiki trigger is installed. A
missing configured package reports its name and manual configuration guidance.
A completed invocation is execution evidence, not acceptance of the goal.

The Host first calls `resolveStudioHostConfig()` to read files and resolve Plugins,
then initializes its unified Toolkit inventory, and finally calls `buildStudio()`
to build pet runtime adapters and the filesystem-independent `createStudio()` core.
After a Studio Host has built a Studio for a workdir, it keeps that resident instance;
restart the host to pick up configuration changes.

For dispatch, gate, and event behavior, read the [Studio API](../reference/api/studio.md).
