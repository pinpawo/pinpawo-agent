"""Harbor adapter: runs `pinpawo exec` inside each task container.

Usage (from tests/agent-evals/harbor, after ./pack.sh):

    PYTHONPATH=. harbor run -d terminal-bench/terminal-bench-2 \
      -a pinpawo_agent:PinpawoAgent \
      --ak config=$HOME/.pinpawo/config.json

The adapter installs Node 24 and the tarballs that pack.sh built from this
checkout, writes the given pinpawo config (it holds the model profile and its
API key) to ~/.pinpawo/config.json in the container, and runs the task
instruction once. exec.json, trajectory.jsonl and the console log land in the
trial's agent log directory.
"""

import asyncio
import json
import shlex
from pathlib import Path
from typing import override

from pydantic import Field

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

_REMOTE_PACKAGES_DIR = "/installed-agent/pinpawo"
_LOAD_NODE = 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; '
# `pinpawo exec` exit code 1 means the agent could not run at all (no model,
# Host crash). Every other status (waiting on a review, timeout) is a real
# outcome for the verifier to judge, so it must not fail the trial.
_EXEC_FAILED = 1
# Process group of the running `pinpawo exec` and its Host. Harbor cancels an
# agent by stopping its local `docker exec` client, which leaves the processes
# inside the container running; the group id lets the adapter stop exactly
# them. The RS service runs detached in its own group, so background processes
# the agent started for the task (a VM, a server) are left alone.
_PGID_FILE = "/tmp/pinpawo-exec.pgid"
# Graceful signal first, then SIGKILL; the run is already past its deadline.
_STOP_RUN = f"""
f={_PGID_FILE}; [ -s "$f" ] || exit 0; g=$(cat "$f")
kill -TERM -- "-$g" 2>/dev/null || exit 0
for _ in $(seq 50); do kill -0 -- "-$g" 2>/dev/null || exit 0; sleep 0.1; done
kill -KILL -- "-$g" 2>/dev/null
for _ in $(seq 20); do kill -0 -- "-$g" 2>/dev/null || exit 0; sleep 0.1; done
echo "pinpawo exec group $g is still running" >&2; exit 1
"""


class PinpawoOptions(InstalledAgentOptions):
    packages_dir: str | None = Field(
        default=None,
        description="Directory of tarballs built by pack.sh. Defaults to ./dist next to this file.",
    )
    approval: str = Field(
        default="auto",
        description="Tool authorization for the run: auto (default), full-access, or require.",
    )


