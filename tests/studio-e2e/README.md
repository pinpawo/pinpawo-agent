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
