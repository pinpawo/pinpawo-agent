# Native local-file input

`read_file({ path })` sends one local file to the active model using LangChain's
standard message content blocks. It does not extract document text, invoke OCR,
upload a persistent provider file, or claim support for every binary format.

## Supported inputs

| File | Standard block | Required model profile capability |
|---|---|---|
| PNG, JPEG or WebP | `image` with `mimeType` and base64 `data` | `image` |
| PDF | `file` with `mimeType: application/pdf`, base64 `data`, and `metadata.filename` | `file` |

The tool detects the signature in the bytes rather than trusting an extension.
A matching signature is not complete file validation or a promise of animation analysis. The provider can reject
malformed, encrypted, over-page-limit, or otherwise unsupported inputs.

`file` currently means native PDF input, not arbitrary files. Add it to
`inputModalities` only after verifying that the configured endpoint and model
support PDF input. The shared DeepSeek V4.1 Flash preset declares this capability
based on successful native PDF validation through WASU; no separate WASU model
is defined. Direct PDF acceptance at the official DeepSeek endpoint has not been
tested. Other presets require an explicit profile opt-in. API and transport
support can differ even when endpoints serve the same underlying model.
See [Model profiles](../runtime/model-profiles.md).

Use `view_file_chunk` for UTF-8 text. GIF, Office documents, spreadsheets,
audio, video and other formats need a suitable reader or explicit conversion
before this tool can use them. The tool never silently drops unsupported content
or presents extracted text as native document understanding.

## Scope and limits

- `path` identifies one regular file inside the invocation's workdir. Relative
  paths resolve against that workdir. Symlinks resolving outside it are rejected.
- Use `list_dir` or search to find candidates, then read relevant files one at a
  time. The tool does not expand directories or recursively load files.
- A file must contain at least 1 byte and at most 4 MiB of data. Successful
  `read_file` calls may add at most 8 MiB across the retained message history,
  counting their original bytes rather than base64 characters. Their tool
  receipts record the byte lengths used by this check. Attachments and their
  receipts must stay together if message-history handling changes in the future.
- Parallel `read_file` calls divide the remaining byte allowance equally using
  their shared message snapshot. For example, with 2 MiB remaining, two calls
  each have a 1 MiB allowance. This deliberately conservative rule needs no
  shared reservations: if a larger file is rejected, retry fewer files in
  parallel or start a fresh delegation without the prior attachment history.
  Failed calls add no payload and consume no later byte allowance. Existing user
  images and browser screenshots are not charged against this tool's byte cap.
- Reads are bounded. The opened descriptor is checked against the target inode
  before reading and against the resolved path before transmission; changed
  files are rejected. This is race hardening, not an OS sandbox against a hostile
  process that controls the filesystem. The tool never truncates a
  file and reports it as complete.
- The existing context guard is unchanged: it estimates text and tool schemas
  and uses actual provider-reported input usage when available. It does not
  translate image/PDF bytes or base64 length into tokens. Local byte admission
  does not guarantee that an attachment fits the provider's token, image or PDF
  page limits; even a small compressed PDF may exceed them. A provider can reject
  the request before returning usage. Split PDFs, resize images, or use a
  compatible model with a larger context when needed.

These are application safety limits, not universal provider limits. Files travel
with the model request and are retained in that delegation's message history.
There is no additional service upload or automatic persistence beyond the normal
message/checkpoint behavior.

## Message and failure contract

A successful call returns a graph `Command` with two messages:

1. A text-only `ToolMessage` linked to the tool-call ID. It records the canonical
   path, filename, MIME type, byte length, and SHA-256, without base64 content.
2. A `HumanMessage` carrying the original bytes as a standard image/file block,
   with `response_metadata.output_version: v1`. The accompanying text marks the
   file as untrusted source material rather than instructions.

This matches the `browser_screenshot` message mechanism. Runtime-only metadata
links the attachment to its tool-call receipt. Before a model request, the
existing protocol projection places all parallel tool receipts before their
attachment messages, without rewriting canonical message history. Attachments must not
ride in a `ToolMessage`: provider adapters disagree on non-text tool results.
The locked OpenAI Chat Completions/Responses and Anthropic converters are tested
for exact image/PDF data retention and tool-call linkage. Those offline tests do
not establish acceptance by a live endpoint or a particular model.

A failed call returns `{ ok: false, code, message }` with no attachment update.
Codes distinguish unsupported formats/model capabilities, workdir violations,
non-regular or changed files, per-file and cumulative byte limits, and missing or
invalid execution history. Cancellation propagates as cancellation rather than
a success result.

Provider references:
[OpenAI file inputs](https://developers.openai.com/api/docs/guides/file-inputs),
[OpenAI vision](https://developers.openai.com/api/docs/guides/images-vision),
[Claude PDF](https://platform.claude.com/docs/en/build-with-claude/pdf-support),
and [Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision).