class PinpawoAgent(BaseInstalledAgent):
    capabilities = AgentCapabilities(native_config=True)
    options_model = PinpawoOptions

    @staticmethod
    @override
    def name() -> str:
        return "pinpawo"

    @override
    def get_version_command(self) -> str | None:
        return _LOAD_NODE + "pinpawo --version"

    def _packages(self) -> list[Path]:
        configured = self.options.packages_dir if self.options else None
        packages_dir = Path(configured) if configured else Path(__file__).parent / "dist"
        tarballs = sorted(packages_dir.glob("*.tgz"))
        if not tarballs:
            raise RuntimeError(f"No pinpawo tarballs in {packages_dir}; run pack.sh first.")
        return tarballs

    def _config_text(self) -> str:
        source = self.config_source
        if source is None:
            raise RuntimeError(
                "pinpawo needs its config for the model profile: pass --ak config=<path to config.json>."
            )
        config = source if isinstance(source, dict) else json.loads(Path(source).read_text())
        if not isinstance(config, dict) or "models" not in config:
            raise RuntimeError('pinpawo config must be a JSON object with a "models" section.')
        return json.dumps(config, indent=2)

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        packages = self._packages()
        config_text = self._config_text()
        await self.ensure_system_dependencies(environment, ("curl",))
        await self.exec_as_agent(environment, nvm_node_install_snippet(node_major=24))

        await self.exec_as_root(
            environment,
            f"mkdir -p {_REMOTE_PACKAGES_DIR} && chmod 755 {_REMOTE_PACKAGES_DIR}",
        )
        for package in packages:
            await environment.upload_file(package, f"{_REMOTE_PACKAGES_DIR}/{package.name}")
        await self.exec_as_root(environment, f"chmod 644 {_REMOTE_PACKAGES_DIR}/*.tgz")
        await self.exec_as_agent(
            environment,
            _LOAD_NODE
            + f"npm install -g --no-audit --no-fund {_REMOTE_PACKAGES_DIR}/*.tgz && pinpawo --version",
        )

        home = (
            await self.exec_as_agent(environment, 'mkdir -p "$HOME/.pinpawo" && printf %s "$HOME"')
        ).stdout.strip()
        await self._upload_config_text(
            environment,
            content=config_text,
            remote_path=f"{home}/.pinpawo/config.json",
            filename="config.json",
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        approval = self.options.approval if self.options else "auto"
        # No --workdir: the Host works in the container's working directory,
        # which is where the task expects changes.
        run = (
            f"pinpawo exec {shlex.quote(instruction)} --approval {shlex.quote(approval)} "
            + "--trajectory /logs/agent/trajectory.jsonl --output /logs/agent/exec.json "
            + "2>&1 | tee /logs/agent/pinpawo.txt; "
            + "exit ${PIPESTATUS[0]}"
        )
        # `set -m` starts the subshell as the leader of its own process group,
        # so its pid is the group id `_STOP_RUN` signals.
        command = (
            _LOAD_NODE
            + "set +e; set -m; "
            + f"( {run} ) & echo $! > {_PGID_FILE}; wait $!; code=$?; "
            + f'[ "$code" = {_EXEC_FAILED} ] && exit 1; exit 0'
        )
        try:
            await self.exec_as_agent(environment, command)
        except asyncio.CancelledError:
            # Harbor's agent timeout. Stop the run before the verifier starts,
            # so nothing the agent does after the deadline reaches the score.
            await self._stop_run(environment)
            raise

    async def _stop_run(self, environment: BaseEnvironment) -> None:
        try:
            await self.exec_as_agent(environment, _STOP_RUN, timeout_sec=30)
        except Exception as error:
            self.logger.warning(f"Could not confirm pinpawo exec stopped: {error}")

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        # Harbor calls this from the finally block of its agent phase, also
        # after an agent timeout, and an exception here stops the verifier
        # from running. `pinpawo exec` truncates exec.json when it starts and
        # writes it only when the run ends, so a cancelled run leaves the file
        # empty. Any unreadable result is recorded as a diagnostic instead.
        result, exec_json = _read_exec_result(self.logs_dir / "exec.json")
        if result is None:
            context.metadata = {**(context.metadata or {}), "pinpawo_exec_json": exec_json}
            return
        usage = result.get("usage")
        usage = usage if isinstance(usage, dict) else {}
        if isinstance(usage.get("inputTokens"), int):
            context.n_input_tokens = usage["inputTokens"]
        if isinstance(usage.get("outputTokens"), int):
            context.n_output_tokens = usage["outputTokens"]
        context.metadata = {
            **(context.metadata or {}),
            "pinpawo_exec_json": exec_json,
            "pinpawo_status": result.get("status"),
            "pinpawo_main_tool_calls": result.get("mainToolCalls"),
            "pinpawo_executed_tool_calls": result.get("executedToolCalls"),
            "pinpawo_executed_tool_calls_by_name": result.get("executedToolCallsByName"),
            "pinpawo_pending_interrupt": result.get("pendingInterruptKind"),
            "pinpawo_error": result.get("error"),
        }


def _read_exec_result(path: Path) -> tuple[dict | None, str]:
    """Returns exec.json's object (or None) and \"ok\" or why it could not be used."""
    try:
        text = path.read_text()
    except FileNotFoundError:
        return None, "missing"
    except OSError as error:
        return None, f"unreadable: {error}"
    if not text.strip():
        return None, "empty"
    try:
        result = json.loads(text)
    except ValueError as error:
        return None, f"invalid JSON: {error}"
    if not isinstance(result, dict):
        return None, f"not a JSON object: {type(result).__name__}"
    return result, "ok"
