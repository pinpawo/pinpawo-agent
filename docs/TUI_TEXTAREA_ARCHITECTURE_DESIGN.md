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
- `Composer` 渲染直接依赖编辑模型输出，缺少独立 render model。
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
  -> Composer render
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

- 根据 text、cursor、terminal width 生成 render model。
- 处理 logical line、visual line、cursor row/column。
- 后续接入 grapheme/width-aware 计算。

建议类型：

```ts
export type TextareaLayout = {
  rows: TextareaRenderRow[];
  cursor: {
    row: number;
    column: number;
    offset: number;
  };
};

export type TextareaRenderRow = {
  text: string;
  startOffset: number;
  endOffset: number;
  cursorColumn?: number;
};
```

注意：当前 `wrapTextAreaRows` 使用 `line.length` 切分，长期不够。中文和 emoji 需要按 display width 切分。候选方案：

- 使用 `Intl.Segmenter` 做 grapheme segmentation，再用 width helper 计算 display width。
- 引入稳定的 `string-width` 类库。
- 如果不新增依赖，先封装 `measureCellWidth()`，让实现可替换。

### 5.6 TextareaHost / Composer component

职责：

- 渲染 textarea view model。
- 不处理 key routing。
- 不实现编辑算法。
- 只接收 state、layout、focus、placeholder、style。

建议替代当前 `Composer` 的边界：

```tsx
<TextareaView
  state={input.textarea}
  layout={layout}
  focused={focused}
  placeholder={placeholder}
/>
```

`Composer` 可以保留名称，但内部应从“计算并渲染 textarea”逐步收敛为“渲染传入的 textarea render model”。

## 6. 模块边界对照

| 层 | 当前位置 | 目标位置 | 说明 |
| --- | --- | --- | --- |
| terminal sequence buffer | `keymap.ts` | `terminalInput.ts` | 只解析 terminal event |
| raw key -> semantic event | `keymap.ts` / `textareaModel.ts` | `canonicalInput.ts` | 上层不再见 raw escape |
| app/modal routing | `keymap.ts` | `inputRouter.ts` | 根据 owner/focus 决定 command |
| text editing | `textareaModel.ts` | `textarea/engine.ts` | 纯 reducer |
| layout wrapping | `textareaModel.ts` | `textarea/layout.ts` | 终端宽度、display width |
| rendering | `Composer.tsx` | `TextareaView` / `Composer` | 只渲染 view model |
| integration | `TuiApp.tsx` | `TuiApp.tsx` + controller/hook | 只做 wiring |

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
- 当前 router 仍返回旧的 broad command union；下一步可以把命令进一步拆成
  `textarea command`、`app command`、`approval command`、`resume command`，
  让 `TuiApp` 的 switch target 更接近本节的目标。
- router 输出可以采用 `{ target, action }` 形状，例如
  `{ target: 'composer', action: 'edit' }`。旧的
  `approval.previous` / `composer.edit` dotted command 可以保留为
  `keymap.ts` 的兼容转换层，但不应再作为主路径。
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
- `Composer` 不再调用编辑函数，只消费 render model。

实施反馈：

- Phase 4 可以先拆出 `textarea/engine.ts` 与 `textarea/layout.ts`，
  保留 `textareaModel.ts` 作为兼容 barrel。这样生产代码可以改为直接导入
  engine/layout，新旧测试仍能覆盖兼容路径。
- vertical cursor movement 当前需要 engine 使用 layout 的 row lookup helper，
  这是可以接受的单向依赖；layout 不应反向依赖 engine state。
- `renderModel.ts` 可以后续再拆。当前 `renderTextAreaRows` 仍在 layout 中，
  `Composer` 直接消费 layout 输出。
- 当前 layout 仍使用 JS string length 和 slice，因此 soft wrap 已独立测试，
  但 CJK/emoji display width 还没有真正解决；wide char 支持应作为后续
  layout-focused PR，而不是混入 engine 拆分 PR。

### Phase 5: History, selection, undo, external editor

在结构稳定后补能力：

- prompt history previous/next 只在 visual top/bottom 触发。
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
- `Composer` 或 `TextareaView` 只消费 render model。

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
   - 独立 layout/render model。
   - 引入 width-aware wrapping。
6. `codex/tui-textarea-history-selection`
   - 上下历史边界、selection、undo/redo。
7. `codex/tui-opentui-spike`
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

PinPawo 短期不必迁移 OpenTUI，但应该学习这个结构，把当前 input 拆成 terminal decoder、canonical event、router、textarea engine、layout/render model 五个明确层次。

这样后续再遇到 Delete、IME、paste、wide char、history 等问题时，我们能知道 bug 属于哪一层，并用对应层的测试固定下来。
