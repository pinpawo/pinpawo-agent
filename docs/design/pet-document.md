# Pet root document

Status: draft

## Goal

`PET.md` is the canonical root document for one Pet. Its position is the same
as an `AGENTS.md` or `CLAUDE.md` loaded for an agent: authors use it to define
who this Pet is, what it is responsible for, how it should work, and which
durable conventions it should follow.

It is not a Capability supplement or a collection of routing hints. Every
model role acting as this Pet receives the same document before handling a
conversation or task.

## Convention

Each Host resolves the document according to its Pet topology:

```text
Chat:   <workdir>/PET.md
Studio: <workdir>/.pinpawo/pets/<petId>/PET.md
```

The Studio path is derived from the validated Pet id and is not repeated in
`pet.json`. Filesystem resolution belongs to each Host. Both modes produce the
same `PetDocument` contract before constructing the Pet agent.

Studio Host reads each document once during initialization and passes the
immutable content and digest into the resident Pet graph. A changed document
therefore takes effect after the Host is restarted.

## Prompt scope

The same Pet document snapshot applies to every model role in one resident Pet:

- Entry Answer, including direct Chat replies;
- Run Supervisor entry and boundary decisions;
- Capability executor calls;
- the final Answer node.

`PET.md` is supplied as system-level authored root context, not as a user
message or task attachment. Framework governance still owns routing,
lifecycle, security, and tool protocol. Tool and Capability availability still
comes from the compiled registry rather than from claims made in the document.

## Responsibility boundaries

- `pet.json` contains machine configuration and identity references.
- `PET.md` is the Pet's root document: identity, responsibilities, operating
  principles, boundaries, and durable working conventions.
- `CAPABILITY.md` defines one discoverable execution responsibility and its
  Toolkit dependencies.
- repository `AGENTS.md` files describe rules owned by the project being worked on.

The default Studio template uses `PET.md` to keep Git worktree isolation at
Executor and Reviewer scope rather than duplicating it across their Capability
documents.
