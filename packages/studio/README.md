# PinPawo Studio

Independent Studio Host/runtime package and executable entry.

It owns the process/transport entry. Concrete optional modules remain externally
injected through `StudioModuleResolver`.

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
