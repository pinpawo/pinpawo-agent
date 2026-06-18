# TUI Textarea 重构进度对齐

> 状态：as-built 进度盘点 ── 实现栈已于 2026-06-18 全部合入 main
> 日期：2026-06-18
> 设计依据：[`TUI_TEXTAREA_ARCHITECTURE_DESIGN.md`](./TUI_TEXTAREA_ARCHITECTURE_DESIGN.md)（PR #149，过程设计文档）
> 实现栈：PR #187 → #193(原 #188) → #189 → #190（已合并）

本文是**进度对齐文档**，不替代 #149。#149 记录"我们想怎么做、为什么"（设计意图，在迭代中不断修正方向）；本文记录"现在代码做到哪了、哪些 PR 待合、对照设计还差什么"（as-built）。两者职责不同，刻意使用不同文件名，互不覆盖。

---

## 1. 一句话结论

#149 设计的整套分层（terminal decoder → canonical → router → engine/layout/render/view → controller/host）**已在实现栈中真实落地并合入 main**，每个模块都带 `.test.ts`。实现栈 4 个 PR 已按 main → #187 → #193(原 #188) → #189 → #190 顺序合并完成，**合并后的 main：typecheck 通过、TUI 单测 76 个全过、local-agent 全量 359 个全过**。

主要工作已不是"继续拆结构"，而是收尾：PR #195 清理 legacy raw input wrapper，后续继续明确 approval free-text focus policy，以及补 command popup / file mention / 可选 external editor 等高阶能力。

---

## 2. PR 现状盘点

### 2.1 实现栈（已全部合入 main）

| PR | 标题 | 改动 | 结局 |
|---|---|---|---|
| #187 | consolidate TUI input foundation | 11 files, +804/-338 | ✅ MERGED |
| #193（原 #188） | consolidate TUI textarea core | 20 files, +1299/-300 | ✅ MERGED |
| #189 | consolidate TUI textarea editing | 27 files, +1461/-76 | ✅ MERGED |
| #190 | consolidate TUI textarea refinements | 16 files, +330/-47 | ✅ MERGED |

- 合入 main 共 **34 commits / 37 files / +3721 / -588**。
- 这 4 个 bundle 共**取代（supersede）了 34 个 codex 微 PR**（#150–#158、#161–#168、#170–#186）——这些微 PR 均已 CLOSED。
- 合并后 main 验证：`npm run typecheck` 通过；`tui/**/*.test.ts` 76 passed；`test:unit` 359 passed / 0 fail。

**合并合理性判断：合理。** 这不是零散乱改，而是"34 微 PR → 4 主题 bundle"的有序整合，分层与 #149 设计一致，全测试通过。

**合并执行记录（含一次事故与补救）：**
1. #187（base=main）正常合并，并 `--delete-branch` 删除其 head 分支 `codex/tui-input-foundation-bundle`。
2. ⚠️ **事故**：#188 的 base 仍指向刚被删的 foundation 分支，GitHub 自动把 #188 关闭（CLOSED），且无法 reopen（base 分支已不存在）。
3. **补救**：以 #188 的 head 分支 `codex/tui-textarea-core-bundle`（仍存活）对 main 新建 **#193** 替代，合并。核对 `core vs main` diff = 20 files/+1299/-300，与原 #188 完全一致，内容无重复无遗漏。
4. #189、#190 改用「先 `gh pr edit --base main` retarget → ready → merge **不带 --delete-branch**」逐个合入，最后统一删分支。

> ⚠️ **经验教训**：合并 stacked PR 时**不要对中间层用 `--delete-branch`**。删掉某层 head 分支会使其上层 PR 的 base 失效，触发 GitHub 自动关闭。正确做法：自底向上 retarget 到 main 后再合，分支等整条链合完统一删。

### 2.2 文档 PR

| PR | 角色 | 处置 |
|---|---|---|
| #149 | 过程设计文档（v1，方向迭代记录） | **保留**作为设计/决策依据 |
| #191 | 实现对齐文档（v2，复用了 #149 同名文件） | 已 CLOSED——它复用同名文件会覆盖 #149；其有效内容（§1.1 实现状态、主架构文档更新）由本文 + 后续 PR 承接 |

### 2.3 已关闭的散修 / 重复 PR

| PR | 原因 |
|---|---|
| #146 | 单点修 Delete 键——正是 #149 反对的"逐按键散 PR"；已被栈的 terminalInput/canonicalInput 分层系统覆盖 |
| #147 / #159 | 针对 #141，未触根因（operation target 在结束事件丢失），#141 已由 #169 修复 |
| #148 | 与已合并的 #160 重复（同为 #145 配置向导） |

