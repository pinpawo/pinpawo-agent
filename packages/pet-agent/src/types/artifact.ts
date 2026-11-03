/** Historical execution-reference shape retained while old records remain readable. */
export type CapabilityArtifactKind =
  | 'result'
  | 'report'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'file'
  | 'bundle';

export type CapabilityArtifactSchemaRef = {
  name: string;
  version: number;
};

export type CapabilityArtifactRef = {
  id: string;
  threadId: string;
  capabilityId: string;
  delegationId: string;
  runId: string;
  kind: CapabilityArtifactKind;
  mimeType: string;
  uri: string;
  title?: string;
  preview?: string;
  sizeBytes: number;
  sha256?: string;
  externalUri?: string;
  createdAt: string;
  schema?: CapabilityArtifactSchemaRef;
  metadata?: Record<string, unknown>;
};
