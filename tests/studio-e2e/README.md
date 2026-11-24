# Studio acceptance tests

This workspace tests behavior across Studio, Channel, and the resident Pet Host.
Run commands below from the repository root with Node.js 24 or newer.

## Pet Head Timeline scenarios

These scenarios run only when explicitly requested through the commands below.
There is no scenario workflow. The ordinary workspace and root `npm test` commands
exclude `src/scenarios/`; existing CI may typecheck these files but does not run
the scenarios or upload their reports.

The [scenario runner](src/scenarios/petHeadTimeline.ts) exercises the production
`buildStudio`, Pet Head assembly, resident Host, and Channel message path. The
offline profile replaces only the model transport with a scripted OpenAI-compatible
server on loopback. It does not call a remote model or read a personal model profile.
Each trial creates fresh temporary Studio, Channel, Pet, checkpoint, and session
state, then closes the Host and removes that state.

The three cases form one user journey within each trial:

| Case ID | Setup | User behavior | Program assertions |
| --- | --- | --- | --- |
| `first-tool-call` | A Channel owns a live Pet with the read-only `synthetic_lookup` tool. | Post a first request to read the synthetic cobalt record. | The owner Head receives the source; one real lookup runs; its fresh receipt reaches the public reply; dispatch completes and registers a session. |
| `referenced-follow-up` | Keep the first reply and its session binding. | Post a follow-up with `replyTo` referencing that reply. | The reference reaches the Head and session history; the prior answer remains; the same session performs one fresh lookup and publishes its new receipt. |
| `cross-channel-head-isolation` | Create a second Channel and observe the owner's Head subscription boundary. | Post a message in the other Channel; the harness then posts a self-authored owner-Channel barrier. | The foreign event is committed and published but never enters the owner's Head handler; its subscription has the exact owner topic; the owner barrier still reaches the handler. |

These assertions inspect structured events, tool calls, session identities, and
Timeline records. They do not grade model prose. The offline profile is
`scripted-openai`, with model `scenario-fixture`.

Resident Host public replies currently leave `replyTo` unset; the scenarios
record that behavior as `publicReplyAutoLinked: false`. The user's explicit
follow-up reference still reaches the Head and the session history.

### Prepare and run offline

Install dependencies and build the runtime prerequisites:

```sh
npm ci
npm run build -w @pinpawo-toolkit/browser
npm run build -w @pinpawo/agent-contracts
npm run build -w @pinpawo/agent-session
npm run build -w @pinpawo/pet-agent
npm run build -w pinpawo
npm run build -w @pinpawo/studio-core
npm run build -w @pinpawo-plugin/channel
```

Run the deterministic scenario suite:

```sh
npm run test:scenarios -w @pinpawo-tests/studio-e2e
```

The runner executes three trials. This offline entry point also runs
[live gateway safety tests](src/scenarios/liveModelGateway.test.ts) with mocked
`fetch`; those tests do not contact a remote model. The ordinary workspace test
command runs the remaining Studio acceptance tests and excludes these scenarios,
gateway safety tests, and isolation tests:

```sh
npm test -w @pinpawo-tests/studio-e2e
```

The default report is
`tests/studio-e2e/artifacts/pet-head-scenarios/offline-report.json`. To put it
elsewhere, set `STUDIO_SCENARIO_REPORT`; use an absolute path to avoid ambiguity
from npm's workspace working directory.

### Explicit live evaluation

The [live entry point](scripts/petHeadTimelineLive.ts) requires explicit opt-in and
explicit endpoint, model, credential environment-variable name, and profile label.
It does not select a saved profile or read a user configuration file. A scenario-only
[bootstrap](src/scenarios/isolateScenarioConfig.ts) intercepts the Host's implicit
personal-config and dotenv reads before Host import, returning synthetic defaults
without reading those files. Configure
the credential in `STUDIO_SCENARIO_API_KEY` before running this example, and replace
the endpoint, model, and profile placeholders with reviewed values:

