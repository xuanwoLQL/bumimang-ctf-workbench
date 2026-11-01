# R-5 · 档位不对称：UI 把「同一个档位在三家 agent 上语义不同」说清

- **时间**：2026-10-13 07:44
- **谁做**：Lane B（Claude Code）
- **对应阻塞**：`docs/BLOCKED.md` 的 R-5（档位在三家之间语义不同，UI 需要说清）
- **动了哪些目录**：只 `apps/desktop/src/renderer/**` 与 `apps/desktop/electron/**`。**未动** `src/main`、`packages/shared-protocol/events.ts`、`docs/ARCHITECTURE.md`。

## 背景（不对称是什么）

`guarded` / `autonomous` 这个档位，在四家 agent 上作用不一样：

| agent | 档位的作用 |
| --- | --- |
| claude | 两档都会请求授权（原生）；档位只决定请求**转人工**（guarded）还是**自动放行**（autonomous，§9.2 档位兜底） |
| opencode | 同上（本应用按会话注入 `permission.edit/bash="ask"`，与档位无关） |
| codex | 档位**决定它问不问**：guarded → 切原生 mode `read-only`（会问）；autonomous → 保持默认自动复核（**不问**） |
| dsh | 未知（适配器未安装） |

为什么是问题：用户给 codex 选 autonomous，会看到一个永远空的审批面板，误以为应用坏了。

## 改了什么（全部在渲染层，契约零改动）

1. **`src/renderer/gate.ts`（新文件）**：把「档位不对称」的渲染层知识集中到一个文件。
   - `sessionGateArmed(agentId, tier)` → `"armed" | "not_armed" | "unknown"`：从 agent + tier 推导该会话闸门是否真的会产生审批输入。文件头有**必须与 `src/main/session/manager.ts` 保持同步**的注释（claude/opencode 两档都问；codex 只有 guarded 问；dsh/未知 → unknown）。
   - `gateBadge(agentId, tier)` → 会话卡徽标（文字 + CSS 类 + 悬停说明）。
   - `tierNoteFor(agentId)` → 扇出弹窗档位选项旁的一句差异说明。

2. **`src/renderer/fanout/fanout.ts`**：档位下拉旁加一句随选中 agent 变的说明（`.fanout-tier-detail`），与已有的「选哪个 agent」提示并列。claude/opencode 一句、codex 一句、dsh 一句，各是一行。

3. **`src/renderer/main.ts`**：会话卡徽标行加「闸门是否武装」徽标（绿=已武装 / 橙=未武装 / 灰=未知），悬停说明交代后果（codex autonomous → 审批面板会一直空）。

4. **`src/renderer/styles.css`**：新增 `.gate-armed` / `.gate-not-armed` / `.gate-unknown` 三色，以及 `.fanout-tier-detail`。

5. **顺手一致性修正**（同 lane）：`src/renderer/mock/data.ts` 的 mock codex `permissionBehavior` 从 `needs_config` 改为 `requests_by_default`，对齐第 14 轮 detect.ts 的新事实（Lane A 已把 codex 武装，快照里三家都 `requests_by_default`）；`smoke.ts` 的 R-4 断言随之更新（codex 并入「会主动请求授权」，只剩 dsh 归「不保证会问」）。

## 契约约束（honored）

契约里**没有**「某会话实际生效 mode」字段。本轮选择渲染层从 `agent + tier` 推导，而不是请 Lane A 加字段——推导集中在一个 helper 里，注释标明要与 `session/manager.ts` 同步。若未来要做得绝对准（例如感知 `BUMIMANG_ARM_OPENCODE=off` / `BUMIMANG_ARM_CODEX=off` 这两个渲染层看不到的环境变量），需要 Lane A 加字段，届时再走 docs/requests/。本轮**未追加** BLOCKED（推导 + 同步注释已满足 R-5 的需求；若后续想要「每会话实际生效 mode」再另立请求）。

## 验证

- **纯逻辑**：`node apps/desktop/src/renderer/smoke.ts` ALL PASS（新增 R-5 一节 12 条断言：`sessionGateArmed` 六组合、`gateBadge` 三态文案、`tierNoteFor` 四家 + 未知降级）。
- **Electron 真实桥**：新增 `apps/desktop/electron/tier-asymmetry-verify.ts`，受控合成快照（6 个会话覆盖 agent × tier 组合）+ 真实 preload/ipcRenderer 通道，**24/24 ALL_PASS**：
  - 会话卡：claude/opencode 两档 + codex guarded → `闸门已武装`；codex autonomous → `闸门未武装`（含悬停说明）；dsh → `闸门未知`。
  - 扇出弹窗：选中 claude/opencode → 「两档都会请求授权 + 转人工」；选中 codex → 「决定它问不问 + 审批面板会一直空」，且与 claude 不同。
  - 崩溃/泄漏：render-process-gone 空、console error 空、无 `undefined` 字面量。
- **截图**：
  - `docs/logs/tier-asymmetry-sessions.png`（会话卡三态徽标并排）
  - `docs/logs/tier-asymmetry-fanout-codex.png`（扇出弹窗选中 codex 的档位说明）
  - 证据 JSON：`docs/logs/tier-asymmetry-verify.json`

## 已知局限（不阻塞）

- 渲染层拿不到 `BUMIMANG_ARM_OPENCODE=off` / `BUMIMANG_ARM_CODEX=off` 这两个环境变量，所以徽标是「按 agent + tier 推导」的理论状态，不是「运行时实测」状态。要绝对准需要 Lane A 在快照里加「每会话实际生效 mode」（本轮按约束未自行加字段）。
- dsh 在扇出弹窗里被灰显（不可选），所以它的档位说明只在 helper 层存在、UI 上不可见；这是正确行为（选不了就没必要解释档位）。
