# PinPawo Studio

Independent Studio Host/runtime package and executable entry.

It owns the process entry. Concrete Plugins remain externally injected
through `StudioPluginResolver`; Plugin-defined Toolkits enter the Host inventory,
while Agent Capabilities remain independently owned and registered.

Each Pet selects its Agent Capabilities through its conventional directory:

```text
.pinpawo/pets/<petId>/capabilities/<capability>/CAPABILITY.md
```

```bash
npm install --global \
  @pinpawo/studio \
  @pinpawo-plugin/studio-http \
  @pinpawo-plugin/kanban \
  @pinpawo-plugin/scheduler \
  @pinpawo-plugin/notice \
  @pinpawo-plugin/project-files \
  @pinpawo-plugin/trigger

WORKDIR=/path/to/project
pinpawo-studio init --workdir "$WORKDIR"
export PINPAWO_STUDIO_TRIGGER_SECRET='choose-a-secret-at-least-16-characters'
pinpawo-studio --workdir "$WORKDIR"
pinpawo-studio --workdir "$WORKDIR" --pet-port 3212
```

Configured Plugin IDs are installed package names. Each package exposes its
Plugin through `createStudioPlugin()`; Studio core does not import concrete
Plugins. To connect the terminal client to a resident Pet, use the listener port
and Pet ID:

```bash
pinpawo tui --pet-port 3212 --pet-id planner
```

The package also exposes the programmatic Host/runtime API:

```ts
import { StudioHost, runStudioHostProcess } from '@pinpawo/studio';
```

Studio dispatch/event HTTP is provided by the configured HTTP Plugin. The
local-agent Agent Session listener is only for direct conversation with a
resident Pet. The workdir must contain
`.pinpawo/studio.json` and the referenced `.pinpawo/pets/*.json` files.
Per-Pet Capability directories are optional. The Host supplies the `general`
fallback only when a Pet does not configure `defaultCapabilityName`.

`pinpawo-studio init` creates the shipped four-Pet configuration, Capabilities,
and initial `wiki/PROJECT.md` in the selected workdir without overwriting
existing files. The package template itself contains no `.pinpawo/` runtime
directory or generated state.

The default template includes an HTTP Trigger for external requests. Set
`PINPAWO_STUDIO_TRIGGER_SECRET` before starting the Host, or replace that
Trigger in the initialized `.pinpawo/studio.json`.
The independent Studio Console remains a separate frontend application.
