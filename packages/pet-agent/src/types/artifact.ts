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
  turnId: string;
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

export type CapabilityArtifactWritePayload = {
  kind: CapabilityArtifactKind;
  mimeType: string;
  title?: string;
  preview?: string;
  schema?: CapabilityArtifactSchemaRef;
  metadata?: Record<string, unknown>;
  content?: unknown;
  externalUri?: string;
};

export type CapabilityArtifactWriteInput = {
  threadId: string;
  capabilityId: string;
  delegationId: string;
  turnId: string;
  artifact: CapabilityArtifactWritePayload;
};

export type CapabilityArtifactStore = {
  writeArtifact: (input: CapabilityArtifactWriteInput) => Promise<CapabilityArtifactRef>;
  writeArtifacts?: (inputs: CapabilityArtifactWriteInput[]) => Promise<CapabilityArtifactRef[]>;
  readArtifact?: (params: {
    uri: string;
    maxBytes?: number;
    threadId?: string;
  }) => { ref: CapabilityArtifactRef; content: string | null };
  deleteThreadArtifacts?: (threadId: string) => Promise<void>;
};
