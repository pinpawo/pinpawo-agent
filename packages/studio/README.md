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

pinpawo-studio init --workdir /path/to/project
pinpawo-studio --workdir /path/to/project
pinpawo-studio --workdir /path/to/project --pet-port 3212
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

`pinpawo-studio init` copies the shipped four-Pet kickstart configuration,
Capabilities, and initial `wiki/PROJECT.md` without overwriting existing files.
The independent Studio Console remains a separate frontend application.
