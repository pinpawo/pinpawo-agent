# PinPawo Studio Application

Standalone application composition root for `@pinpawo/studio`.

It owns the installed optional-module catalog and the process/transport entry.
Studio core remains independent of Kanban and other concrete modules.

```bash
npm run build -w @pinpawo/studio-app

pinpawo-studio --workdir /path/to/project --stdio
pinpawo-studio --workdir /path/to/project --port 3211
```

Exactly one transport must be selected. The workdir must contain
`.pinpawo/studio.json` and the referenced `.pinpawo/pets/*.json` files.
