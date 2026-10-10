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


class PinpawoOptions(InstalledAgentOptions):
    packages_dir: str | None = Field(
        default=None,
        description="Directory of tarballs built by pack.sh. Defaults to ./dist next to this file.",
    )
    approval: str = Field(
        default="full-access",
        description="Tool authorization for the run: full-access, auto, or require.",
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
        approval = self.options.approval if self.options else "full-access"
        # No --workdir: the Host works in the container's working directory,
        # which is where the task expects changes.
        command = (
            _LOAD_NODE
            + "set +e; "
            + f"pinpawo exec {shlex.quote(instruction)} --approval {shlex.quote(approval)} "
            + "--trajectory /logs/agent/trajectory.jsonl --output /logs/agent/exec.json "
            + "2>&1 | tee /logs/agent/pinpawo.txt; "
            + "code=${PIPESTATUS[0]}; "
            + f'[ "$code" = {_EXEC_FAILED} ] && exit 1; exit 0'
        )
        await self.exec_as_agent(environment, command)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        result_path = self.logs_dir / "exec.json"
        if not result_path.is_file():
            return
        result = json.loads(result_path.read_text())
        usage = result.get("usage") or {}
        if isinstance(usage.get("inputTokens"), int):
            context.n_input_tokens = usage["inputTokens"]
        if isinstance(usage.get("outputTokens"), int):
            context.n_output_tokens = usage["outputTokens"]
        context.metadata = {
            **(context.metadata or {}),
            "pinpawo_status": result.get("status"),
            "pinpawo_main_tool_calls": result.get("mainToolCalls"),
            "pinpawo_executed_tool_calls": result.get("executedToolCalls"),
            "pinpawo_executed_tool_calls_by_name": result.get("executedToolCallsByName"),
            "pinpawo_pending_interrupt": result.get("pendingInterruptKind"),
            "pinpawo_error": result.get("error"),
        }
