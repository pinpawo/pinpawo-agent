# TUI Textarea Architecture Design

> 状态：Draft v1
> 日期：2026-06-18
> 参考：opencode `packages/tui`，本地参考 commit `10b6672be1dae17267e85bffb1c14992a60c19c8`（`https://github.com/anomalyco/opencode/tree/10b6672be1dae17267e85bffb1c14992a60c19c8`）

## 1. 文档目标

这份文档用于指导 PinPawo local-agent TUI textarea 的系统性重构。目标不是继续逐个修 Delete、Shift+Enter、粘贴等零散 bug，而是先把 input 组织成一个边界清晰、可测试、可演进的子系统。

本文回答这些问题：

1. 当前 TUI input 为什么容易出 bug。
2. opencode 的 TUI input/keymap 结构有哪些值得学习的地方。
3. 在 PinPawo 当前 TypeScript / Ink 技术栈下，textarea 应该怎么分层。
4. 后续开发应该按什么 PR 顺序推进。
5. 哪些测试和验收标准证明结构是对的。

本文不要求立即迁移到 OpenTUI。opencode 主要作为架构参考：它把 textarea 当成一等组件，而不是在应用层散落处理按键、编辑、布局和业务状态。

## 2. 当前问题诊断

当前 input 链路分布在这些位置：

- `services/local-agent/src/tui/TuiApp.tsx`
  - 调用 Ink `useInput`
  - 维护 input buffer ref
  - 根据 ready/busy/approval/resume 状态路由按键
  - 调用 textarea reducer
  - 触发 app 命令，例如 submit、interrupt、approval submit
- `services/local-agent/src/tui/input/keymap.ts`
  - 缓冲分段 terminal control sequence
  - 判断 Return / Shift+Return / control sequence
  - 同时做全局、approval、resume picker、composer action routing
- `services/local-agent/src/tui/input/textareaModel.ts`
  - 维护纯文本和 `cursorOffset`
  - 实现基础编辑命令
  - 同时处理部分 terminal sequence，例如 Shift+Enter、bracketed paste marker
  - 同时承担简单 layout wrapping
- `services/local-agent/src/tui/components/Composer.tsx`
  - 根据 textarea rows 渲染文本和反色 cursor

这些模块都不是“错”的，但边界不够硬。典型问题是 #144：

```txt
Delete key -> raw terminal sequence "\x1b[3~"
  -> keymap 判断为普通 control sequence
  -> resolveTuiKeyAction 返回 none
  -> 没有进入 composer.edit
  -> textareaModel 里的 key.delete 逻辑根本没有机会运行
```

这说明 bug 根因不是“删除算法不存在”，而是 terminal input normalization、mode routing、textarea editing 三层语义混在一起。

### 2.1 结构性症状

- raw terminal input 和 canonical editing command 没有明确分界。
- `resolveTuiKeyAction` 同时处理全局快捷键、modal 导航、textarea 编辑、terminal sequence ignore。
- `textareaModel` 接收 `input + key`，说明它仍暴露在 terminal event 细节下。
- textarea state 只有 `text + cursorOffset`，还没有 selection、undo、grapheme/width-aware cursor 等扩展点。
- layout wrapping 使用 JS string length，不足以长期支持中文宽字符、emoji、组合字符和真实终端宽度。
- `Composer` 渲染直接混合 layout/render/placeholder/focus 逻辑，缺少独立 render model
  与 view model。
- approval free text 和 composer 共用 input，但 focus/mode ownership 没有抽象成明确协议。

### 2.2 操作清单不是设计起点

Delete、Backspace、Shift+Enter、多行粘贴、中文输入法等操作很重要，但它们应该是 conformance tests，不应该是设计起点。

更合理的顺序：

```txt
先定义结构边界
  -> 再定义每层输入/输出类型
  -> 再把操作清单转成测试矩阵
  -> 最后按测试补齐行为
```

### 2.3 结构优先的判断标准

后续 textarea 工作不按“修哪个操作”组织，而按“哪个边界不清楚”组织。每个
input bug 先定位到一层：

- terminal decoder：原始 bytes / escape sequence 是否被完整识别。
- canonical mapper：raw key 是否被归一成稳定语义事件。
- input router：当前 owner / focus 是否把事件交给正确目标。
- textarea engine：文本、cursor、selection、history state 是否正确变化。
- textarea layout/render：offset、visual row/column、display width、cursor rendering
  是否正确。
- host integration：submit、approval、history、busy interrupt 等业务副作用是否只在
  host 层发生。

因此 Delete、Shift+Enter、paste、中文宽字符、emoji、history up/down 都不是独立架构。
它们是验收用例。真正的架构单位是上面的层和层之间的 contract。

## 3. opencode TUI 的可借鉴结构

opencode 参考文件：

