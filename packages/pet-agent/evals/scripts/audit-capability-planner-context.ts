import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import type { StructuredTool } from '@langchain/core/tools';
import { createCapabilityDisclosureState } from '../../src/agent/orchestrator/capabilityPlanner/capabilityDisclosure.ts';
import type { CapabilityDocumentWorkspace } from '../../src/agent/orchestrator/capabilityPlanner/documentWorkspace.ts';
import {
  createCapabilityPlannerSearchTool,
  type CapabilityPlannerCapabilityDocument,
} from '../../src/agent/orchestrator/capabilityPlanner/fileExplorer.ts';
import type {
  CapabilityPlannerInput,
  CapabilityPlannerMode,
} from '../../src/agent/orchestrator/capabilityPlanner/runner.ts';
import {
  createCapabilityRegistryManifest,
  createDeterministicCapabilityRoutingManifest,
} from '../../src/agent/orchestrator/capabilityPlanner/routingManifest.ts';
import { createPlannerSession } from '../../src/agent/orchestrator/capabilityPlanner/session.ts';
import { createPlannerTerminalTools } from '../../src/agent/orchestrator/capabilityPlanner/terminalTools.ts';
import { DelegationAnnounceMessage } from '../../src/agent/orchestrator/delegation/index.ts';
import { prepareModelRequestMessages } from '../../src/agent/orchestrator/modelRequestMessages.ts';
import {
  queryAgentMessages,
  setAgentMessageMetadata,
} from '../../src/agent/messages/index.ts';
import {
  buildCapabilityPlannerAgentInput,
  buildCapabilityPlannerAgentSystemPrompt,
} from '../../src/agent/orchestrator/prompts/capabilityPlannerAgent.ts';

const userRequest = 'Review the repository issue, implement the required fix, and report the verified result.';

const workspace: CapabilityDocumentWorkspace = {
  rootPath: '/audit/capabilities',
  registryDigest: 'audit-registry-digest',
  capabilityNames: ['general', 'repository'],
  entries: [{
    capabilityName: 'general',
    description: 'Handle ordinary tasks.',
    relativePath: 'general/CAPABILITY.md',
    documentDigest: 'general-document-digest',
    provenance: 'authored',
  }, {
    capabilityName: 'repository',
    description: 'Inspect, edit, and verify repository changes.',
    relativePath: 'repository/CAPABILITY.md',
    documentDigest: 'repository-document-digest',
    provenance: 'authored',
  }],
  reused: true,
};

const routingManifest = createDeterministicCapabilityRoutingManifest(
  createCapabilityRegistryManifest({ workspace }),
);

const documents: CapabilityPlannerCapabilityDocument[] = [{
  capabilityName: 'general',
  path: '/audit/capabilities/general/CAPABILITY.md',
  content: '# General\n\nHandle ordinary tasks.',
}, {
  capabilityName: 'repository',
  path: '/audit/capabilities/repository/CAPABILITY.md',
  content: '# Repository\n\nInspect, edit, and verify repository changes.',
}];

const disclosure = createCapabilityDisclosureState({
  workspace,
  maxEmptySearchRounds: 2,
  seedCapabilityNames: ['repository'],
});

const userMessage = new HumanMessage({ id: 'audit-user', content: userRequest });
const acceptedAnnounce = new DelegationAnnounceMessage({
  id: 'audit-accepted-announce',
  sourceLane: 'capability:repository',
  delegationId: 'audit-prior-delegation',
  runId: 'audit-prior-run',
  announceMessageId: 'audit-prior-result',
  task: 'Inspect the issue and identify the required change.',
  completionReason: 'natural',
  result: 'Inspection completed and identified the affected module.',
  createdAt: '2026-01-01T00:00:00.000Z',
});
const privateLaneMessage = new AIMessage({
  id: 'audit-private-lane-message',
  content: 'Private executor reasoning that must not enter Planner context.',
});
setAgentMessageMetadata(privateLaneMessage, {
  lane: 'capability:repository',
  runId: 'audit-active-run',
  delegationId: 'audit-active-delegation',
});

