# Writing and Maintaining Documentation

Use this guide when editing repository documentation. Follow
[repository rules](../AGENTS.md) for authority, draft promotion, evidence,
and the explicit Wiki ingest gate.

## Choose the reader and purpose

Identify the reader's task before choosing a path. Follow the existing domain
structure; create a new page only when it has a distinct purpose.

| Purpose | Keep here | Include |
|---|---|---|
| Learn by doing | `guides/`, starting with Getting started | Prerequisites, a bounded first task, and observable results |
| Complete a task | `guides/` or Studio configuration | Conditions, ordered actions, and recovery steps |
| Look up facts | `reference/` | Exact fields, defaults, types, protocols, and limits |
| Understand why | `concepts/` and accepted design records | Relationships, decisions, reasons, and tradeoffs |
| Review a proposal | `design/` | Explicit draft status, boundaries, and open questions |
| Understand earlier work | `history/` or an explicitly historical retained path | Useful decisions, investigations, or migration evidence |

This adapts [Diátaxis](https://www.diataxis.fr/start-here/) to the existing layout.
[Django's documentation](https://docs.djangoproject.com/en/5.2/#how-the-documentation-is-organized)
is an example of task and topic navigation working together.

## Keep one source for each contract

Put API and schema facts in their owning reference. Link from task steps to that
reference. Put design reasons in a design record, and link both ways when useful.
Keep README files as entrances and package-specific build or release instructions.
See GitLab's [single-source guidance](https://docs.gitlab.com/development/documentation/styleguide/#documentation-is-the-single-source-of-truth-ssot).

Some accepted contracts retain paths under `design/`. Do not move or promote
them merely to fit a directory scheme. Preserve their status and source evidence.
If implementation and design disagree, report the disagreement for review.

When reorganizing a page, check inbound links and heading fragments. Preserve
referenced paths with a short successor link, or update their consumers.
GitHub Markdown has no site-wide redirect layer; GitLab's
[redirect guidance](https://docs.gitlab.com/development/documentation/redirects/)
provides a maintenance example, not a mechanism available here.

Use Git for ordinary earlier revisions. Retain a separate historical document
only when its decisions or evidence help a reader understand the current system.

## Write clear instructions

We **参考 STE 清晰写作原则**: use selected clarity principles from
[ASD-STE100](https://www.asd-ste100.org/STE_faq.html). This guide does not claim
formal compliance, certification, or a full review of the standard.

- State the actor. Prefer “The Host rejects the request” to “The request is rejected.”
- Put the condition before the action: “If registration is unhealthy, repair it.”
- Give one action per numbered step. Show commands next to the step they perform.
- Keep one topic per paragraph. Link to detailed contracts instead of repeating them.
- Put required actions and safety limits in the main text, not only in a Note.
- Use consistent domain terms. Preserve `Channel`, `dispatch`, `Pet`, `Capability`,
  type names, field names, command spelling, and schema values.
- Review long English sentences. Use 20 words for procedural sentences and
  25 for descriptive sentences as review prompts, not automated pass/fail limits.
  Do not apply English word counts mechanically to Chinese.

Simplify sentence structure without changing conditions, authority, defaults,
scope, timing, cancellation, or recovery semantics. Do not replace a technical
term with a familiar synonym that changes its domain meaning.

## Check the change

1. Confirm the current behavior against code, tests, or accepted evidence.
2. Check relative links and heading fragments, including inbound references.
3. Parse structured examples and confirm commands against current CLI definitions.
4. Review both language entrances when navigation changes.
5. Run `git diff --check` and inspect the changed paths.
6. Report checks actually performed. Separate static command checks from live runs.

Do not start services solely to verify a prose-only navigation change. When a
command or behavior changes, choose verification appropriate to that change.

## Wiki schema reference

The removed `docs/wiki/` used the following page metadata. This reference preserves
its format for an explicitly requested rebuild; it does not initiate an ingest.

```yaml
---
title: Human-readable title
page_type: concept
status: draft
updated: YYYY-MM-DD
sources:
  - ../../path/to/source.md
related:
  - ../path/to/related-page.md
---
```

Page types: `overview`, `concept`, `system`, `decision`, `investigation`, `source`,
`question`, `migration`. Status values: `seed`, `draft`, `validated`, `contested`,
`deprecated`, `historical`; deprecated pages link to their successor.
Frontmatter relationships supplement repository-relative body links.
