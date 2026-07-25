# 持久化契约（Store Contract）

## Ref 与类型

```ts
type CapabilityArtifactRef = {
  id: string;
  threadId: string;
  capabilityId: string;
  delegationId: string;
  runId: string;
  kind: 'result' | 'report' | 'image' | 'video' | 'audio' | 'pdf' | 'file' | 'bundle';
  mimeType: string;
  uri: string;         // capability-artifact://...
  title?: string;
  preview?: string;     // 仅短摘要（prompt 注入）
  sizeBytes: number;
  sha256?: string;
  externalUri?: string;
  createdAt: string;
  schema?: { name: string; version: number };
  metadata?: Record<string, unknown>;
};

type CapabilityArtifactWriteInput = {
  threadId: string;
  capabilityId: string;
  delegationId: string;
  runId: string;
  artifact: {
    kind: CapabilityArtifactRef['kind'];
    mimeType: string;
    title?: string;
    preview?: string;
    schema?: { name: string; version: number };
    metadata?: Record<string, unknown>;
    content?: unknown;          // 与 externalUri 二选一
    externalUri?: string;       // 与 content 二选一
  };
};
```

`runId` 是运行轨道标识，`turnId` 仅保留在能力选择器兼容层。

## Store 接口

```ts
type CapabilityArtifactStore = {
  writeArtifact(input: CapabilityArtifactWriteInput): Promise<CapabilityArtifactRef>;
  readArtifact(params: { uri: string; maxBytes?: number; threadId?: string })
    : Promise<{ ref: CapabilityArtifactRef; content: string | null }>;
  listArtifacts(params: { threadId: string; capabilityId?: string; kind?: string; limit?: number })
    : Promise<CapabilityArtifactRef[]>;
  deleteThreadArtifacts(threadId: string): Promise<void>;
  getDownloadUri(uri: string): Promise<string>;
  writeArtifacts?(inputs: CapabilityArtifactWriteInput[]): Promise<CapabilityArtifactRef[]>;
};
```

## URI

当前本地 store 产出：

```text
capability-artifact://thread/{encodedThreadId}/delegation/{encodedDelegationId}/artifact/{encodeURIComponent(id)}
```

`state` 和 prompt 内只保存 `uri`，不保存绝对路径。

## 本地实现（FileCapabilityArtifactStore）要点

- 根目录：`{workdir}/.pinpawo/capability-artifacts/`
- 组织结构：`threads/{encodedThreadId}/{encodedDelegationId}/manifest.json + artifact files`
- segment 使用 percent encoding，并显式编码 `.`，避免 `.` / `..` 被路径
  resolver 当成目录语义；所有最终路径还必须通过 storage root containment
  校验。
- `writeArtifacts` 会做分组加锁，保证同 delegation 的并发安全。
- 同一输入条件下（能力、delegation、`content/externalUri`）是幂等写入。
- `getDownloadUri`
  - 本地内容返回 `file://`。
  - 外链内容返回原始 `externalUri`。

## 过滤与查询

- 强制 `threadId`。
- 可选按 `capabilityId`、`kind`。
- `preview` 不能承载完整内容。
- 全文检索不在 store 层实现，当前是顺序返回 + 本地筛选。