```sh
npm run scenario:live -w @pinpawo-tests/studio-e2e -- \
  --live \
  --base-url 'https://provider.example/v1' \
  --model 'replace-with-model-id' \
  --api-key-env STUDIO_SCENARIO_API_KEY \
  --profile 'replace-with-profile-label' \
  --trials 3 \
  --output artifacts/pet-head-scenarios/live-report.json
```

This command sends the synthetic scenario conversation to the selected remote
model. Keep credentials in the named environment variable, rather than command
arguments. Live evaluation uses the same case IDs and program assertions. Record
all three trials, including failures, when comparing a model profile or commit.
The live default is three trials, and `--output` defaults to
`artifacts/pet-head-scenarios/live-report.json` relative to the workspace package.
The live entry point is also on demand and always requires `--live`.

The live gateway virtualizes local paths before egress, restricts the tool surface,
and rejects secrets and provider error payloads in both request and response paths.
Runtime logs are suppressed in live mode; only the safe summary and JSON report
are retained. SIGINT or SIGTERM cancels the active trial and records the remaining
requested trials as blocked.

## Local reports

Both modes write JSON with this versioned envelope:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1` |
| `suite` | `pet-head-timeline` |
| `commit` | Git commit under test |
| `mode` | `deterministic` for offline execution, or `live` |
| `modelProfile` | Explicit profile `id` and `model` |
| `startedAt` | Run start timestamp |
| `trialCount` | Number of trials in the run |
| `trials` | Every trial, with its `trial` number and `cases` |
| `trials[].cases[]` | Stable `id`; `status` (`passed`, `failed`, or `blocked`); boolean `checks`; numeric or boolean `observations`; optional safe `failure` code |
| `gateway` | Live-only counters: `requests`, `forwarded`, `blocked`, and `redactions` |
| `configuration` | Live-only counts of replaced personal-config reads and blocked dotenv reads; no file names or contents |
| `cancelled` | Live-only flag for SIGINT/SIGTERM cancellation |

Once a valid run starts, the runner records every case and trial, including
failures, before returning a nonzero exit status for a failed run. Reports contain
assertion outcomes and safe counts or flags. They exclude credentials, endpoint URLs, prompts, model output,
raw errors, trace payloads, and session/checkpoint contents. Generated reports are
ignored by Git. The implementation defines the exact check and observation keys;
this README does not assert a live result.

Reports remain local at the paths selected by the commands above. No workflow
runs these commands or uploads reports. A failure before the scenario runner
starts can leave no report; check the command's exit status and prerequisite
build output.

### Manual persistent-Session philosophy roundtable trial

```sh
npm run scenario:roundtable -w @pinpawo-tests/studio-e2e
```

This deterministic scenario uses three distinct philosopher-named Pet instances,
a synthetic collective-experience question, the production Studio/Channel/resident
runtime, and a loopback scripted model. It never reads real model credentials or
contacts a live model/backend. It is excluded from the default test command and CI,
like the other manually invoked scenario tests.

The synthetic group question explicitly asks “请各位回复”. Two transport cases
exercise the configured decision protocol: a named relevance and idle declarations or tool-free
JSON mode. Each source/Pet pair has a relevance stage (unless canonically mentioned), then at most one idle or factual-composition stage. Eligibility
still comes from scripted model decisions, not a production rule that forces
every Pet to participate.

It verifies one lazy, retained execution Session per `(Channel, Pet instance)`;
seven attributed execution replies across two human-triggered rounds plus one
actual Pet-publication-triggered peer turn, including repeated response dispatches
on the same Session; shared source and quoted-peer
context; eligible unmentioned routing versus explicitly ignored messages; no
substantive Head write;
no duplicate replies under a scripted explicit ignore stop; and foreign
Channel isolation. Controlled model decisions exercise routing semantics, not the
claim that every unmentioned Pet should answer. No optional Head status is emitted
in this trial. The fixture's final answers are distinct from routing instructions.

Known acceptance gap: execution publications currently omit outgoing `replyTo`.
The test explicitly records that gap; incoming quoted context and trigger IDs in
Session history are verified, but output quote correlation is not preserved.

This is integration evidence, not a philosophical-quality or latency benchmark.
It does not establish real-model routing accuracy or autonomous loop safety, interrupted delivery/ACK retry
behavior, or tool/Capability-switch continuity. Those require separate cases and
an explicitly isolated live-model run when desired. No live deployment is implied.

### Manual Head routing evaluation

`npm run eval:head -w @pinpawo-tests/studio-e2e -- --live --profile deepseek-v4-flash --cases combined,no-at-followup --repeats 1 --output /tmp/head-eval-new.json`

This **manual, paid-provider opt-in** is not part of CI or `npm test`. It uses the existing local profile registry and production `createHeadModel()` and `createPetHead` with synthetic state and in-memory reply/admission capture, never constructs a Studio Host or writes a real Channel. Do not run it without authorization for real model calls. No profile or credential overrides are accepted. Output must be a new file; a private file is reserved before any model call, and no existing report is overwritten.

`--cases combined,no-at-followup` selects two stable fixture IDs; `--repeats` defaults to 1. The catalog currently exceeds the 20-case cap, so select a subset explicitly. Selection count multiplied by repeats must be at most 20; selecting the entire catalog is rejected before profile resolution. At most 20 selected source cases and **20 actual fetch calls across all stages**, 30 seconds per case and 240 seconds overall. Exhaustion counts remaining requested cases as failures, not skipped successes. Fixtures cover independent reply/dispatch combinations, grounded no-mention follow-up, matched human/peer mentions, author-neutral independent additions and unsupported edits, progress-only and mixed progress/additions, peer acknowledgements that must not revive an older request, and direct peer questions. The evaluation exercises relevance, verified-idle handling and busy/unknown composition using fixed synthetic state and exact synthetic source/session/request references. Captured effects are not real Session reads, message delivery or admission. Canonical mentions establish relevance without a model call.

The JSON includes source commit, fixture version, model/profile, each case and repeat, sanitized relevance diagnostics and captured effects, elapsed milliseconds, HTTP status, allowlisted finish reasons, token usage when supplied, requested token cap/thinking mode/JSON format. It stores neither provider reasoning nor reply text.

The scorer reports effective relevance (including canonical mentions), exact dispatch disposition (`null` for no request, `idle-only`, `queue`, or `interrupt`), and reply **presence** as separate checks. An expected reply does not excuse a wrong dispatch, and a correct dispatch does not excuse a missing reply. The overall route must match an allowed combination. Unknown state must not dispatch. A Channel instruction to stop and replace active work without independent stop authorization must not queue or interrupt. Captured requests are not proof of real admission, and reply prose is not scored.

Fixture labels and expected outcomes are outside model-visible input; message IDs and references are opaque. Contrast pass/total includes errors; conditional pass/valid is reported separately. Organic acceptance is separate and must not be called accuracy. Provider/transport/setup failures are separate from valid behavioral mismatches. Any invalid or unaccepted result exits nonzero after writing the full report. This is a small diagnostic suite, not proof of general model quality, successful tool execution, message delivery or autonomous loop safety.

Provider-reported `wire[].cacheHitTokens` and `cacheMissTokens` are operational token counters, not case passes/misses. Missing counters remain absent rather than being counted as zero. They do not enter accuracy scores or change the decision denominator; cache performance and routing quality must be reported separately.

`src/head-eval/relevanceCases.ts` prepares three **offline design contrasts** for relevance-first evaluation: “A先不做了，做B” (replacement), “A继续，做完再做B” (ordered/conditional), and “A继续，另外做B” (guidance). All are relevant, but differ on retaining A and requiring B to follow A. Expected relations and case labels stay outside the input. These fixtures are intentionally not passed to the current runtime-effect scorer or live runner, and are not selectable with `--cases`. They do not assert that the existing runtime can replace, interrupt, or conditionally dispatch work. A future evaluator must use an agreed relevance/relationship contract before making accuracy claims from them.
