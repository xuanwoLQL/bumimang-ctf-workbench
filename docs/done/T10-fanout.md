# T10 加号扇出交互

## 做了什么

点加号弹扇出弹窗：选 agent + 角色（lead/verify/recon/scribe）+ 档位（guarded/autonomous）+ 可选模型，确认后发出 `hub:action`（`session.start`）；另带「一键扇出（三引擎）」预设。未安装的 agent 灰显。关键取舍：所有选择都通过 `fanout/model.ts` 的纯函数拼成契约动作，DOM 层零业务逻辑。

## 改了哪些文件

```
apps/desktop/src/renderer/fanout/model.ts     buildStartAction / buildPresetActions / 角色档位常量
apps/desktop/src/renderer/fanout/fanout.ts    扇出弹窗（agent/角色/档位/模型/预设）+ 取消/Esc（DOM）
apps/desktop/src/renderer/main.ts             左栏加号按钮接 openFanoutModal
```

## 怎么验证的

```powershell
cd D:\agent\xuanwo
node apps/desktop/src/renderer/smoke.ts
```

真实输出（T10 段）：

```
== T10 加号扇出 · 动作构造 ==
PASS  buildStartAction 形状正确
PASS  一键扇出 = 3 个动作  └─ count=3
PASS  预设覆盖三引擎  └─ agents=codex,claude,opencode
```

Mock 集成段同时验证了 `dispatch(session.start)` 返回 `{"ok":true}` 并触发 `session.upsert`，即「点加号 → 新会话出现」的闭环在进程内 mock 下成立。

## 没做什么 / 已知问题

1. **任务创建不在本轮**：扇出依赖已有 task，若没有任务只会禁用确认按钮并提示，`task.create` 的输入界面没做（不在 T6–T10 范围，是左栏任务树后续的事）。
2. **模型字段只是透传**：契约里模型选择走 ACP `session/set_config_option`（§6 已知坑），那是 Lane A 的会话/策略层职责；扇出只把可选的 `model` 字符串塞进 `session.start`。
3. 「一键扇出」预设是硬编码的 codex+claude+opencode 三引擎；按 agent 实际安装情况自动挑选没做。

## 下一手需要什么

- Lane A 的会话管理器（T2/会话扇出）消费 `session.start`。mock 下已能验证动作形状与事件回放，真实扇出等 A。
