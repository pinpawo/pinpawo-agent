# PinPawo Studio Core

`@pinpawo/studio-core` provides the independent Studio Host/runtime, extension
contracts, configuration, workdir templates and CLI composition functions.
It does not depend on concrete Plugins or install an executable.

For the complete CLI with all six foundational Plugins, install
[`@pinpawo/studio`](../../services/studio/README.md).

Plugin authors and embedded Hosts import contracts and runtime APIs from
`@pinpawo/studio-core`. Concrete Plugins are injected through
`StudioPluginResolver`; the complete distribution resolves its own installed
Plugin dependencies. Core never imports that distribution or a concrete Plugin.

See [Studio configuration](../../docs/studio/configuration.md) and
[Studio API](../../docs/reference/api/studio.md).