function buildInput(mode: CapabilityPlannerMode): CapabilityPlannerInput {
  const messages: BaseMessage[] = mode === 'entry'
    ? [userMessage, privateLaneMessage]
    : [userMessage, acceptedAnnounce, privateLaneMessage];
  const remainingPlan = mode === 'boundary' ? [{
    capability: 'general',
    task: 'Report the verified result to the user.',
  }] : [];
  const plannerSession = createPlannerSession({
    runId: 'audit-run',
    plan: remainingPlan,
    capabilityDisclosure: disclosure,
  });
  if (mode === 'entry') {
    return {
      mode,
      inputId: 'audit-entry',
      traceId: 'audit-trace',
      runId: 'audit-run',
      userRequest,
      messages,
      activeDelegation: null,
      latestAnnounce: null,
      announceAttempts: [],
      remainingPlan,
      workspace,
      capabilityDisclosure: disclosure,
      plannerSession,
    };
  }
  return {
    mode,
    inputId: 'audit-boundary',
    traceId: 'audit-trace',
    runId: 'audit-run',
    userRequest,
    messages,
    activeDelegation: {
      delegationId: 'audit-active-delegation',
      runId: 'audit-active-run',
      capability: 'repository',
      task: 'Implement and verify the identified change.',
    },
    latestAnnounce: {
      messageId: 'audit-active-result-2',
      completionReason: 'natural',
      result: 'The change is implemented and focused tests pass.',
    },
    announceAttempts: [{
      messageId: 'audit-active-result-1',
      completionReason: 'limit_reached',
      result: 'Implementation started, but verification has not run yet.',
    }, {
      messageId: 'audit-active-result-2',
      completionReason: 'natural',
      result: 'The change is implemented and focused tests pass.',
    }],
    remainingPlan,
    workspace,
    capabilityDisclosure: disclosure,
    plannerSession,
  };
}

function messageText(message: BaseMessage) {
  return typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content, null, 2);
}

function renderTool(tool: StructuredTool) {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: toJsonSchema(tool.schema),
  }, null, 2);
}

function renderMode(mode: CapabilityPlannerMode) {
  const input = buildInput(mode);
  const mainSelection = queryAgentMessages(input.messages).main().select();
  const projectedMessages = prepareModelRequestMessages(mainSelection.messages);
  const searchTool = createCapabilityPlannerSearchTool(async () => ({
    ok: true,
    data: { entries: [] },
  }));
  const tools = [searchTool, ...createPlannerTerminalTools(mode)];
  console.log(`\n## ${mode.toUpperCase()} MODE`);
  console.log(`\nProjection: ${String(input.messages.length)} canonical messages -> ${String(projectedMessages.length)} provider history messages.`);
  console.log('\n### SYSTEM');
  console.log(buildCapabilityPlannerAgentSystemPrompt(mode));
  console.log('\n### CLEAN PROVIDER HISTORY');
  projectedMessages.forEach((message, index) => {
    console.log(`\n[${String(index + 1)}] ${message._getType()}`);
    console.log(messageText(message));
  });
  console.log('\n### INVOCATION INPUT');
  console.log(buildCapabilityPlannerAgentInput(input, documents, routingManifest));
  console.log('\n### PROVIDER TOOLS');
  tools.forEach((tool) => {
    console.log(`\n${renderTool(tool)}`);
  });
}

console.log(`# Capability Planner Context Audit

This is a static rendering of the production prompt builders, message projection,
tool descriptions, and argument schemas. No model is called.

Audit in this order:
1. Goal: the system message names one clear decision objective for this mode.
2. Evidence: history and input distinguish accepted facts, current evidence, and prior proposals.
3. Actions: only actions valid for this mode are exposed, and their effects are mutually exclusive.
4. Arguments: schemas describe data to serialize, without adding competing decision policy.
5. Scope: private executor-lane messages are absent; accepted main-history conclusions remain visible.
6. Runtime: code validates identities and shapes only; semantic completion remains the Planner's decision.`);

renderMode('entry');
renderMode('boundary');
