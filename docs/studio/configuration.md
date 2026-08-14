# Studio Configuration

[简体中文](../zh-CN/studio/configuration.md)

> **Status: current local-host configuration.** The schemas are in
> [`packages/studio/src/configSchema.ts`](../../packages/studio/src/configSchema.ts)
> and local assembly is in
> [`services/local-agent/src/studio/buildStudio.ts`](../../services/local-agent/src/studio/buildStudio.ts).

One workdir has one Studio configuration at
`<workdir>/.pinpawo/studio.json`. Pet files live beside it in
`<workdir>/.pinpawo/pets/<petId>.json`.

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
| `plugins[].id` | When a plugin is listed | Host plugin-factory key. |
| `plugins[].options` | No | Opaque object passed to that plugin factory. |

The configuration rejects an empty or duplicate `pets` list, an entry pet that
is not listed, a referenced pet file that is missing, and unknown plugin IDs.
`plugins` may be omitted for manual host dispatch, but no plugin will then drive
workflow progress. Extra legacy fields are not a migration mechanism and should
be removed; in particular, do not use `plannerPetId`, `agents`, queue, retry,
or scheduler fields.

## Pet configuration

```json
{
  "petId": "writer",
  "name": "Writer",
  "role": "Turn outlines into complete drafts",
  "serviceSummary": "Long-form writing and structured rewriting",
  "modelProfileId": "qwen-max",
  "capabilities": ["general", "explore"]
}
```

`petId` and `name` are required. `capabilities` defaults to an empty array;
`general` is still added by the local host as its required baseline capability.
`modelProfileId` selects a host model profile when present. The old inline
`model` field is rejected explicitly.

`capabilities` contains Capability names, never Toolkit names. The host merges
normal Toolkits and configured Studio plugins into the runtime's Toolkit pool;
a Capability's `uses` declaration selects the tools actually available to a
pet. For example, `kanban` is a Toolkit name, not a value to put in
`capabilities`.

## Plugin assembly

The local host resolves each listed ID through its built-in factory registry.
At present the only built-in ID is `kanban`. Plugin options are passed to the
factory unchanged; the bundled Kanban factory currently declares no options, so
do not rely on `options` for it yet. Third-party Studio-plugin discovery is not
implemented by this host.

`buildStudio()` reads files, resolves pets, builds their runtime adapters, and
then calls `createStudio()`. The package itself performs no filesystem I/O.
After a local host has built a Studio for a workdir, it caches that instance;
restart the host to pick up configuration changes.

For dispatch, gate, and event behavior, read the [push model](push-model.md).