- `packages/tui/src/keymap.tsx`
- `packages/tui/src/component/prompt/index.tsx`
- `packages/tui/src/config/keybind.ts`
- `packages/tui/src/routes/session/question.tsx`
- `packages/tui/src/routes/session/permission.tsx`

### 3.1 Textarea 是一等 renderable

opencode 使用 `@opentui/core` 的 `TextareaRenderable`：

```tsx
<textarea
  width="100%"
  minHeight={1}
  maxHeight={maxHeight()}
  onContentChange={() => {
    const value = input.plainText
    setStore("prompt", "input", value)
    auto()?.onInput(value)
  }}
  onCursorChange={() => setCursorVersion((value) => value + 1)}
  onSubmit={() => {
    setTimeout(() => setTimeout(() => submit(), 0), 0)
  }}
  onPaste={async (event: PasteEvent) => {
    const normalizedText = decodePasteBytes(event.bytes)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
    event.preventDefault()
    await pasteInputText(normalizedText)
  }}
/>
```

重点不是 JSX 形式，而是 ownership：

- textarea renderable 拥有文本、cursor、selection、layout、native editing。
- prompt 组件只订阅 `onContentChange` / `onCursorChange` / `onSubmit` / `onPaste`。
- prompt 组件处理业务语义，例如 submit、autocomplete、attachments、history。

### 3.2 Keymap 有 managed textarea layer

opencode 在 `keymap.tsx` 中集中注册 input 命令：

```ts
const inputCommands = [
  "input.move.left",
  "input.move.right",
  "input.line.home",
  "input.line.end",
  "input.backspace",
  "input.delete",
  "input.newline",
  "input.undo",
  "input.redo",
  "input.submit",
] as const
```

然后通过 `registerManagedTextareaLayer` 把这些命令交给当前 focused textarea：

```ts
registerManagedTextareaLayer(keymap, renderer, {
  enabled: () => hasManagedTextareaFocus(renderer),
  bindings: config.keybinds.gather("input", inputCommands),
})
```

这带来一个关键结构：app 不直接解释 Delete、Home、End、word movement。app 只知道“当前 focus 是 textarea，则 input editing commands 由 textarea layer 接管”。

### 3.3 Keymap 是 command registry，不是 if/else 路由

opencode 把操作定义为 command：

- `prompt.submit`
- `prompt.paste`
- `session.interrupt`
- `prompt.history.previous`
- `prompt.history.next`
- `input.delete`
- `input.newline`

不同 UI mode 通过 layer/mode/focus target 控制 command 是否 active，而不是在一个函数里写完整 if/else 树。

对 PinPawo 的启发：我们可以先不引入完整 keymap library，但应该把 `resolveTuiKeyAction` 拆成“canonical event -> command”的 registry/router，而不是继续扩一个大 switch。

### 3.4 Prompt 组件只保留业务状态

opencode Prompt 的 store 主要是：

```ts
{
  prompt: {
    input: "",
    parts: [],
  },
  mode: "normal" | "shell",
  interrupt: 0,
}
```

输入框内部编辑状态不散落到 Prompt store。Prompt 通过 textarea ref 调用：

- `input.setText(...)`
- `input.clear()`
- `input.insertText(...)`
- `input.gotoBufferEnd()`
- `input.cursorOffset = ...`
- `input.plainText`

对 PinPawo 的启发：TUI app state 应保存“输入草稿和业务归属”，但不要把所有编辑细节都推到顶层 `TuiApp`。

### 3.5 边界 case 在边界层处理

opencode 对这些边界给了清晰位置：

- paste：在 `onPaste` 中统一 normalize CRLF/CR，阻止 terminal default paste 后再手动处理。
- IME：`onSubmit` double defer，确保最后一个 composed character flush 到 `plainText`。
- history：只有当 cursor 在视觉顶部/底部时，上下键才切 history；否则先做 textarea 光标移动。
- duplicate submit：`submitting` guard 防止双击 Enter 发送空 prompt。
- modal textareas：question / permission 也直接使用 `<textarea>`，不复制一套编辑模型。

这些都说明 textarea 是独立基础设施，业务组件只在明确 hook 上扩展。

## 4. PinPawo 的设计约束

### 4.1 不立即重写 TUI 框架

当前 TUI 使用 Ink / React。直接迁移到 OpenTUI 意味着：

- UI runtime 从 Ink/React 迁到 OpenTUI/Solid。
- 组件、布局、测试工具都要换。
- 现有 `TuiApp`、state reducer、local-agent event 消费会被大范围影响。

因此建议短中期保留 Ink，把 opencode 的结构思想移植过来。

### 4.2 LocalAgentEvent 协议不应受 textarea 重构影响

textarea 是 terminal client 内部交互层，不应改变：

- `LocalAgentEvent`
- local-agent WebSocket message
- chat/studio run model
- human review protocol

