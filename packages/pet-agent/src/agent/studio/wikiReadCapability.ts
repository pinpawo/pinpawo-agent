import {
  defineCapability,
  defineInstructionDocument,
  type AgentCapability,
} from '../../types/capability';

export const WIKI_READ_CAPABILITY_NAME = 'wiki';

export function createWikiReadCapability(): AgentCapability {
  return defineCapability({
    name: WIKI_READ_CAPABILITY_NAME,
    description: 'Read and investigate the shared Studio knowledge base.',
    uses: ['wiki_read'],
    instructions: defineInstructionDocument({
      content: `
# Wiki

Use the read-only Wiki Toolkit to find context relevant to the delegated task.

- Start from the index when the relevant location is unknown.
- Read only the files needed to answer the delegated task.
- Report the useful findings and their relative wiki paths.
`,
    }),
  });
}
