# Outcome bench

Gives the agent a task in a scratch directory and lets the task's own verifier
decide pass or fail. This is the end-to-end counterpart to the decision evals in
`src/`: it only looks at the result, through the same `pinpawo exec` entry a
public benchmark harness uses.

## Run the local tasks

Uses the model profile in `~/.pinpawo/config.json`.

```sh
npm run bench -w @pinpawo-tests/agent-evals                         # all tasks, once
npm run bench -w @pinpawo-tests/agent-evals -- --task git-release --attempts 3
npm run bench -w @pinpawo-tests/agent-evals -- --approval auto      # with auto-review instead of full access
npm run bench -w @pinpawo-tests/agent-evals -- --agent oracle       # reference solutions; must be 100%
```

Results go to `tests/agent-evals/.eval-results/bench/<time>-<agent>/`:
`summary.md`, `summary.json`, and per run `exec.json` (status, reply, tool calls,
token usage), `trajectory.jsonl` (every Host message), `agent.log` and
`verifier.log`. The scratch directory of each run is kept and listed in the
result so a failure can be inspected.

`pinpawo exec` reports one of `completed`, `waiting` (stopped on a review or a
question nobody answered), `interrupted`, `timeout` or `failed` (the agent could
not run). Only the verifier decides whether the task passed.

## Task layout

Tasks follow the Harbor / Terminal-Bench layout, so writing one here is
practice for the real benchmarks:

```
tasks/<id>/
  instruction.md        what the agent is told
  task.toml             [agent] / [verifier] timeout_sec
  environment/setup.sh  prepares the scratch directory (stands in for the Dockerfile)
  tests/test.sh         verifier; exit 0 means solved
  solution/solve.sh     reference solution, used by --agent oracle
```

Scripts run with the scratch directory as cwd and `TASK_DIR` pointing at the
task. Runs are sequential because tasks may bind fixed ports. `npm test` checks
that every task passes under `oracle` and fails under `nop`, so a new task
needs both a working solution and a verifier that rejects the untouched state.

## Run public benchmarks through Harbor

`../harbor/pinpawo_agent.py` is a Harbor installed agent. It installs Node 24
and this checkout's packages into each task container and runs `pinpawo exec`
there. Harbor needs Docker (or a cloud sandbox such as Daytona or Modal).

```sh
uv tool install harbor
tests/agent-evals/harbor/pack.sh            # build and pack this checkout
cd tests/agent-evals/harbor
PYTHONPATH=. harbor run -d terminal-bench/terminal-bench-2 -a pinpawo_agent:PinpawoAgent \
  --ak config=$HOME/.pinpawo/config.json -n 4 -l 20   # first 20 tasks, 4 at a time
harbor view jobs
```

`--ak config=` is required: the config's model profile, API key included, is
copied into the container. Add `--ak approval=auto` to run under auto-review,
and `--ae LANGFUSE_...=...` to trace runs. Compare against a reference agent on
the same model with, for example, `-a terminus-2 -m <provider/model>`.