### 4.3 TUI 当前至少有四类 input owner

```ts
type TuiInputOwner =
  | { type: 'composer' }
  | { type: 'approval'; freeText: boolean }
  | { type: 'resumePicker' }
  | { type: 'busy' };
```

未来还可能有：

- autocomplete
- command palette
- slash command picker
- file picker
- model picker
- multiline approval response

设计必须先支持 owner/focus 概念，否则会继续把所有状态塞进 `resolveTuiKeyAction`。

### 4.4 Textarea 要能被复用

目标不是只做 chat composer。应支持：

- 主 composer
- approval free-text reply
- future dialog prompt
- future command palette search

这要求 textarea engine 与 app command 分离。

## 5. 目标架构

目标数据流：

```txt
Ink useInput
  -> TerminalInputDecoder
  -> CanonicalInputEvent
  -> InputCommandRouter(owner/focus/mode)
  -> TextareaEngine or AppCommand
  -> TuiState reducer
  -> TextareaLayout
  -> TextareaRenderModel
  -> TextAreaViewModel
  -> TextAreaView / Composer render
```

### 5.1 TerminalInputDecoder

职责：

- 接收 Ink 的 `(input, key)`。
- 维护分段 control sequence buffer。
- 识别 bracketed paste 边界。
- 输出稳定的 terminal-level event。
- 不知道 busy、approval、resume、composer。

建议文件：

```txt
services/local-agent/src/tui/input/terminalInput.ts
```

建议类型：

```ts
export type InkInputEvent = {
  input: string;
  key: TuiKeyInput;
};

export type TerminalInputDecoderState = {
  pendingControlSequence: string;
  paste?: {
    chunks: string[];
  };
};

export type TerminalInputEvent =
  | { type: 'key'; input: string; key: TuiKeyInput }
  | { type: 'paste'; text: string }
  | { type: 'pending' };
```

约束：

- 这一层只做 terminal 事实解析，不决定 submit / edit / interrupt。
- 这一层要覆盖 `\x1b[3~`、`\x1b[H`、`\x1b[F`、bracketed paste、split sequence。

### 5.2 CanonicalInputEvent

职责：

- 把 terminal 差异收敛成语义事件。
- 上层不再直接面对 raw escape sequence。

建议文件：

```txt
services/local-agent/src/tui/input/canonicalInput.ts
```

建议类型：

```ts
export type CanonicalInputEvent =
  | { type: 'text.insert'; text: string }
  | { type: 'text.paste'; text: string }
  | { type: 'text.delete.backward' }
  | { type: 'text.delete.forward' }
  | { type: 'text.delete.word.backward' }
  | { type: 'text.delete.to.line.start' }
  | { type: 'text.delete.to.line.end' }
  | { type: 'cursor.left' }
  | { type: 'cursor.right' }
  | { type: 'cursor.up' }
  | { type: 'cursor.down' }
  | { type: 'cursor.line.start' }
  | { type: 'cursor.line.end' }
  | { type: 'submit' }
  | { type: 'newline' }
  | { type: 'escape' }
  | { type: 'tab'; shift?: boolean }
  | { type: 'interrupt' }
  | { type: 'unknown.control'; raw: string };
```

例子：

```txt
"\x1b[3~"      -> text.delete.forward
key.delete     -> text.delete.forward
ctrl+w         -> text.delete.word.backward
shift+return   -> newline
"\r"           -> submit
```

约束：

- `textareaModel` 以后不再接收 raw `input + key`。
- `resolveTuiKeyAction` 不再判断 raw control sequence。

### 5.3 InputCommandRouter

职责：

- 根据当前 input owner / focus / run state，把 canonical event 映射为 command。
- 不修改文本。
- 不知道 terminal sequence。

建议文件：

```txt
services/local-agent/src/tui/input/inputRouter.ts
```

建议类型：

```ts
export type InputOwner =
  | { type: 'composer' }
  | { type: 'approval'; freeText: boolean }
  | { type: 'resumePicker' }
  | { type: 'busy' };

export type RoutedInputCommand =
  | { target: 'textarea'; command: TextareaCommand }
  | { target: 'app'; command: AppInputCommand }
  | { target: 'approval'; command: ApprovalInputCommand }
  | { target: 'resume'; command: ResumeInputCommand }
  | { target: 'none' };

export type AppInputCommand =
  | { type: 'submitComposer' }
  | { type: 'clearComposer' }
  | { type: 'interrupt' }
  | { type: 'exit' };
```

路由原则：

- `busy + escape` -> app interrupt
- `busy + text/cursor` -> none
- `resumePicker + up/down/submit/escape` -> resume commands
- `approval + up/down` -> option navigation
- `approval + submit` -> approval submit
- `approval + text/newline/delete/cursor` -> textarea when freeText is possible
- `composer + submit` -> app submit
- `composer + text/newline/delete/cursor` -> textarea

