# D-V3-1：IR 工具解析优先级与真实状态语义

> 2026-10-25 · V2.1 Reality Gate 决策记录。

## 1. 工具解析优先级

`BUMIMANG_IR_TOOLS_CONFIG` 显式文件 > 用户级 `%APPDATA%\bumimang\ir-tools.json` > 开发态 `config/ir-tools.json`（仅开发态）> `BUMIMANG_*` 环境变量 > PATH。

理由：

- 用户机器上工具在非 PATH 目录（Wireshark / EvtxECmd / Volatility venv），必须显式配置。
- 配置是**数据**，不是代码；`apps/desktop/src` 不含任何盘符硬编码。
- 发行包只带 `config/ir-tools.example.json`（空值/占位），不带开发机绝对路径；用户复制到 `%APPDATA%\bumimang\ir-tools.json` 或设 env。
- 打包态不读取 `resources/app-source/config/ir-tools.json`，避免安装包被开发机目录绑死。
- 用户级配置不存在不是错误，继续走 env/PATH；存在但路径错误才 PATH_ERROR。
- 显式配置/环境变量指向不存在路径时返回 `PATH_ERROR`，**不静默回退**；Doctor 显示实际读取的配置文件路径与 source（explicit/userData/dev）。

## 3. 真实状态语义

| 状态 | 含义 |
|---|---|
| `REAL_PASS` | 真实工具 + 真实样本 + 真实进程 + 真实解析结果通过 |
| `FIXTURE_PASS` | 仅 fixture/mock 通过；`verify:ir` 输出明确标注，不计入真实结果 |
| `REAL_SKIP` | 工具或样本不存在/不适用；明确记录原因，不能算 PASS |
| `REAL_FAIL` | 工具/样本存在，但执行/参数/解析/断言失败；exit 非 0 |

`--require-real`：required = evtx/pcap/memory；optional = yara。evtx/pcap/memory 任一不是 REAL_PASS 或任何 REAL_FAIL → exit 非 0。YARA 未接入时 REAL_SKIP 不影响 require-real。

普通 `verify:ir-real`：REAL_SKIP 可 exit 0，但汇总必须写 `PARTIAL`（不是 PASS）；任何 REAL_FAIL 始终 exit 非 0。

## 4. YARA 边界

YARA 独立工具存在（python + wrapper），但平台没有 YARA 分析器/流程；状态 `AVAILABLE_NOT_INTEGRATED`，不计入真实通过。只有真正接入并经真实文件扫描后才能改状态。

## 5. 内存边界

只有真实 Windows 内存镜像跑通 `windows.pslist`/`windows.netscan` 且解析 >0 进程/连接，才能 REAL_PASS。Kali VM vmem 不是 Windows 镜像，不能用于该断言；没有 Windows 镜像时 REAL_SKIP/BLOCKED。

## 6. EVTX 解析细节

- EvtxECmd CSV 表头可能有 `UserName` / `Username` / `UserId`；解析器逐行回退，避免 UserName 空导致账号丢失。
- CSV 使用引号/逗号/空值；解析器按 CSV 规则处理，不按 `split(",")`。
- 0 条记录不能算真实通过；必须 CSV 数据行 >0 且平台解析 timeline/fact >0。

## 7. PCAP 解析细节

- 生产与真实烟测共用 `buildTsharkArgs`（字段顺序一致）。
- 使用 `-E separator=, -E quote=d`；解析器支持双引号、`""`、`\,`、`\\`，避免 URI 逗号/空字段错位。
- tshark exit=0 但平台解析 0 行 → REAL_FAIL。
