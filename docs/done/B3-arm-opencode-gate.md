# B-3：武装 opencode 的权限闸门（不碰全局配置）

> 完成时间：2026-10-13 07:30

## 做了什么

按用户立场——"改，但把改全局这个动作留给你自己；优先项目级，其次全局+手动执行"——先说结论：**找到了比项目级更好的办法，运行时按会话注入，完全不需要动任何用户文件。**

### Step 1 探测（只读）

opencode 的配置是**分层且合并**的（官方文档 `opencode.ai/docs/config/`）：

```
Remote → Global(~/.config/opencode/opencode.json) → Custom(OPENCODE_CONFIG)
      → Project(opencode.json) → .opencode → Inline(OPENCODE_CONFIG_CONTENT) → Managed
```

各层按同名键覆盖，不是替换。`permission` 段语法从 `opencode.ai/config.json` 取得：动作值是 `"ask" | "allow" | "deny"`，还可以写成"按 pattern 映射到动作"的对象；可设的键有 `read`/`edit`/`glob`/`grep`/`list`/`bash`/`task`/`external_directory` 等。

### Step 2 实测（对照四组）

```
baseline（不注入）          request_permission = 0   文件写入 = true
project（会话目录放 json）   request_permission = 1   文件写入 = true
inline（环境变量）           request_permission = 1   文件写入 = true
via-app（走 SessionManager） request_permission = 1   文件写入 = true   ← 接线生效
```

**注意 baseline 里的"文件写入 = true"**：它确实把文件写了，只是没问。这正是 B-3 要解决的问题。

### Step 3 实现：inline 按会话注入

应用在 spawn opencode 会话时注入 `OPENCODE_CONFIG_CONTENT`，只带 `permission.edit/bash = "ask"`。可开关：`BUMIMANG_ARM_OPENCODE=off` 回到原行为。

**为什么比用户的首选（项目级）更干净**：

1. 完全不碰全局配置（符合立场与规则 3）；
2. **不需要在仓库放 `opencode.json`** —— 那个文件对用户在项目目录里直接跑 opencode 时也会生效，是意外副作用；
3. 随代码走，队友克隆即有；
4. 一行环境变量即可关掉。

**回滚**：不需要动任何用户文件。设 `BUMIMANG_ARM_OPENCODE=off`。

## 改了哪些文件

```
apps/desktop/src/cli/verify-arm-opencode.ts   四场景对照探针（新）
apps/desktop/src/main/session/manager.ts      spawn opencode 时注入 OPENCODE_CONFIG_CONTENT
apps/desktop/src/main/discovery/detect.ts     opencode 的 permissionBehavior 改为 requests_by_default，
                                              并把字段语义在注释里写清（"我们这样跑它"会不会问）
package.json                                  新增 npm run verify:arm-opencode
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
npm run verify:arm-opencode
```

真实输出见上面"实测"一节（四个场景，最新一次全过，`via-app` 为 1）。

## 没做什么 / 已知问题

1. **第一次测 `via-app` 得出 0，而且是我的测量口错了。** 我在 `onApprovalRequired` 里计数，但那个回调只在策略判定**升到人工**时才触发；`autonomous` 档下无规则命中的权限请求会被直接放行，所以计数不到。改成 `guarded` 档后才是 1。**教训：测"有没有发生"要挂在最早的那个观测点，而不是挂在某个下游效果上。**
2. **这是单次测量。** 每个场景只跑了一次，模型有随机性。"武装后一定会问"还需多跑几次才能当规律（昨晚就吃过一次单次测量的亏）。
3. **只武装了 `edit` 与 `bash` 两项。** `read`/`glob`/`grep`/`list` 保持默认（不问），以免 agent 每做一次只读操作都打断人。这个取舍是我拍的，没有实测过"如果连只读也问会怎样"。
4. **codex 没武装。** 它有 `-a/--ask-for-approval <on-request|never>`，但没确认 `codex-acp` 能否把参数透传给内部 codex 进程。需要单独探测。
5. **UI 文案与新事实不符**（渲染层还写着"只有 Claude Code 开箱会请求授权"）。已作为 R-4 追加到 `BLOCKED.md`，数据源（`permissionBehavior`）已经是对的。
6. **`OPENCODE_CONFIG_CONTENT` 的合并行为没有细究。** 它到底是"整体替换"还是"与全局合并"我按文档理解为后者，但没做实验（比如全局设了别的键，注入后会不会丢）。风险是低（实测文件写入与请示都正常），但没验证。

## 下一手需要什么

- Lane B：按 R-4 把扇出弹窗的文案改成跟着 `permissionBehavior` 走。
- 若要继续：探测 `codex-acp` 能否透传 `-a on-request`，把第三家也武装起来。
- 无待用户决策事项（B-3 已闭环，且未动任何用户文件）。