### 5.4 TextareaEngine

职责：

- 纯编辑模型。
- 接收 `TextareaCommand`，返回新 state。
- 不知道 TUI app、approval、resume、busy。
- 不知道 raw terminal input。

建议目录：

```txt
services/local-agent/src/tui/input/textarea/
  engine.ts
  layout.ts
  renderModel.ts
  textSegments.ts
  commands.ts
  selection.ts
  history.ts
```

建议类型：

```ts
export type TextareaState = {
  text: string;
  cursorOffset: number;
  selection?: {
    anchorOffset: number;
    focusOffset: number;
  };
  preferredColumn?: number;
};

export type TextareaCommand =
  | { type: 'insert'; text: string }
  | { type: 'paste'; text: string }
  | { type: 'newline' }
  | { type: 'deleteBackward' }
  | { type: 'deleteForward' }
  | { type: 'deleteWordBackward' }
  | { type: 'deleteToLineStart' }
  | { type: 'deleteToLineEnd' }
  | { type: 'moveLeft' }
  | { type: 'moveRight' }
  | { type: 'moveUp'; layout: TextareaLayout }
  | { type: 'moveDown'; layout: TextareaLayout }
  | { type: 'moveLineStart' }
  | { type: 'moveLineEnd' }
  | { type: 'selectAll' };
```

首版可以先不实现 selection/undo，但 state 形状要为它们留位置。

### 5.5 TextareaLayout

职责：

- 根据 text、cursor、terminal width 生成 layout rows 和 cursor metrics。
- 处理 logical line、visual line、cursor row/column。
- 处理 grapheme / display-width aware wrapping。
- 提供 offset <-> visual row/column 的映射接口，避免 engine 自己理解终端宽度。

建议类型：

```ts
export type TextareaLayout = {
  rows: TextareaLayoutRow[];
  cursor: {
    row: number;
    column: number;
    offset: number;
    isAtFirstVisualRow: boolean;
    isAtLastVisualRow: boolean;
  };
};

export type TextareaLayoutRow = {
  text: string;
  startOffset: number;
  endOffset: number;
};
```

注意：layout 层可以继续保存 JS UTF-16 offset，便于和现有 string state 兼容；但它
必须在自己的边界内把 offset 映射成 terminal visual cell。中文和 emoji 需要按
display width 切分。候选方案：

- 使用 `Intl.Segmenter` 做 grapheme segmentation，再用 width helper 计算 display width。
- 引入稳定的 `string-width` 类库。
- 如果不新增依赖，先封装 `measureCellWidth()`，让实现可替换。

### 5.6 TextareaRenderModel

职责：

- 把 layout rows 转成 render-facing rows。
- 处理 cursor cell 的 `before / cursor / after` 切片。
- 保护 grapheme cluster 不被 cursor rendering 拆开。
- 不修改文本，不参与 input routing。

建议类型：

```ts
export type TextareaRenderRow = TextareaLayoutRow & {
  before: string;
  cursor: string | null;
  after: string;
};
```

`renderModel` 和 `layout` 应共享同一套 `textSegments` / width helper，避免两个层各自
实现 grapheme 规则。

### 5.7 TextAreaViewModel

职责：

- 把 render rows、focus、placeholder、style 状态合并成 UI 可直接消费的 view rows。
- 处理 focused empty input、focused placeholder、unfocused display 等显示状态。
- 不处理 key routing。
- 不修改文本。
- 不依赖 Ink。

建议类型：

```ts
export type TextAreaViewRow = {
  before: string;
  cursor: string | null;
  after: string;
  dim: boolean;
  dimAfterCursor: boolean;
};

export type TextAreaViewModel = {
  rows: TextAreaViewRow[];
};
```

这样 `renderModel` 保持“文本与 cursor 切片”职责，`viewModel` 承接“这个 textarea
在当前 UI 状态下该如何显示”。placeholder、focus dim、未来 selection highlight /
composition underline 不应该再散落到 `Composer`。

### 5.8 TextareaHost / Composer component

职责：

- 维护 textarea host wiring：当前 textarea state、width、focus、placeholder、dispatch。
- 渲染 textarea view model。
- 不处理 key routing。
- 不实现编辑算法。
- `Composer` 只接收 view model。
- host/controller 负责构建 view model 所需的 state、focus、placeholder、style。

建议替代当前 `Composer` 的边界：

```tsx
<TextAreaView
  model={textareaViewModel}
/>
```

`Composer` 可以保留名称，但内部应从“计算并渲染 textarea”收敛为“接收 view model
并委托 `TextAreaView` 渲染”。view model 构建应由 host/controller 完成。

host/controller 层可以先落成一个轻量 hook，例如 `useTextAreaController`：

