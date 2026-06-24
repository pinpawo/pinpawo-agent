# TUI Textarea 重构进度对齐

> 状态：as-built 进度盘点 ── 实现栈与 6 个收尾/高阶 PR 均已合入 main
> 日期：2026-06-19
> 设计依据：[`TUI_TEXTAREA_ARCHITECTURE_DESIGN.md`](./TUI_TEXTAREA_ARCHITECTURE_DESIGN.md)（PR #149，过程设计文档）
> 实现栈：PR #187 → #193(原 #188) → #189 → #190（已合并）
> 收尾/高阶：PR #195 → #197 → #201 → #200 → #198 → #199（已合并）

本文是**进度对齐文档**，不替代 #149。#149 记录"我们想怎么做、为什么"（设计意图，在迭代中不断修正方向）；本文记录"现在代码做到哪了、哪些 PR 待合、对照设计还差什么"（as-built）。两者职责不同，刻意使用不同文件名，互不覆盖。

---

## 1. 一句话结论

#149 设计的整套分层（terminal decoder → canonical → router → engine/layout/render/view → controller/host）**已在实现栈中真实落地并合入 main**，每个模块都带 `.test.ts`。实现栈 4 个 PR 已按 main → #187 → #193(原 #188) → #189 → #190 顺序合并完成；随后 6 个收尾/高阶 PR 也已全部合入 main。

截至 PR #199 合入后，TUI textarea 重构目标已经从"继续拆结构/补能力"转入维护态。后续 TUI input bug 应继续按层定位（decoder / canonical / router / engine / layout / render / host）并以对应层测试固化；当前没有新的 TUI textarea 功能 PR 需要继续推进。

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

### 2.4 TUI textarea 收尾/高阶 PR（已全部合入 main）

| PR | 标题 | 改动 | 结局 |
|---|---|---|---|
| #195 | Drop textarea raw input wrapper | 删除 legacy raw input facade，生产路径只走 canonical → command → `applyTextAreaCommand` | ✅ MERGED |
| #197 | Clarify TUI approval free text focus | 固化 approval free-text focus policy：空回复时 ↑↓ 选项导航，有回复时 ↑↓/Shift+↑↓ 归 textarea | ✅ MERGED |
| #201 | Add TUI file mention popup | `@`/`@path` 路径候选、root 限制、忽略大目录、Tab 补全 | ✅ MERGED |
| #200 | Document OpenTUI spike defer decision | 固化 OpenTUI spike defer/no-op 决策与重新触发条件 | ✅ MERGED |
| #198 | Add TUI command palette | slash command popup 来自 `commandRegistry.ts`，↑↓ 选择，Tab 补全 | ✅ MERGED |
| #199 | Add TUI external editor command | `/edit [文本]` 使用 `$VISUAL`/`$EDITOR` 编辑临时草稿并回填 composer | ✅ MERGED |

---

## 3. 对照 #149 的 Phase 计划：完成度

| Phase | 设计交付 | 实现现状 | 判定 |
|---|---|---|---|
| **0 文档与基线** | 设计文档；标记 #144 Delete 修复为临时补丁 | #149 文档已有；#146 散修已关 | ✅ 完成 |
| **1 Conformance test matrix** | terminalInput / canonicalInput / inputRouter / engine / layout 测试 | 对应 `.test.ts` 均存在，TUI 共 76 测试 | ✅ 完成（建议持续按矩阵补新发现的 bug） |
| **2 抽 terminal decoder + canonical** | `terminalInput.ts`、`canonicalInput.ts` | `tui/input/terminalInput.ts`、`tui/input/canonicalInput.ts` 已落地 | ✅ 完成 |
| **3 抽 input router** | `resolveTuiKeyAction` → `CanonicalInputEvent + owner → RoutedCommand` | `tui/input/inputRouter.ts` + `commandRegistry.ts`；owner 含 unready/resumePicker/approval/busy/composer | ✅ 完成 |
| **4 提升 engine + layout** | `textarea/{engine,layout,renderModel}.ts`，Composer 不再算渲染 | `tui/input/textarea/{engine,layout,renderModel,viewModel}.ts` + `Composer.tsx`/`TextAreaView.tsx` | ✅ 完成 |
| **5 history / selection / undo / 高阶** | prompt history、selection、undo/redo、preferred column、external editor、command palette | history（`composerHistory*`）、selection（`textarea/selection.ts`）、undo/redo、preferred column、grapheme-aware（`textSegments.ts`）、file mention、command palette、external editor 均已落地 | ✅ 完成 |
| **6 OpenTUI migration spike** | `experiments/opentui-textarea/` prototype | PR #200 已记录 defer/no-op 决策；当前 Ink 分层已覆盖已知 textarea 风险，未触发迁移条件 | ✅ 完成（条件性 defer） |

---

## 4. 对照 #149：收尾/高阶项结论

以下 6 项原本是栈合并后的待办，现已全部处理完毕：

1. **清理 legacy raw input wrapper（收尾）**
   - 状态：PR #195 已合入 main。
   - 本 PR 变更：删除 `applyTextAreaInput` / `applyTextAreaInputEvent` facade；`textareaModel.ts` 不再 re-export raw wrapper；测试改为显式覆盖 canonical mapper、textarea command mapper 和 `applyTextAreaCommand`。
   - 结论：生产路径（`TuiApp`、`inputRouter`、新功能）只走 `applyTextAreaCommand`；raw terminal input 留在 terminal decoder / canonical mapper 边界。

