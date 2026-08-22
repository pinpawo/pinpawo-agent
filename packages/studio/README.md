# PinPawo Studio

Independent Studio Host/runtime package and executable entry.

It owns the process/transport entry. Concrete Plugins remain externally injected
through `StudioPluginResolver`; Plugin-defined Toolkits enter the Host inventory,
while Agent Capabilities remain independently owned and registered.

Each Pet selects its Agent Capabilities through its conventional directory:

```text
.pinpawo/pets/<petId>/capabilities/<capability>/CAPABILITY.md
```

```bash
npm install --global @pinpawo/studio

pinpawo-studio --workdir /path/to/project --stdio
pinpawo-studio --workdir /path/to/project --port 3211
```

The package also exposes the programmatic Host/runtime API:

```ts
import { StudioHost, runStudioHostProcess } from '@pinpawo/studio';
```

Exactly one transport must be selected. The workdir must contain
`.pinpawo/studio.json` and the referenced `.pinpawo/pets/*.json` files.
Per-Pet Capability directories are optional; the Host always supplies the
`general` baseline Capability.