- 输入：`TuiState.input`、focus、placeholder、textarea width、`dispatch`。
- 输出：`TextAreaControllerState`（`value`、`cursorOffset`、`layout/cursor metrics`、
  `historyBoundary`、`composerProps`）以及 `clear()`、`applyCommand(command)`。
- 约束：它只做 textarea host wiring，不处理 app command、副作用、approval option
  navigation 或 resume picker。

## 6. 模块边界对照

| 层 | 当前位置 | 目标位置 | 说明 |
| --- | --- | --- | --- |
| terminal sequence buffer | `keymap.ts` | `terminalInput.ts` | 只解析 terminal event |
| raw key -> semantic event | `keymap.ts` / `textareaModel.ts` | `canonicalInput.ts` | 上层不再见 raw escape |
| app/modal routing | `keymap.ts` | `inputRouter.ts` | 根据 owner/focus 决定 command |
| text editing | `textareaModel.ts` | `textarea/engine.ts` | 纯 reducer |
| layout wrapping | `textareaModel.ts` | `textarea/layout.ts` | 终端宽度、display width |
| rendering | `Composer.tsx` | `textarea/viewModel.ts` + `TextAreaView` / `Composer` | view model 负责显示状态，view 只渲染 |
| integration | `TuiApp.tsx` | `TuiApp.tsx` + `useTextAreaController` | TuiApp 执行业务副作用，controller 接 textarea host wiring |

目标是让每层都有独立测试，不再只能从 `TuiApp` 黑盒修 bug。

## 7. TuiState 形状建议

当前：

```ts
input: TextAreaModel & {
  focused: boolean;
};
```

建议演进为：

```ts
type TuiInputState = {
  owner: InputOwner;
  composer: {
    textarea: TextareaState;
    mode: 'normal' | 'command';
  };
  approval: {
    textarea: TextareaState;
    selectedIndex: number;
  };
};
```

短期可以继续只保留一个 textarea draft，但文档上要明确：approval free text 与 composer 是否共享 draft 是业务选择，不应由 textarea engine 隐式决定。

建议首版折中：

```ts
input: {
  textarea: TextareaState;
  focused: boolean;
};
```

后续再拆 composer/approval draft。

## 8. 迁移计划

### Phase 0: 文档与基线

交付：

- 本文档。
- 标记当前 #144 的 Delete 修复只是 tactical patch，不是最终结构。

### Phase 1: Conformance test matrix

先补测试，不改大结构。

新增测试文件建议：

```txt
services/local-agent/src/tui/input/terminalInput.test.ts
services/local-agent/src/tui/input/canonicalInput.test.ts
services/local-agent/src/tui/input/inputRouter.test.ts
services/local-agent/src/tui/input/textarea/engine.test.ts
services/local-agent/src/tui/input/textarea/layout.test.ts
```

测试矩阵至少覆盖：

- raw Delete sequences：`\x1b[3~`、`[3~`、split `[3` + `~`
- Backspace / Delete / Ctrl+D
- Return submit vs Shift+Return newline vs Ctrl+J newline
- bracketed paste：`\x1b[200~...\x1b[201~`
- CRLF / CR paste normalization
- Home / End / Ctrl+A / Ctrl+E
- Ctrl+K / Ctrl+U / Ctrl+W
- up/down in multiline input
- up/down at boundary reserved for history or picker routing
- busy / approval / resume picker mode routing
- Chinese wide chars and emoji render cursor placement

### Phase 2: Extract terminal decoder and canonical events

从 `keymap.ts` 中抽出：

- `TerminalInputDecoder`
- `CanonicalInputEvent`

保持外部行为不变。`TuiApp` 仍然 dispatch 老 action，但输入先经过新层。

验收：

- `textareaModel` 不再新增 raw terminal sequence 判断。
- Delete bug 类问题可以在 canonical tests 中定位。

实施反馈：

- Phase 2 适合拆成两个小 PR 推进：先抽 `terminalInput.ts`
  作为 terminal sequence buffer 边界，再抽 `canonicalInput.ts`
  作为 raw key / raw escape 到语义事件的收敛层。
- `resolveTuiKeyAction` 可以先继续返回旧的 `TuiKeyAction`，
  但入参应切到 `CanonicalInputEvent`；这样 router 仍保持小 diff，
  同时停止读取 raw `input + key`。
- `textareaModel` 应新增 canonical event 入口，例如
  `applyTextAreaInputEvent(event, state, options)`；旧的
  `applyTextAreaInput(input, key, ...)` 可以短期保留为兼容 wrapper。
- raw Delete sequences（例如 `\x1b[3~` / `[3~` / split 后的 `[3~`）
  应在 canonical mapper 中变成 `text.delete.forward`，不要在 router
  或 textarea reducer 内做特殊判断。
