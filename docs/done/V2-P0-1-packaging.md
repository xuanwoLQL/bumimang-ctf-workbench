# V2-P0-1 · 可部署打包与技能库分发

> 日期：2026-10-25 · 范围：`package.json`、`apps/desktop/src/main/skill/*`、`skill-builtin/**`、契约/UI/测试。
> 证据：`evidence/v2-p0-1/`、`evidence/v2-baseline/p1-*.log`。

## 1. 做了什么

1. 新增 `skill-builtin/`：107 个文件、约 1.36MB。
   - `ctf-0day`：`SKILL.md`、`知识库/**`、5 个自有脚本（webbrute / iphdr_matrix / react2shell / selfcheck / 台账模板）+ `script-index.jsonl`。
   - `ctf-solver`：`SKILL.md`、`AI-SEARCH-INDEX.md`、`PAYLOAD-CHEATSHEET.md`、10 个 `.idx.md`、`SCRIPTS-INDEX.md`、`LICENSE`。
   - **不打包**：`CTF大赛WP集合/**`、`WP汇总/**`、`外部参考/**`、`hbc.py`、`des_ctf_sync.py`（第三方 WP 全文与平台接口脚本）。
2. `package.json` `extraResources` 增加 `skill-builtin → resources/app-source/skill`。
3. `SkillStatus` 增加 `source`（env/config/dev/packaged）；`HubSnapshot.skill.source` 可选字段。
4. 渲染层技能库状态显示来源：内置（安装包）/ 外置（env/config）/ 开发态 / 来源未知。
5. 简报 `skill_routing.note` 在 packaged 时明确写“内置最小库；若某路径缺失，用 skill_search 或配置外置完整库”。
6. 更新过时测试：
   - `verify-reliability` C4 从“skill 不打包”改为“内置 skill 必须打包且关键文件存在、排除项生效”。
   - `verify-skills` 新增 F2：内置包索引 97 docs / 5 scripts / wps 0；打包态 source=packaged。

## 2. 验证（真实输出）

| 项 | 结果 |
|---|---|
| `npm run verify:skills` | **160/160**（新增 F2 11 条） |
| `npm run verify:reliability` | **47/47**（C4 改为 3 条打包断言） |
| `npm run pack:dir` | exit=0；`dist/win-unpacked/resources/app-source/skill` 存在，**107 个文件** |
| 打包态 `--verify` | **26/26** |
| 打包态 skill 解析 | `resolution {root: ...resources/app-source/skill, source: "packaged"}`；索引 `docs=97, scripts=5, files=107, wps=0` |
| 打包态外置覆盖 | `BUMIMANG_SKILL_DIR=D:/agent/skill` → `source=env`，完整库 `docs=108, wps=1027, scripts=110` |
| P0-1 阶段 `verify:all` | **722 PASS / 0 FAIL**（当时尚未并入 answers/strategy/ir） |
| NSIS/绿色包 | 13:41 构建成功；但源码在之后继续修改，**最终包在 P0-6 重打** |

原始日志：`evidence/v2-baseline/p1-skills.log`、`p1-reliability.log`、`p1-pack-dir.log`、`p1-packaged-verify.log`、`p1-packaged-skill-index.log`、`evidence/v2-p0-1/*.log`。

## 3. 已知限制

- **干净 Windows VM 验证：BLOCKED**。当前机器不是干净环境，没有 VM；不能声称“队友机器首次安装已验证”。
- 内置包只含索引/自有知识库，不含第三方 WP 全文；`ctf-solver/*.idx.md` 指向的全文可能缺失，`skill_read` 会返回可读错误。深度检索需配置外置完整库。
- 内置包 `wps=0` 是预期行为；没有 `wp-index.jsonl`。
- 外置 `BUMIMANG_SKILL_DIR` 指向不存在目录时仍直接报错，不静默回退（保留旧语义）。

## 4. 下一步

P0-6 重打 NSIS/绿色包；在干净 VM 上走“安装→启动→索引→建任务→起 fake session→skill_search”；没有 VM 则继续写 BLOCKED。
