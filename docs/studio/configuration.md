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
  "plugins": [{ "id": "kanban" }]
}
```

| Field | Required | Meaning |
|---|---:|---|
| `studioId` | Yes | Stable name for this Studio instance. |
| `entryPetId` | Yes | Default target for an external request. It has no other privilege. |
| `pets` | Yes | Non-empty ordered list of referenced pet IDs. |
| `name`, `description` | No | Display metadata. |
| `plugins` | No | Explicit plugin list; order is plugin start order. |
| `plugins[].id` | When a Plugin is listed | Plugin ID resolved by the injected `StudioPluginResolver`. |
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
  "modelProfileId": "qwen-max"
}
```

`petId` and `name` are required. `petId` must be one safe path segment because
it also identifies the Pet's Capability directory. `general` is added by the
local host as its required baseline Capability.
`modelProfileId` selects a host model profile when present. The old inline
`model` field and the old `capabilities` name list are rejected explicitly.

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

`@pinpawo/studio` declares a `StudioPluginResolver` port but contains no Plugin
registry and imports no concrete Plugin. A Host caller maps installed IDs to
Plugin implementations and passes `resolvePlugin` to `StudioHost`. Options pass
through unchanged for the Plugin to validate.

`@pinpawo-toolkit/studio-kanban` provides a concrete Kanban Plugin and is not a
Studio dependency. The Plugin defines its Kanban Toolkit but does not contribute
the matching `studio_planning` Capability. A Pet selects that independent Agent
Capability by placing its `CAPABILITY.md` directory under the conventional
per-Pet root. Installation/discovery policy for Plugins remains outside Studio;
callers inject concrete Plugins through `StudioPluginResolver`.

Durable Plugin state remains Plugin-owned. For example, an application resolver
can construct `createKanbanPlugin({ stateStore: createFileKanbanStateStore(...) })`.
The application chooses an absolute path such as
`<workdir>/.pinpawo/studio/<plugin-instance>/kanban.json`; Studio neither derives
that path nor reads the snapshot. Without a state store, the same Plugin remains
an explicitly in-memory instance.

Installed Plugins may compose through the opaque `StudioPluginContext.hooks`
broker. Studio only matches Plugin and hook names and owns lifecycle cleanup; it
does not import or interpret extension contracts. The HTTP Plugin exposes a
`routes` hook, while Kanban optionally contributes its `/kanban` snapshot route.
Kanban remains valid when HTTP is absent, and HTTP never depends on Kanban.

The Host first calls `resolveStudioHostConfig()` to read files and resolve Plugins,
then initializes its unified Toolkit inventory, and finally calls `buildStudio()`
to build pet runtime adapters and the filesystem-independent `createStudio()` core.
After a Studio Host has built a Studio for a workdir, it keeps that resident instance;
restart the host to pick up configuration changes.

For dispatch, gate, and event behavior, read the [push model](push-model.md).