- bracketed paste 当前可以先在 canonical 层处理单次事件中的
  `\x1b[200~...\x1b[201~` 和 CRLF normalization；跨多次 input event
  的 paste start/body/end 聚合仍属于 `TerminalInputDecoder` 的后续小 PR。

### Phase 3: Extract input router

把 `resolveTuiKeyAction` 改为：

```txt
CanonicalInputEvent + InputOwner -> RoutedInputCommand
```

让 `TuiApp` switch 的 target 更明确：

- textarea command
- app command
- approval command
- resume command
- none

验收：

- busy、approval、resume、composer mode 的 routing 全部有单测。
- `TuiApp` 不再直接判断 raw key。

实施反馈：

- `inputRouter.ts` 可以先承接 owner 解析和 command 路由：
  `CanonicalInputEvent + TuiInputRouteContext -> TuiInputCommand`。
- `keymap.ts` 可以退化为兼容 barrel，继续 re-export 旧的
  `resolveTuiKeyAction` / `TuiKeyAction` 名称，避免一次性修改所有调用方。
- owner 优先级需要显式测试：`unready -> resumePicker -> approval -> busy -> composer`。
  这比在 `TuiApp` 或 `keymap` 中靠 if/else 顺序隐式表达更稳。
- router 主路径应使用明确 target：`textarea command`、`app/global command`、
  `approval command`、`resume command`、`composer submit/clear`、`none`。
- 可编辑事件应只走 `{ target: 'textarea', command }`。旧的 dotted command，
  尤其 `composer.edit`，只能保留在 compatibility conversion 中，不应继续出现在
  主 `TuiInputCommand` union。
- prompt history 应作为 composer/router target 表达，例如
  `{ target: 'composerHistory', action: 'previous' | 'next' }`。textarea 只提供
  visual boundary；router 负责把 boundary 和 history availability 合成路由决策。
- `TuiApp` 接入 routed command 后，仍会承担具体副作用执行：
  exit、interrupt、submit review、resume session、textarea edit。后续若继续缩小
  `TuiApp`，应抽 handler/controller，而不是把副作用塞回 router。

### Phase 4: Promote textarea engine and layout

把 `textareaModel.ts` 拆为：

- `textarea/engine.ts`
- `textarea/layout.ts`
- `textarea/renderModel.ts`

保留兼容 export，降低一次性 diff。

验收：

- engine tests 不依赖 terminal key。
- layout tests 覆盖 multiline、soft wrap、wide char。
- `Composer` 不再调用编辑函数，也不直接计算 render/placeholder 行。

实施反馈：

- Phase 4 可以先拆出 `textarea/engine.ts` 与 `textarea/layout.ts`，
  保留 `textareaModel.ts` 作为兼容 barrel。这样生产代码可以改为直接导入
  engine/layout，新旧测试仍能覆盖兼容路径。
- engine 的主入口应逐步切到 `applyTextAreaCommand(command, state, options)`。
  `applyTextAreaInputEvent(event, ...)` 和 raw `applyTextAreaInput(input, key, ...)`
  可以短期保留为兼容 wrapper，但不应继续承载 reducer 的核心 switch。
- `textarea/commands.ts` 负责 canonical event -> textarea command 的边界映射。
  `submit`、`escape`、`tab`、`interrupt`、unknown control 等 app-level event 应映射为
  `null`，避免泄漏进 textarea engine。
- router 应把可编辑事件输出为 `{ target: 'textarea', command }`，由 `TuiApp`
  调用 `applyTextAreaCommand`。旧的 `composer.edit` 可以保留在 compatibility
  conversion 中，但不应再作为主路径命令。
- vertical cursor movement 当前需要 engine 使用 layout 的 row lookup helper，
  这是可以接受的单向依赖；layout 不应反向依赖 engine state。
- `renderModel.ts` 可以在 layout/cursor metrics 稳定后拆出。拆出后，
  layout 只暴露 rows、cursor metrics 和 offset/column 映射；显示状态继续收进
  view model，而不是回到 `Composer`。
- wide char / emoji 支持应作为 layout-focused PR 推进，而不是混入 engine 拆分 PR。
  实施后验证了一个结构判断：engine 可以保留 offset 状态，但 vertical movement
  应通过 layout 提供的 visual-column helper 完成。
- display-width support 可以使用 `Intl.Segmenter` + `string-width` 落在 layout 内部。
  row 的 `start/end` 仍保持 JS offset，render/cursor 逻辑负责保护 grapheme 不被拆开。
- 这类改动的评估重点不是“中文 case 是否单独补丁”，而是 layout 是否成为唯一理解
  terminal visual cell 的层。
- 在接入 history / selection 之前，应先让 layout 暴露 cursor metrics：
  `rows + cursor row/column + first/last visual row`。这样 host 后续只问
  “是否在视觉首行/尾行”，不会重新实现 soft-wrap、display width 或 grapheme 逻辑。
