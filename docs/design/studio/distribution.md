# Studio npm Distribution

Status: implementation draft. The complete installation boundary is covered by
[`services/studio/scripts/install-smoke.ts`](../../../services/studio/scripts/install-smoke.ts).

## Package ownership

- `packages/studio` publishes `@pinpawo/studio-core`: the independent Host,
  runtime, extension contracts, templates and CLI composition functions. It
  imports neither concrete Plugins nor the complete distribution.
- `plugins/*` retain six independent public packages. Each depends on Core;
  no foundational Plugin depends on the complete Studio distribution.
- `services/studio` publishes `@pinpawo/studio`: the `pinpawo-studio` executable,
  a re-export of Core APIs, and normal production dependencies on Core and all
  six foundational Plugins. The distribution pins this tested package set to
  exact versions. Configuration still controls Plugin activation.

The complete distribution resolves Plugin packages relative to its own installed
location. This prevents an embedded or separately hoisted Core from selecting an
unrelated Plugin installation. An explicit caller-provided resolver or importer
continues to take precedence.

## Installation and release

Users install only `@pinpawo/studio`. Additional third-party Plugins still need
installation and explicit configuration. Startup never downloads packages and
initialization does not overwrite existing workdirs. The Console frontend
retains its separate deployment contract.

Publish Core and its runtime dependencies before the six Plugins; publish the
complete Studio distribution last. Each remains an ordinary npm package.

Before publication, the install smoke packs all local workspace packages and
serves them through an ephemeral loopback registry. Unrelated dependencies use
the public npm registry; a missing workspace fixture fails rather than falling
back to an older public package. The consumer installs only the distribution
tarball, and every other workspace package must be resolved transitively.

The smoke checks the installed exports and CLI, initializes the shipped workdir,
starts the real resident Host with all six Plugins, checks their HTTP routes,
and shuts down the Host. Only the HTTP port is changed to an ephemeral test port;
a synthetic model profile and isolated home prevent use of user credentials,
model requests or real session state.
