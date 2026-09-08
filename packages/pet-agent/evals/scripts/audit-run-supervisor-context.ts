import { createSupervisorCapabilityDetailsTool } from '../../src/agent/orchestrator/runSupervisor/detailsTool.ts';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import type { StructuredTool } from '@langchain/core/tools';
import { createCapabilityDisclosureState } from '../../src/agent/orchestrator/runSupervisor/capabilityDisclosure.ts';
import type { CapabilityCatalog } from '../../src/agent/orchestrator/runSupervisor/capabilityCatalog.ts';
import {
  createSupervisorDocumentReader,
  type RunSupervisorCapabilityDocument,
} from '../../src/agent/orchestrator/runSupervisor/capabilityDocuments.ts';
import type {
  RunSupervisorInput,
  RunSupervisorMode,
} from '../../src/agent/orchestrator/runSupervisor/runner.ts';
import {
  createCapabilityRoutingManifest,
} from '../../src/agent/orchestrator/runSupervisor/routingManifest.ts';
import { createRunSupervisorSession } from '../../src/agent/orchestrator/runSupervisor/session.ts';
import { createSupervisorCommandTools } from '../../src/agent/orchestrator/runSupervisor/commandTools.ts';
import {
  DelegationAnnounceMessage,
} from '../../src/agent/orchestrator/delegation/index.ts';
import {
  queryAgentMessages,
  setAgentMessageMetadata,
} from '../../src/agent/messages/index.ts';
import { invokeOrchestratorModel } from '../../src/agent/orchestrator/modelInvocation.ts';
import {
  buildRunSupervisorAgentInput,
  buildRunSupervisorAgentSystemPrompt,
} from '../../src/agent/orchestrator/prompts/runSupervisorAgent.ts';

const userRequest = 'Review the repository issue, implement the required fix, and report the verified result.';

const catalog: CapabilityCatalog = {
  registryDigest: 'audit-registry-digest',
  capabilityNames: ['general', 'repository'],
  entries: [{
    capabilityName: 'general',
    description: 'Handle ordinary tasks.',
    toolkits: [],
    content: '# General\n\nHandle ordinary tasks.',
  }, {
    capabilityName: 'repository',
    description: 'Inspect, edit, and verify repository changes.',
    toolkits: [],
    content: '# Repository\n\nInspect, edit, and verify repository changes.',
  }],
};

const routingManifest = createCapabilityRoutingManifest({ catalog });

const documents: RunSupervisorCapabilityDocument[] = [{
  capabilityName: 'general',
  content: '# General\n\nHandle ordinary tasks.',
}, {
  capabilityName: 'repository',
  content: '# Repository\n\nInspect, edit, and verify repository changes.',
}];

const disclosure = createCapabilityDisclosureState({
  catalog,

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
  result: 'Inspection completed and identified the affected module.',
  createdAt: '2026-01-01T00:00:00.000Z',
});
const privateLaneMessage = new AIMessage({
  id: 'audit-private-lane-message',
  content: 'Private executor reasoning that must not enter Supervisor context.',
});
setAgentMessageMetadata(privateLaneMessage, {
  lane: 'capability:repository',
  runId: 'audit-active-run',
  delegationId: 'audit-active-delegation',
});

function buildInput(mode: RunSupervisorMode): RunSupervisorInput {
  const messages: BaseMessage[] = mode === 'entry'
    ? [userMessage, privateLaneMessage]
    : [userMessage, acceptedAnnounce, privateLaneMessage];
  const remainingPlan = mode === 'boundary' ? [{
    capability: 'general',
    task: 'Report the verified result to the user.',
  }] : [];
  const supervisorSession = createRunSupervisorSession({
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

      remainingPlan,
      catalog,
      capabilityDisclosure: disclosure,
      supervisorSession,
    };
  }
  return {
    mode,
    inputId: 'audit-boundary',
    traceId: 'audit-trace',
    runId: 'audit-run',
    userRequest,
    messages: [...messages, ...[{
      messageId: 'audit-active-result-1',
      result: 'Implementation started, but verification has not run yet.',
    }, {
      messageId: 'audit-active-result-2',
      result: 'The change is implemented and focused tests pass.',
    }].map((attempt) => new DelegationAnnounceMessage({
      id: 'announce:' + attempt.messageId, sourceLane: 'capability:repository' as const, delegationId: 'audit-active-delegation', runId: 'audit-active-run', task: 'Implement and verify the identified change.', announceMessageId: attempt.messageId, result: attempt.result, createdAt: '2026-09-05T00:00:00Z'
    }))],
    activeDelegation: {
      delegationId: 'audit-active-delegation',
      runId: 'audit-active-run',
      capability: 'repository',
      task: 'Implement and verify the identified change.',
    },

    remainingPlan,
    catalog,
    capabilityDisclosure: disclosure,
    supervisorSession,
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

async function captureProviderHistory(messages: readonly BaseMessage[]) {
  let invocation: BaseMessage[] = [];
  await invokeOrchestratorModel({
    async invoke(input) {
      invocation = input;
      return new AIMessage('audit capture');
    },
  }, {
    systemMessage: new SystemMessage('audit system marker'),
    messages,
  });
  return invocation.slice(1);
}

async function renderMode(mode: RunSupervisorMode) {
  const input = buildInput(mode);
  const mainSelection = queryAgentMessages(input.messages).main().select();
  const projectedMessages = await captureProviderHistory(mainSelection.messages);
  const detailsTool = createSupervisorCapabilityDetailsTool({ documents: createSupervisorDocumentReader(catalog) });
  const tools = [...(mode === 'entry' ? [detailsTool] : []), ...createSupervisorCommandTools(mode)];
  console.log(`\n## ${mode.toUpperCase()} MODE`);
  console.log(`\nProjection: ${String(input.messages.length)} canonical messages -> ${String(projectedMessages.length)} provider history messages.`);
  console.log('\n### SYSTEM');
  console.log(buildRunSupervisorAgentSystemPrompt(mode));
  console.log('\n### CLEAN PROVIDER HISTORY');
  projectedMessages.forEach((message, index) => {
    console.log(`\n[${String(index + 1)}] ${message._getType()}`);
    console.log(messageText(message));
  });
  console.log('\n### INVOCATION INPUT');
  console.log(buildRunSupervisorAgentInput(input, documents, routingManifest));
  console.log('\n### PROVIDER TOOLS');
  tools.forEach((tool) => {
    console.log(`\n${renderTool(tool)}`);
  });
}

console.log(`# Run Supervisor Context Audit

This is a static rendering of the production prompt builders, message projection,
tool descriptions, and argument schemas. No external model is called.

Audit in this order:
1. Goal: the system message names one clear decision objective for this mode.
2. Evidence: history and input distinguish accepted facts, current evidence, and prior proposals.
3. Actions: only actions valid for this mode are exposed, and their effects are mutually exclusive.
4. Arguments: schemas describe data to serialize, without adding competing decision policy.
5. Scope: private executor-lane messages are absent; accepted main-history conclusions remain visible.
6. Runtime: code validates identities and shapes only; semantic completion remains the Supervisor's decision.`);

await renderMode('entry');
await renderMode('boundary');
