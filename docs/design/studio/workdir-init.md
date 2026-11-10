# Studio Workdir Initialization

## Status

Draft.

## Goal

Studio configuration belongs to a user-selected project workdir. `pinpawo-studio
init --workdir <directory>` creates the initial Studio layout there without
overwriting existing files.

The package must not present a checked-in `.pinpawo/` directory as a runnable
example workdir. `.pinpawo/` is runtime-owned project state and configuration;
it is meaningful only after initialization in a concrete workdir.

## Template and destination

The published package contains a declarative template:

```text
packages/studio/templates/default/
  studio.json
  pets/
  wiki/
```

`init` maps it into the selected workdir:

```text
<workdir>/.pinpawo/studio.json
<workdir>/.pinpawo/pets/
~/.pinpawo/studios/<new-uuid>/wiki/
```

A fresh random UUID is generated once during initialization; the absolute Wiki directory
is saved in the Project Files Plugin options as `wikiDirectory`. The Studio workdir
remains the project/agent workdir. A different worktree can access the same Wiki only
when explicitly configured to use that same directory; names and repository URLs do not
implicitly determine identity. The Wiki is durable user knowledge, not a session cache.

The mapping is owned by Studio's initialization API. Template files never
contain checkpoint data, SQLite databases, resident-session files, or generated
runtime outputs.

`init` installs reusable Pet definitions, configuration, initial Wiki files and
the credentials key; it does not create a Studio database or seed Pet instances.
Start the Host normally, then open the standalone Console with `pinpawo-studio
console`. Both work before any Pet exists. Create a Channel first, then create
its instances with the local Host token (see [Pet instance setup](../../studio/configuration.md#pet-instance-setup)
and [Pet instances](pet-instance.md)). The default template has no Triggers;
add one only after its target instance and owner Channel exist.

After creating an instance, `pinpawo-studio tmux --pet-port <port> --console`
can open its TUI and the Console. On a fresh Studio, tmux rejects empty Pet
discovery before opening the Console; use the standalone Console for bootstrap.
See the [startup commands](../../../services/studio/README.md).

## One initialization path

The standalone CLI and programmatic API use the same initializer. Tests may
create disposable directories to verify it, but there is no long-running
"Hello World" launcher that creates a new implicit workdir for each run.

Users choose a workdir explicitly, initialize it once, then start Studio and
the Console against that same directory. This preserves task, notice, Wiki and
checkpoint state across restarts by normal runtime ownership, rather than by a
demo-specific persistence workaround.

## Safety

- Preflight project destinations before copying anything; allocate the unique Studio data
  directory exclusively. On failure, remove only unchanged files created by this init and
  empty newly created data directories. Preserve any concurrently modified files.
- Refuse an existing destination; do not merge or overwrite.
- Copy only declared configuration, Pet Capability documents, and initial Wiki
  Markdown.
- Runtime state remains ignored by source control and is not shipped in the
  package template.

## Non-goals

- This does not define project upgrade or template-merge behavior.
- It does not start Studio, allocate ports, or install Plugins.
- It does not make project `.pinpawo/` globally shared or synchronize Wiki across
  machines; the Wiki directory must be backed up and migrated as user data.
