# B-3 续：武装 codex 的闸门（用 ACP 原生 mode，零配置文件）

> 完成时间：2026-10-13 07:37

## 做了什么

用户说"你改吧"，于是把第三家接上。**结论：codex 的闸门可以用 ACP 原生的 session mode 打开，连环境变量都不需要。**

### 怎么找到的

先只读探 `codex-acp` 的 bundle，发现它内部有个 `AgentMode` 概念，带着 `approvalPolicy` / `sandboxPolicy`。顺着这条线看它的 `session/new` 返回，果然把审批策略暴露成了 ACP 的 modes：

| mode | 它的描述 |
| --- | --- |
| `read-only` | Requires approval to edit files and access the internet. |
| `workspace-write` | Edit workspace files; ask before writing outside the workspace or network. |
| `agent` | Auto review —— 只问"被判定为潜在不安全"的动作（**这是默认值**） |
| `agent-full-access` | Unrestricted access |

默认的 `agent` 是"自动复核"，普通写文件不算不安全。这就是之前实测 codex `request_permission=0` 的原因。

### 实测（`npm run verify:arm-codex`）

| mode | request_permission | tool_call |
| --- | --- | --- |
| `read-only` | **1** | 2 |
| `workspace-write` | 0 | 1 |
| `agent`（默认） | 0 | 1 |
| **via-app（guarded 档）** | **1** | 2 |

**只有 `read-only` 会真的问**，而且走应用自己的路径也生效。

### 实现：档位映射到原生 mode

`guarded` → `read-only`（唯一的硬闸门）；`autonomous` 不动（保持它的默认 `agent`，即"自己判断着做"）。用我已经有的 `setConfigOption` 调 `session/set_config_option`——**不需要新方法、不需要配置文件、不需要环境变量**。关掉：`BUMIMANG_ARM_CODEX=off`。

## 改了哪些文件

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/src/cli/verify-arm-codex.ts` | 四场景探针（三种 mode + via-app），新 |
| `apps/desktop/src/main/session/manager.ts` | guarded 档下把 codex 切到 `read-only` |
| `apps/desktop/src/main/discovery/detect.ts` | codex 的 `permissionBehavior` 改成 `requests_by_default`，并把字段语义再明确一次 |
| `apps/desktop/src/main/electron/main.ts` | UI 验收断言改成"三家都要有审批输入" |
| `package.json` | 新增 `npm run verify:arm-codex` |

## 怎么验证的

```powershell
cd D:\agent\xuanwo
npm run verify:arm-codex
node_modules\electron\dist\electron.exe apps\desktop\src\main\electron\main.ts --no-sandbox --verify
```

UI 自检真实输出（**11/11**）：

```
PASS  快照标出三家的审批输入能力（claude 原生 / opencode 注入配置 / codex 切 read-only）
      — 会有审批输入=["opencode","codex","claude"] 需配置=[]
[verify] 11/11 通过
```

## 没做什么 / 已知问题

1. **"三家都能武装"是实测的，但每家只测了一次。** 有随机性（昨晚吃过单次测量的亏）；要当规律需多跑几次。
2. **`read-only` 相当严。** 它连写文件都要问，所以 guarded 档下的 codex 会频繁打断人。这是刻意的（guarded 就该严），但实战发现太吵时可以退到别的办法——**这是一个需要实战校准的取舍点，不是缺陷**。
3. **`workspace-write` 与 `agent` 实测都不问。** 这值得记住：它们的描述看起来像会问（"ask before writing outside the workspace"），但实测没触发（可能因为让它写的文件在工作区内）。
4. **dsh 仍是 unknown**（适配器未安装）。
5. **一条不对称，需要 UI 说清**：对 claude / opencode，档位只决定"问了之后要不要人工放行"；对 codex，档位**决定它问不问**。同一个"档位"在三家之间语义不同。
6. **没测 `read-only` 下 codex 能否完成完整任务。** 它每次都问、我们每次放行，理论上能做完，但没跑过。

## 下一手需要什么

- 若要四家齐全：装 `@deepseek-ai/dsh-acp`（RC，未获授权安装）后按同样方式探。
- UI 上说清第 5 条那个不对称（需要 Lane B）。
- 无待用户决策事项。
