# Optional Issuer Pet example

This is an optional definition, not part of the default Studio initialization.
It gives an Issuer a dedicated `studio_issue` Capability while retaining the
shared files, shell, web, git, github, and channel Toolkits. The default selects
that Capability rather than adding the Host's `general` Capability to this Pet.
The example is provided in the source repository; it is not included in the
current npm package.

To use it in a Studio workdir, copy `config.json` to `.pinpawo/pets/issuer.json`
and copy `PET.md` and `capabilities/` to `.pinpawo/pets/issuer/`. Check for
existing files first and preserve any local customizations. Add `issuer` to the
`definitions` list in `.pinpawo/studio.json` and restart the Studio Host to
load the definition and its Capability. Ensure its declared Toolkits, including
the Channel Plugin, are configured and available. The installed Channel Plugin
provides the shared `channel_context` Capability; no per-Pet copy is needed.
The example uses a generic `config.json` filename. The destination retains the
Host's existing `pets/<definitionId>.json` loading convention.

Create a Pet instance explicitly after the Host loads the definition, for example
`pinpawo-studio pets create issuer --definition issuer --name Issuer`, and add
it to the appropriate Channel. Creating the definition does not create an
instance or grant permission to change Issue state. Use the Channel's shared
prompt for team roles and collaboration conventions.
