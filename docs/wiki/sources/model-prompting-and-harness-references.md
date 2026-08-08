---
title: Model Prompting and Harness References
page_type: source
status: draft
updated: 2026-08-08
sources:
  - https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6#prompting-best-practices
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8
  - https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
  - https://www.anthropic.com/engineering/april-23-postmortem
  - https://ai.google.dev/gemini-api/docs/prompting-strategies
  - https://www.anthropic.com/engineering/building-effective-agents
  - https://arxiv.org/abs/2405.15793
related:
  - ../concepts/system-prompt-authoring-principles.md
  - system-prompts-source-registry.md
---

# Model Prompting and Harness References

External references are comparison and method sources, not repository authority.
They were reviewed on 2026-07-20. Model-specific advice can become stale and must
be rechecked during model upgrades.

## OpenAI GPT-5.6 model guidance

Source: [OpenAI model guidance for GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6#prompting-best-practices).

Relevant claims:

- newer models can infer more user intent, so developers often need not prescribe
  every reasoning step; domain context, hard constraints, approval boundaries,
  success criteria, and important ambiguity triggers remain valuable;
- leaner system prompts, one owner per instruction, concise tool descriptions,
  and task-relevant tool exposure can improve quality and efficiency;
- broad brevity rules should be replaced by an explicit content priority when
  they cause required information to be omitted;
- outcome-focused prompts should state goal, context, constraints, required
  evidence, success criteria, and output format;
- representative evals, not prompt intuition or fewer tokens alone, determine
  whether a prompt or orchestration change is an improvement.

The guide itself still uses narrow negative constraints for genuine authority and
workflow boundaries. It therefore supports reducing anti-only and duplicated
rules, not banning negation.

## Anthropic current-model prompting guidance

Sources:

- [Prompting Claude Opus 4.8](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8)
- [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)

Relevant claims:

- positive examples tend to control response style more effectively than
  negative examples or instructions about what not to do;
- current models respond best to clear, direct instructions, explicit desired
  outputs, sufficient context or motivation, and consistent structure;
- stronger models can over-trigger on scaffolding introduced for older models;
  model upgrades should revisit forced progress messages, anti-laziness clauses,
  and similar compensating instructions;
- effort and thinking controls can be a better lever than prompting around a
  model configuration;
- literal instruction following makes scope, ownership, and contradictions more
  consequential, not less.

Anthropic also publishes useful negative constraints for narrow boundaries, such
as when not to spawn a subagent. The evidence favors a positive-first contract,
not an absolute language-style ban.

## Anthropic Claude Code quality postmortem

Source: [An update on recent Claude Code quality reports](https://www.anthropic.com/engineering/april-23-postmortem).

**Observation:** a global instruction to constrain text between tool calls and
final-response length, combined with other prompt changes, reduced coding
quality. The regression was found through a broader evaluation and line-level
ablation, then reverted. The same report describes separate quality failures
from lowering default reasoning effort and repeatedly dropping earlier thinking
after an idle session.

**Repository inference:** a system prompt should give the model a concise,
positive direction and preserve room for task-relevant reasoning. Prompt text
is not a substitute for model invocation settings, context continuity, or
deterministic protocol enforcement. This observation does not establish that
all negative wording is harmful; genuine safety and authority boundaries remain
valid.

## Google Gemini prompting strategies

Source: [Gemini prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies).

Relevant claims:

- state goals precisely and directly;
- separate role, instructions, context, constraints, and output with a consistent
  structure;
- explicitly define ambiguous parameters and output requirements;
- use tools such as grounding and code execution when the answer needs external
  facts or deterministic computation.

Google's examples include both positive and negative constraints. The durable
cross-provider principle is clarity and operational support, rather than a ban on
specific grammatical forms.

## Agent and harness engineering

Sources:

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793)

Relevant claims:

- successful agent systems favor simple, composable patterns and add complexity
  only when measured outcomes justify it;
- deterministic workflows and programmatic gates are appropriate when the path
  or check is known, while model-driven decisions belong where flexibility is
  required;
- tool documentation, testing, observation, and the wider agent-computer
  interface materially affect agent behavior and performance;
- a specially designed agent-computer interface can outperform a baseline that
  relies on a generic interface, demonstrating that prompt wording is only one
  part of the harness.

## Repository interpretation

**Inference:** these sources support the repository's existing separation of
static contract, injected facts, and deterministic enforcement. They additionally
support a positive-first authoring rule and systematic removal of duplicated or
legacy model-compensation clauses.

**Non-claim:** the sources do not prove that every sentence containing “do not”
reduces performance. They show that negative-only steering is often weaker or
less informative, while narrow hard boundaries can remain necessary.