- render model 拆分后，`textSegments.ts` 应成为 layout 与 render model 的共享基础层。
  layout 使用它做 display-width wrapping，render model 使用它做 grapheme-safe cursor
  rendering。
- `Composer` 不应继续承担 placeholder、focus dim、cursor row rendering 等显示状态判断。
  这些状态应收进 `textarea/viewModel.ts`，再由 `TextAreaView` 做 Ink 适配。这样
  `Composer` 只是 host/component 边界，textarea 的显示 contract 可以独立测试。
- placeholder cursor 也应复用 grapheme segmentation，避免实现层重新使用
  `placeholder[0]` 这类 UTF-16 切片。
- view model 之后应继续抽 host/controller boundary。`useTextAreaController`
  可以先承接 `clear`、`applyCommand`、`composerProps`，让 `TuiApp` 不再直接调用
  textarea engine 或手动拼 `Composer` props；但 approval submit、resume picker、
  interrupt/exit 等业务副作用仍留在 `TuiApp`。
- controller 应有纯 `buildTextAreaControllerState` builder，把 value、cursorOffset、
  layout/cursor metrics、composer props 聚成一个可测试的 host state。hook 只负责
  绑定 dispatch callback。
- history / selection 之前还应让 controller 暴露 layout/cursor metrics，例如
  `cursor.isAtFirstVisualRow` / `cursor.isAtLastVisualRow`。这一步只提供 host 可消费的
  结构 contract，不改变上下键行为；后续 history policy 再决定如何使用这些 metrics。
- 在真正接入 history 行为前，可以先从 cursor metrics 派生
  `historyBoundary.previous` / `historyBoundary.next`。这个字段只表达“host 可以考虑切
  history 的视觉边界”，不表达具体按键策略，也不改变当前上下键移动行为。

### Phase 5: History, selection, undo, external editor

在结构稳定后补能力：

- prompt history previous/next 只在 visual top/bottom 触发。
- history routing 可以先落成纯 `composerHistoryRouting` helper：只有 textarea 位于
  visual boundary 且 prompt history 对应方向可用时，router 才输出 composer history
  command。prompt history state 和实际替换 input draft 应作为后续 PR 单独实现。
- selection state。
- undo/redo。
- optional external editor flow。
- command palette / autocomplete target-bound routing。

### Phase 6: OpenTUI migration spike

只有在以下条件满足时才考虑迁移 OpenTUI：

- Ink textarea 结构化后仍然无法稳定处理 IME、宽字符或 selection。
- 我们愿意迁移 TUI runtime 和测试工具。
- 可以接受 Solid/OpenTUI 与现有 React/Ink 分叉成本。

Spike 不直接替换生产 TUI，先做独立 prototype：

```txt
services/local-agent/experiments/opentui-textarea/
```

验收：

- 与现有 TUI protocol 对接。
- 验证中文输入、粘贴、selection、history、approval textarea。
- 给出迁移成本评估。

## 9. 开发约束

### 9.1 不允许继续扩大 `resolveTuiKeyAction`

新按键行为应优先进入：

- terminal decoder
- canonical event mapper
- input router
- textarea engine

而不是继续把更多条件塞进 `resolveTuiKeyAction`。

### 9.2 Textarea engine 不接收 raw terminal input

禁止这样的新接口：

```ts
applyTextAreaInput(input: string, key: TuiKeyInput, state)
```

目标接口应是：

```ts
applyTextareaCommand(state, command, layoutContext)
```

### 9.3 App command 不修改 textarea 内部细节

提交、打断、approval submit 可以读取 textarea text，也可以 clear textarea，但不应该直接实现 delete/move/word movement。

### 9.4 Layout 与 engine 分离

engine 维护 offset。layout 负责 offset 到 visual row/column 的映射。这样以后可以替换 width 计算，不影响编辑命令。

## 10. 验收标准

结构验收：

- `TuiApp.tsx` 中不再包含 raw key interpretation。
- `textarea/engine.ts` 不依赖 Ink key shape。
- `inputRouter.ts` 明确表达 composer / approval / resume / busy ownership。
- `useTextAreaController` 组合 textarea view model，`Composer` / `TextAreaView`
  只消费 view model。

行为验收：

- Delete / Backspace 在 macOS Terminal、iTerm2、VS Code terminal 中行为一致。
- Shift+Enter 插入换行，Enter 提交。
- 多行 paste 保留换行并不会误提交。
- approval free text 与 composer 行为一致，但 option navigation 不被破坏。
- resume picker 上下选择不误改 textarea。
- 中文宽字符和 emoji 光标显示不明显漂移。

测试验收：

- terminal decoder、canonical mapper、router、engine、layout 都有独立单测。
- `tuiInput.test.ts` 保留端到端 reducer 级别覆盖。
- 每个新发现的 input bug 先转成 conformance test，再修。

