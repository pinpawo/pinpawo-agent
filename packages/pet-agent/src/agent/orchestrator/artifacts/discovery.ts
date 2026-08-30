export const ARTIFACT_DISCOVERY_TOOLKIT_NAME = 'artifact_discovery';
export const ARTIFACT_DISCOVERY_LIST_TOOL_NAME = 'artifact_list';
export const ARTIFACT_DISCOVERY_READ_TOOL_NAME = 'artifact_read';
export const ARTIFACT_DISCOVERY_TOOL_NAMES = [
  ARTIFACT_DISCOVERY_LIST_TOOL_NAME,
  ARTIFACT_DISCOVERY_READ_TOOL_NAME,
] as const;

export function hasArtifactDiscoveryToolkit(
  toolkits: ReadonlyArray<{ name: string }>,
): boolean {
  return toolkits.some(({ name }) => name === ARTIFACT_DISCOVERY_TOOLKIT_NAME);
}