2. **approval free-text focus policy（明确语义）**
   - 状态：PR #197 已合入 main。
   - 本 PR 变更：`inputRouter.ts` 让 `{ type: 'approval'; freeTextActive }` 真正参与路由；approval 回复为空时 ↑↓ 切换选项，已有自由文本时 ↑↓ / Shift+↑↓ 归 textarea 编辑，Enter 仍提交当前 approval。
   - 结论：approval 自由文本的进入/退出策略由 router contract 固化；清空回复后回到选项导航，有回复时可编辑多行/选择文本，不再和 approval option navigation 抢焦点。

3. **command popup / command palette**（Phase 5）
   - 状态：PR #198 已合入 main。
   - 本 PR 变更：基于 `commandRegistry.ts` 派生 slash command popup；`/` 和命令前缀展示候选，↑↓ 选择，Tab 补全命令，Enter 保持提交当前 composer 内容。
   - 结论：命令候选不复制第二套列表；popup 只在 composer slash 前缀活跃时出现，不抢 approval/resume/busy owner；输入路由对 popup 导航、补全和普通 textarea 编辑有测试覆盖。

4. **file mention / 路径搜索**（#191 提到的高阶输入能力）
   - 状态：PR #201 已合入 main。
   - 本 PR 变更：composer 中输入 `@` 或 `@path/prefix` 时展示 root 内路径候选，↑↓ 选择，Tab 补全 `@path` mention；候选来自当前 runtime cwd（缺省 `config.workdir`），并限制在 root 内。
   - 结论：路径搜索不越过工作目录 root，不枚举 `.git` / `node_modules` 等大目录；popup 只在 composer mention token 活跃时出现，不抢 approval/resume/busy owner；输入路由和路径补全有测试覆盖。

5. **optional external editor flow**（Phase 5，`$EDITOR`）
   - 状态：PR #199 已合入 main。
   - 本 PR 变更：新增 `/edit [文本]` 命令，使用 `$VISUAL` 或 `$EDITOR` 打开临时草稿文件，保存并退出后把内容回填 composer，不直接发送。
   - 结论：外部编辑器流程可选、失败可恢复；没有配置 editor 时给出用户可见提示；编辑器命令解析、草稿读写和 `/edit` 提交流程有测试覆盖。PR #199 在 #198 合入后同步更新 command palette 测试，使 `/edit` 出现在 slash command 候选中。

6. **OpenTUI migration spike**（Phase 6）
   - 状态：PR #200 已合入 main，决策为 **defer / no-op**。
   - 决策依据：#149 明确短中期保留 Ink，并且实现栈已把 decoder / canonical / router / engine / layout / render / view / controller 边界落地；当前没有证据表明 Ink 在 IME、宽字符、selection、history、approval textarea 上仍存在无法通过该分层修复的问题。
   - 触发条件：只有当后续 bug 证明 Ink 分层方案无法稳定处理 IME、宽字符、selection 或 approval textarea，且修复成本高于 prototype 成本时，才启动 `services/local-agent/experiments/opentui-textarea/`。
   - 若触发：开独立 issue/PR，prototype 必须验证现有 TUI protocol 对接、中文输入、粘贴、selection、history、approval textarea，并给出迁移成本评估；不得直接替换生产 TUI。
   - 结论：把“当前无需启动”从口头判断固化为可审计的 as-built 决策，避免为了完成清单而引入无触发依据的 OpenTUI 分叉。

> 结论：TUI textarea 这组不再有未完成 PR。后续只保留维护策略：新 bug 必须先归层，再以对应层测试固定。

---

## 5. 后续推进安排

当前仓库还有一组非 TUI textarea 的 workdir-scoped runtime stacked PR 需要继续推进：

| 顺序 | PR | base → head | 当前安排 |
|---|---|---|---|
| 1 | #202 Add workdir-scoped Studio setup migration | `main` → `codex/workdir-phase4` | 先合入。合并时不要删除 `codex/workdir-phase4`，因为 #203 仍以它为 base。 |
| 2 | #203 Extract runtime-config Studio run service | `codex/workdir-phase4` → `codex/workdir-phase5-studio-run-service` | #202 合入后，先 retarget/rebase 到 `main` 并重新跑检查，再合入。不要删除 `codex/workdir-phase5-studio-run-service`，因为 #204 仍以它为 base。 |
| 3 | #204 Expose Studio config source in runtime | `codex/workdir-phase5-studio-run-service` → `codex/workdir-studio-config-source` | #203 合入后，retarget/rebase 到 `main` 并重新跑检查，再合入。不要删除 `codex/workdir-studio-config-source`，因为 #205 仍以它为 base。 |
| 4 | #205 Respect default workdir for Studio migrate | `codex/workdir-studio-config-source` → `codex/workdir-studio-migrate-default` | #204 合入后，retarget/rebase 到 `main` 并重新跑检查，再合入；最后统一清理 stacked 分支。 |

执行约束：

- 对 stacked PR 自底向上推进，避免再次触发“删除中间 base 分支导致上层 PR 自动关闭”的事故。
- 每合入一层后刷新 `origin/main`，用 GitHub mergeability 与本地 merge/rebase 双重确认下一层是否仍干净。
- 每层合并前按影响范围跑对应测试；如果只是 retarget 后无代码变化，也至少跑 typecheck 和相关单测。
- 这组 workdir PR 与 TUI textarea 重构无直接耦合；不要把 TUI textarea 状态文档更新混进 workdir 功能 PR。

---

## 6. 维护约定

- 本文随后续 TUI input 维护 PR **持续更新**（每合并一个相关 PR，更新第 2、3 节）。
- #149 设计文档保持"意图/方向"定位，原则上不再被覆盖式改写；新发现的设计调整以增补/批注形式记录。
- 后续 input bug 一律先定位到层（decoder / canonical / router / engine / layout / render / host），通过 conformance 测试固化，**不再开单按键散 PR**。
