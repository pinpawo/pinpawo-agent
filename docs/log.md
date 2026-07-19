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
