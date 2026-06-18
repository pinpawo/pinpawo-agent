# TUI Textarea 重构进度对齐

> 状态：as-built 进度盘点
> 日期：2026-06-18
> 设计依据：[`TUI_TEXTAREA_ARCHITECTURE_DESIGN.md`](./TUI_TEXTAREA_ARCHITECTURE_DESIGN.md)（PR #149，过程设计文档）
> 实现栈：PR #187 → #188 → #189 → #190（stacked，base 依次为 main / 前一个 PR）

本文是**进度对齐文档**，不替代 #149。#149 记录"我们想怎么做、为什么"（设计意图，在迭代中不断修正方向）；本文记录"现在代码做到哪了、哪些 PR 待合、对照设计还差什么"（as-built）。两者职责不同，刻意使用不同文件名，互不覆盖。

---

## 1. 一句话结论

#149 设计的整套分层（terminal decoder → canonical → router → engine/layout/render/view → controller/host）**已在实现栈中真实落地**，每个模块都带 `.test.ts`。实现栈 4 个 PR（#187–#190）是一条干净的线性堆叠，栈顶 **typecheck 通过、TUI 单测 76 个全过、local-agent 全量 359 个全过**。

主要工作已不是"继续拆结构"，而是收尾：清理 legacy raw input wrapper、明确 approval free-text focus policy，以及补 command popup / file mention / 可选 external editor 等高阶能力。

---

## 2. PR 现状盘点

### 2.1 实现栈（建议合并，需先理顺合并路径）

| PR | 标题 | base | 改动 | 状态 |
|---|---|---|---|---|
| #187 | consolidate TUI input foundation | `main` | 11 files, +804/-338 | MERGEABLE / CLEAN |
| #188 | consolidate TUI textarea core | #187 | 20 files, +1299/-300 | MERGEABLE / CLEAN |
| #189 | consolidate TUI textarea editing | #188 | 27 files, +1461/-76 | MERGEABLE / CLEAN |
| #190 | consolidate TUI textarea refinements | #189 | 16 files, +330/-47 | MERGEABLE / CLEAN |

- 栈顶相对 main：**34 commits / 37 files / +3721 / -588**。
- 这 4 个 bundle 共**取代（supersede）了 34 个 codex 微 PR**（#150–#158、#161–#168、#170–#186）——这些微 PR 均已 CLOSED，列表已清理。
- 栈顶验证（在 `codex/tui-textarea-refinements-bundle` 上跑）：`npm run typecheck` 通过；`tui/**/*.test.ts` 76 passed；`test:unit` 359 passed / 0 fail。

**合并合理性判断：合理。** 这不是零散乱改，而是"34 微 PR → 4 主题 bundle"的有序整合，分层与 #149 设计一致，且全测试通过。

**合并路径要点（重要）：** 因为是 stacked PR，base 不是 main 的不能单独合。两种合法做法——
1. **按栈自底向上依次合**：先合 #187（base=main），#188 的 base 自动变 main 后合，再 #189、#190。
2. **压成一个 PR**：把栈顶 `codex/tui-textarea-refinements-bundle` 直接对 main 开一个聚合 PR 合入（review 一次、history 一条）。
> ⚠️ 不要先合中间某个 bundle，否则其余 base 失效会引发冲突——今天 #148/#159 的冲突就是"并行重复 PR + 乱序合并"造成的。

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
   - 现状：`tui/input/textareaModel.ts` 已退化为 compat barrel，re-export `textarea/*`；`engine.ts` 仍保留 `applyTextAreaInput` / `applyTextAreaInputEvent` 作为兼容入口。
   - 待办：生产路径（`TuiApp`、`inputRouter`、新功能）只允许走 `applyTextAreaCommand`；将 raw wrapper 移出 engine 主边界或删除，仅测试/旧 facade 可临时保留。

2. **approval free-text focus policy（明确语义）**
   - 现状：`inputRouter.ts` 已建模 `{ type: 'approval'; freeTextActive }` owner，但只是一个透传 flag。
   - 待办：明确 approval 自由文本输入的 focus 归属与进入/退出策略（何时把可编辑事件交给 approval textarea、何时回到 composer）。

3. **command popup / command palette**（Phase 5）——未实现。

4. **file mention / 路径搜索**（#191 提到的高阶输入能力）——未实现。

5. **optional external editor flow**（Phase 5，`$EDITOR`）——未实现。

6. **OpenTUI migration spike**（Phase 6）——条件性，当前无需启动。

> 第 1、2 项是"重构收尾"，建议优先；3–5 项是新增能力，可按需排期；第 6 项保持观望。

---

## 5. 维护约定

- 本文随实现栈与后续收尾 PR **持续更新**（每合并一个相关 PR，更新第 2、3 节）。
- #149 设计文档保持"意图/方向"定位，原则上不再被覆盖式改写；新发现的设计调整以增补/批注形式记录。
- 后续 input bug 一律先定位到层（decoder / canonical / router / engine / layout / render / host），通过 conformance 测试固化，**不再开单按键散 PR**。