---

## 3. 对照 #149 的 Phase 计划：完成度

| Phase | 设计交付 | 实现现状 | 判定 |
|---|---|---|---|
| **0 文档与基线** | 设计文档；标记 #144 Delete 修复为临时补丁 | #149 文档已有；#146 散修已关 | ✅ 完成 |
| **1 Conformance test matrix** | terminalInput / canonicalInput / inputRouter / engine / layout 测试 | 对应 `.test.ts` 均存在，TUI 共 76 测试 | ✅ 完成（建议持续按矩阵补新发现的 bug） |
| **2 抽 terminal decoder + canonical** | `terminalInput.ts`、`canonicalInput.ts` | `tui/input/terminalInput.ts`、`tui/input/canonicalInput.ts` 已落地 | ✅ 完成 |
| **3 抽 input router** | `resolveTuiKeyAction` → `CanonicalInputEvent + owner → RoutedCommand` | `tui/input/inputRouter.ts` + `commandRegistry.ts`；owner 含 unready/resumePicker/approval/busy/composer | ✅ 完成 |
| **4 提升 engine + layout** | `textarea/{engine,layout,renderModel}.ts`，Composer 不再算渲染 | `tui/input/textarea/{engine,layout,renderModel,viewModel}.ts` + `Composer.tsx`/`TextAreaView.tsx` | ✅ 完成 |
| **5 history / selection / undo / 高阶** | prompt history、selection、undo/redo、preferred column、external editor、command palette | history（`composerHistory*`）、selection（`textarea/selection.ts`）、undo/redo、preferred column、grapheme-aware（`textSegments.ts`）均已落地；**external editor 与 command palette 未做** | 🟡 部分完成 |
| **6 OpenTUI migration spike** | `experiments/opentui-textarea/` prototype | 无（设计本就标注为"仅在 Ink 无法稳定处理 IME/宽字符/selection 时才考虑"） | ⬜ 条件性，未触发 |

---

## 4. 对照 #149：尚未做完的部分（建议后续 PR）

以下是栈合并后仍待办的，按 #149 §1.1 与 Phase 5/6 整理：

1. **清理 legacy raw input wrapper（收尾）**
   - 状态：PR #195（`codex/tui-textarea-drop-raw-wrapper`）处理中。
   - 本 PR 变更：删除 `applyTextAreaInput` / `applyTextAreaInputEvent` facade；`textareaModel.ts` 不再 re-export raw wrapper；测试改为显式覆盖 canonical mapper、textarea command mapper 和 `applyTextAreaCommand`。
   - 验收目标：生产路径（`TuiApp`、`inputRouter`、新功能）只允许走 `applyTextAreaCommand`；raw terminal input 停留在 terminal decoder / canonical mapper 边界。

2. **approval free-text focus policy（明确语义）**
   - 状态：PR `codex/tui-textarea-approval-focus-policy` 处理中。
   - 本 PR 变更：`inputRouter.ts` 让 `{ type: 'approval'; freeTextActive }` 真正参与路由；approval 回复为空时 ↑↓ 切换选项，已有自由文本时 ↑↓ / Shift+↑↓ 归 textarea 编辑，Enter 仍提交当前 approval。
   - 验收目标：approval 自由文本的进入/退出策略由 router contract 固化；清空回复后回到选项导航，有回复时可编辑多行/选择文本，不再和 approval option navigation 抢焦点。

3. **command popup / command palette**（Phase 5）——未实现。

4. **file mention / 路径搜索**（#191 提到的高阶输入能力）——未实现。

5. **optional external editor flow**（Phase 5，`$EDITOR`）——未实现。

6. **OpenTUI migration spike**（Phase 6）——条件性，当前无需启动。

> 第 1 项由 PR #195 收尾；第 2 项建议作为下一 PR 优先处理；3–5 项是新增能力，可按需排期；第 6 项保持观望。

---

## 5. 维护约定

- 本文随实现栈与后续收尾 PR **持续更新**（每合并一个相关 PR，更新第 2、3 节）。
- #149 设计文档保持"意图/方向"定位，原则上不再被覆盖式改写；新发现的设计调整以增补/批注形式记录。
- 后续 input bug 一律先定位到层（decoder / canonical / router / engine / layout / render / host），通过 conformance 测试固化，**不再开单按键散 PR**。
