# 持久化契约（Store Contract）

> **状态：历史实现。** 本页记录已退役的旧 store 契约，基线为
> [`b4f0430c`](https://github.com/pinpawo/pinpawo-agent/blob/b4f0430c7b79219e31980397ed7c0e2917b1592a/docs/reference/artifacts/store-contract.md)。
> 当前实施边界见[退役说明](../../../reference/extensions/capability-toolkit.md#7-旧-artifact-pipeline-退役)。

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

`runId` 是运行轨道标识，也是公共写入和 ref 的字段。本地 store 读回旧
manifest/ref 时仍兼容 `turnId`，但公共接口没有这个查询字段。

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
capability-artifact://thread/{encoded-thread-id}/delegation/{encoded-delegation-id}/artifact/{encoded-id}
```

各 URI/path segment 使用 `encodeURIComponent` 并额外把 `.` 转义为 `%2E`。
`state.sessionCapabilityArtifacts` 和委派执行记录保存 ref，payload 留在 store；
ref 的 URI 不包含本地绝对路径。

## 本地实现（FileCapabilityArtifactStore）要点

- Host 根目录：`<sessionRoot>/capability-artifacts/`，默认是
  `~/.pinpawo/workspaces/<derived-workspace-id>/capability-artifacts/`。
  `PINPAWO_WORKSPACES_DIR` 可替换 workspaces 基目录，workspace id 由规范化的
  workdir 派生；它不是项目内的 `.pinpawo` 目录。见 [Workdir Configuration](../../../reference/runtime/workdir.md)。
- 组织结构：`threads/<encoded-thread-id>/<encoded-delegation-id>/manifest.json + artifact files`
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