## 11. 推荐 PR 拆分

1. `codex/tui-input-conformance-tests`
   - 增加现有行为测试矩阵。
   - 不做大重构。
2. `codex/tui-canonical-input-events`
   - 抽出 terminal decoder 和 canonical mapper。
   - 保持 TuiApp 行为不变。
3. `codex/tui-input-router`
   - 抽出 owner/focus router。
   - 收敛 `resolveTuiKeyAction`。
4. `codex/tui-textarea-engine`
   - 抽出纯 textarea engine。
   - `textareaModel.ts` 变成兼容 facade 或删除。
5. `codex/tui-textarea-layout`
   - 独立 layout 边界，保留兼容 render rows。
   - 先覆盖 multiline / soft-wrap，不混入 display-width 风险。
6. `codex/tui-textarea-display-width`
   - 让 layout 负责 grapheme segmentation、display width、offset/visual column 映射。
   - engine 只消费 layout 暴露的 visual-column helper。
7. `codex/tui-textarea-cursor-layout`
   - 暴露 `rows + cursor visual metrics`，包括 first/last visual row。
   - 为 history boundary、selection、mouse positioning 预留同一个 layout contract。
8. `codex/tui-textarea-render-model`
   - 把 `renderTextAreaRows` 从 layout 拆出到 render model。
   - 提取共享 text segmentation helper，避免 layout/render 各自处理 grapheme。
9. `codex/tui-textarea-commands`
   - 新增 textarea-owned command union。
   - 让 engine 主入口消费 textarea command，canonical/raw 入口退为兼容 wrapper。
10. `codex/tui-routed-textarea-commands`
   - router 输出 `{ target: 'textarea', command }`。
   - `TuiApp` 直接 dispatch `applyTextAreaCommand`，legacy `composer.edit` 仅保留兼容转换。
11. `codex/tui-textarea-view-model`
   - 新增 `buildTextAreaViewModel` 和 `TextAreaView`。
   - `Composer` 不再直接计算 layout/render/placeholder 行。
12. `codex/tui-textarea-controller`
   - 新增 `useTextAreaController` 作为 host wiring 边界。
   - `TuiApp` 不再直接调用 textarea engine 或手动拼 Composer props。
13. `codex/tui-textarea-host-metrics`
   - 从 controller 暴露 layout/cursor metrics。
   - 为 history 边界准备 `first/last visual row` contract，不改变当前输入行为。
14. `codex/tui-composer-view-model-props`
   - controller 产出 `TextAreaViewModel`，`Composer` 只接收 model 并渲染。
   - 进一步防止 placeholder/focus/render 逻辑回流到组件。
15. `codex/tui-drop-composer-edit-command`
   - 从主 `TuiInputCommand` union 删除 `composer.edit`。
   - legacy `composer.edit` 仅保留在兼容转换中。
16. `codex/tui-textarea-controller-state`
   - 新增纯 `TextAreaControllerState` builder。
   - `useTextAreaController` 只绑定 dispatch callbacks。
17. `codex/tui-textarea-history-boundary`
   - controller 从 visual cursor metrics 派生 `historyBoundary`。
   - 只新增 host 可消费的结构信号，不接入上下键或 prompt history 行为。
18. `codex/tui-composer-history-routing`
   - 新增 `composerHistoryRouting` 纯 helper。
   - router 只有在 visual boundary 和 history availability 都满足时才输出
     `composerHistory` command。
   - `TuiApp` 先接入 boundary 上下文，但保持 history availability disabled，不改变当前
     上下键行为。
19. `codex/tui-textarea-history-selection`
   - 上下历史边界、selection、undo/redo。
20. `codex/tui-opentui-spike`
   - 可选 spike，不阻塞 Ink 路线。

## 12. Open Questions

- 是否接受新增 `string-width` / grapheme segmentation 依赖？
- approval free-text 是否应该拥有独立 draft，还是复用 composer draft？
- prompt history 是否属于 textarea subsystem，还是 composer domain？
- 是否需要短期支持 mouse positioning？
- 是否要把 key bindings 做成用户可配置，还是先固定？
- OpenTUI spike 放在本仓库 experiments，还是单独临时分支？

## 13. 结论

textarea 需要被当作 TUI 的基础设施，而不是一个附着在 `TuiApp` 里的输入框。opencode 的核心启发是：

```txt
focused textarea owns editing
keymap owns command activation
prompt owns business behavior
renderer owns layout and cursor display
```

PinPawo 短期不必迁移 OpenTUI，但应该学习这个结构，把当前 input 拆成 terminal decoder、
canonical event、router、textarea engine、layout/render model、view model/render view
这些明确层次。

这样后续再遇到 Delete、IME、paste、wide char、history 等问题时，我们能知道 bug 属于哪一层，并用对应层的测试固定下来。
