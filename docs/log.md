# Documentation Wiki Log

Append-only record of source ingests, queries that produced durable synthesis,
lint passes, and documentation migrations.

## [2026-07-20] ingest | System prompt design knowledge

- Registered the Karpathy LLM Wiki method as an external source.
- Ingested current orchestrator prompt implementation, schemas, tests, core design
  documents, and the accepted PR/issue history from #338 through #404.
- Created the first system prompt knowledge map, core concept pages, an explicit
  completion-acknowledgement decision page, the entryDecision routing
  investigation, and open questions.

## [2026-07-20] migration | Documentation wiki foundation

- Added the documentation schema in `docs/AGENTS.md`.
- Added the master catalog in `docs/index.md`.
- Added a staged plan for managing all existing documents through ingest, query,
  lint, and migration workflows without bulk-moving current files.

## [2026-07-20] ingest | System prompt authoring principles

- Reviewed current official OpenAI, Anthropic, and Google model prompting
  guidance plus primary agent-computer-interface evidence.
- Added a positive-first authoring contract that distinguishes weak anti-only
  steering from necessary semantic, authority, and safety boundaries.
- Connected prompt clauses to harness ownership, deterministic enforcement,
  model-specific tuning, representative evals, and design traceability.
- Preserved the accepted fixed delegation-completion acknowledgement and scoped
  the entryDecision regression to the general existing-evidence/new-execution
  boundary.

## [2026-07-20] decision tracking | System prompt evolution issues

- Created #418 as the umbrella for evidence-based, owner-traceable system prompt
  evolution.
- Split delivery into #416 for the entryDecision evidence/execution correction,
  #417 for the positive-first V1 refactor, and #415 for the Prompt Contract Map.
- Kept the fixed completion acknowledgement, message provenance, graph ownership,
  and deterministic prompt/harness boundary as program invariants.

## [2026-07-20] simplify | Prompt Contract Map

- Replaced the proposed clause-level manifest with a five-column Markdown map in
  the system prompt overview.
- Made stable behavior contracts, rather than prompt sentences, the unit of
  traceability.
- Deferred dedicated lifecycle, model-scope, manifest, and lint concepts until a
  concrete missing relationship proves they are needed.
