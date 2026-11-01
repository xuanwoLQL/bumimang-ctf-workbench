/**
 * 题型 × 角色的检查表（P2-B）。
 *
 * 纯数据表：不读技能库、不读黑板、不做 I/O。briefing/build.ts 用
 * `task.category + role` 取一份 10–20 条的 checklist 与常见坑。
 *
 * 设计取舍：不把 8×4 份 checklist 全文抄 32 遍，而是「题型基础检查表（12–14 条）
 * + 角色叠加（4 条）」拼装；这样每个组合都有 16–18 条，角色差异明确，数据也易于维护。
 */

import type { TaskCategory } from "../../../../../packages/shared-protocol/events.ts";

export const PLAYBOOK_ROLES = ["lead", "verify", "recon", "scribe"] as const;
export type PlaybookRole = (typeof PLAYBOOK_ROLES)[number];

export interface Playbook {
  category: TaskCategory;
  title: string;
  steps: string[];
  pitfalls: string[];
}

const MAX_STEPS = 20;
const MIN_STEPS = 10;

const CATEGORY_TITLES: Record<TaskCategory, string> = {
  web: "Web 单题检查表",
  misc: "Misc 杂项检查表",
  crypto: "Crypto 密码学检查表",
  reverse: "Reverse 逆向检查表",
  pwn: "Pwn 二进制利用检查表",
  pentest: "渗透测试检查表",
  ir: "应急响应检查表",
  awd: "AWD 攻防检查表",
  unknown: "通用解题检查表",
};

const KNOWN_CATEGORIES = new Set<TaskCategory>([
  "web",
  "misc",
  "crypto",
  "reverse",
  "pwn",
  "pentest",
  "ir",
  "awd",
  "unknown",
]);

/** 把任意字符串收敛成契约里的 9 个分类之一；未知一律 unknown。 */
export function normalizeCategory(value: unknown): TaskCategory {
  return typeof value === "string" && KNOWN_CATEGORIES.has(value as TaskCategory)
    ? (value as TaskCategory)
    : "unknown";
}

const CATEGORY_STEPS: Record<TaskCategory, string[]> = {
  web: [
    "确认 flag 格式、提交方式与题面限制（方法、参数名、回显长度）",
    "指纹：响应头、框架报错、favicon、默认文件、版本号",
    "目录与源码泄漏：robots.txt、备份文件、.git/.svn、www.zip",
    "参数面：GET/POST/JSON/XML、隐藏字段、数组/对象参数",
    "SQL 注入：布尔/时间盲注先手工确认，sqlmap 只做加速",
    "命令/代码执行：先用 id/whoami 这类无害命令验证",
    "文件上传：扩展名、Content-Type、魔术字节、解析后缀、竞争上传",
    "文件包含：本地/远程、伪协议、日志包含、session 文件包含",
    "SSRF：内网探测、协议族、重定向/短地址绕过（仅授权目标）",
    "SSTI：{{7*7}}、${7*7}、<%= 7*7 %> 分引擎验证",
    "JWT：none 算法、弱密钥、算法混淆、claim 篡改",
    "反序列化：PHP/Python/Java 链，先找入口与可控点",
    "代码审计：从路由到 sink 逆向追踪可控输入",
    "每个成功 payload 与回显立即写入 evidence/",
  ],
  misc: [
    "确认附件类型与 flag 格式",
    "文件识别：file/xxd/strings/binwalk，先看文件头",
    "图片：EXIF、LSB、通道、宽高爆破、CRC 修复",
    "音频：波形/频谱、LSB、DTMF、摩斯",
    "压缩包：伪加密、CRC 爆破、已知明文、字典",
    "流量：协议分层、导出对象、追踪流、tshark 过滤",
    "内存镜像：Volatility 镜像信息→进程→网络→文件",
    "编码链：base/hex/url/rot/unicode 逐层解",
    "隐写工具输出要落盘，避免只在终端看一眼",
    "关注题面提示词、文件名、时间戳等元信息",
    "多解交叉验证：换工具确认同一结论",
    "flag 候选写入黑板，但等待人工确认",
  ],
  crypto: [
    "先分类：编码/古典/现代/数学/协议",
    "收集参数：n/e/c、曲线、模数、随机数来源",
    "常见弱密钥：小 e、共模、低加密指数、p/q 接近",
    "古典密码：频率分析、词表、已知明文",
    "编码题：逐层识别并保留中间结果",
    "RSA：分解、广播、相关消息、填充 oracle",
    "对称：模式/IV/nonce 复用、padding oracle",
    "哈希：长度扩展、碰撞、盐值复用",
    "格/数学题：先验证小规模，再上脚本",
    "脚本参数与输出写入 evidence/，保留随机种子",
    "用现成脚本前先读输入输出约定",
    "结论必须能被第二次运行复现",
  ],
  reverse: [
    "文件类型/架构/加壳检测（file、DIE、strings）",
    "动态优先：跑起来看输入输出与报错",
    "静态：入口、主函数、字符串交叉引用",
    "关键比较点：断点/日志/打补丁验证",
    "反调试/反虚拟机：先识别再绕过",
    "语言识别：Native/.NET/Python/Java/Go",
    "脚本类：pyc/字节码/打包器解包",
    "算法还原：输入→变换→比较，写等价脚本",
    "约束求解：angr/Z3 先做小范围验证",
    "保留原始样本与补丁副本，不覆盖",
    "每次运行记录命令与输出到 evidence/",
    "flag 格式与题面核对后再提交",
  ],
  pwn: [
    "文件类型/架构/保护（checksec：NX/PIE/Canary/RELRO）",
    "跑起来看交互协议与崩溃点",
    "找输入点与偏移（cyclic/pattern）",
    "溢出/格式化字符串/堆漏洞分类",
    "泄露地址：puts/write/格式化",
    "构造 ROP/ret2libc/one_gadget",
    "堆题：分配/释放/编辑/展示原语",
    "沙箱/seccomp：先确认可用 syscall",
    "远程交互脚本化（pwntools），本地先打通",
    "每次 exploit 输出与偏移写入 evidence/",
    "远端不稳定时加重试与日志",
    "拿到 shell 后先找 flag，再考虑其他动作（授权范围内）",
  ],
  pentest: [
    "明确授权范围/目标清单/禁止动作",
    "信息收集：端口、服务、版本、指纹",
    "Web 打点：目录、弱口令、已知漏洞、中间件",
    "国产系统/中间件专项检查",
    "拿到初始权限后先确认身份与网络位置",
    "提权：Linux/Windows 分别按检查表",
    "凭据收集与复用（授权范围内）",
    "内网横向：先测绘再打，避免惊动",
    "每台目标登记租约，避免多人同时打崩",
    "关键动作前过策略/审批，不绕过",
    "命令回显与截图路径写入 evidence/",
    "事实与死路及时写黑板，减少重复",
    "flag 位置按题型约定搜索",
    "不自动提交 flag，等待人工确认",
  ],
  ir: [
    "接管前先确认授权与取证只读原则",
    "记录当前时间、主机、账号、网络状态",
    "日志：系统/应用/Web/安全日志，先备份再分析",
    "时间线：登录、进程、文件、网络四线对齐",
    "Webshell 排查：最近修改文件、异常内容、访问日志",
    "进程与服务：可疑父进程、隐藏进程、计划任务",
    "持久化：服务、注册表、启动项、cron、SSH key",
    "账号：新增用户、提权、远程登录记录",
    "网络：连接、监听端口、DNS、代理、隧道",
    "内存：内存马、注入模块、可疑句柄",
    "流量：PCAP 分析外联与数据外传",
    "勒索/挖矿：样本、钱包地址、加密后缀",
    "每条结论带证据路径与命令，区分 E1/E2",
    "按问题清单逐题作答，答案格式与题面一致",
  ],
  awd: [
    "开赛先备份源码/数据库/配置",
    "服务清单与端口映射，确认每轮 flag 轮换方式",
    "防守：改默认口令、关不必要入口、上 WAF/规则",
    "修漏洞前先留原始副本，避免修坏服务",
    "每轮检查 flag 是否被拿走，记录轮次",
    "攻击：批量检测同类服务，payload 复用要改目标",
    "拿 flag 后立即人工提交/记录，不自动提交",
    "补丁台账：改了什么、何时、影响哪个服务",
    "监控：异常登录、webshell、外联",
    "与队友分工，服务级租约避免互相覆盖",
    "所有命令与回显落 evidence/，按轮次命名",
    "比赛结束前复核未提交 flag 与失分点",
    "不攻击范围外目标，不做破坏性动作",
  ],
  unknown: [
    "先读题面/附件/提示，确认 flag 格式与提交方式",
    "识别题型：Web/Misc/Crypto/Reverse/Pwn/渗透/应急/AWD",
    "列出已知信息与未知信息，写进黑板",
    "从最小可验证假设开始，一次只改一个变量",
    "先用只读/无害命令探测，再考虑利用",
    "检索同类 WP 与现成脚本，但必须本地复现",
    "关键输出落盘 evidence/，witness 用相对路径",
    "失败路径写 dead_end，避免队友重复",
    "每 3 个工具调用读一次黑板增量",
    "拿到 flag 候选先核对格式，再请人工确认",
    "卡住时换题型视角或换工具，不硬耗",
    "收尾时整理结论、证据与未解问题",
  ],
};

const ROLE_STEPS: Record<PlaybookRole, string[]> = {
  lead: [
    "先写清本题分工：谁打哪个面、谁验证、谁记录，避免两人撞同一路径",
    "把当前假设与下一步写进黑板 intent，再开始调用工具",
    "每 3 个工具调用读一次黑板增量，及时吸收队友的死路",
    "首答出现后只保留验证者，其余人停止重复劳动",
  ],
  verify: [
    "对队友的结论做独立复现：换一条命令/路径确认，不照抄",
    "把可核验的产物落到 evidence/，witness 用任务目录相对路径",
    "区分 E1（有见证）与 E2（文件内容含 flag/事实），不虚报证据等级",
    "发现结论不成立时写 dead_end，而不是沉默放弃",
  ],
  recon: [
    "先做只读侦察：端口、服务、目录、指纹，不急着打",
    "把资产清单与版本号写成事实，带 witness",
    "对同一目标避免并发扫描；需要独占时先申请租约",
    "侦察结果按“已确认/待验证”分开记录",
  ],
  scribe: [
    "维护台账：时间、命令、回显路径、结论、证据等级",
    "把命令回显写入 evidence/<name>.txt，命名可读",
    "flag 候选只记录不自动确认，等待人工核对",
    "整理时间线/攻击链，供 lead 决策与赛后复盘",
  ],
};

const CATEGORY_PITFALLS: Record<TaskCategory, string[]> = {
  web: ["只看回显不落盘，最后无法证明", "在未授权目标上测试 payload", "重复队友已经试过的 payload", "忽略 WAF/编码导致的假阴性"],
  misc: ["只在一个工具里看到结果就下结论", "破坏原始附件（应先复制）", "忽略文件头/时间戳等元信息"],
  crypto: ["脚本随机性导致结果不可复现", "忽略小规模验证直接上大数", "把编码层数搞错还反复重试"],
  reverse: ["直接打补丁覆盖原样本", "只静态看字符串不动态验证", "忽略反调试导致的假路径"],
  pwn: ["本地通远端不通（libc/环境差异）", "偏移未复核导致随机崩溃", "在未授权目标上跑 exploit"],
  pentest: ["超出授权范围扫描/利用", "多人同时打同一目标把它打挂", "拿到权限后不留证据路径"],
  ir: ["直接改动被入侵主机（应先取证）", "只看单一日志下结论", "把推测写成已确认事实"],
  awd: ["修漏洞把服务修挂", "忘记备份原始文件", "自动提交 flag 或攻击范围外目标"],
  unknown: ["长时间卡在一个假设上", "不写黑板导致重复劳动", "拿到疑似 flag 不核对格式"],
};

const ROLE_PITFALLS: Record<PlaybookRole, string> = {
  lead: "同时开太多方向，没人收尾",
  verify: "照抄队友结论，没有独立复现",
  recon: "无脑全端口扫描，惊动目标/超时",
  scribe: "只记结论不记命令与回显路径",
};

function isPlaybookRole(role: string): role is PlaybookRole {
  return (PLAYBOOK_ROLES as readonly string[]).includes(role);
}

/** 取某题型 + 角色的检查表。未知题型回落通用；未知角色只给题型基础表。 */
export function getPlaybook(category: unknown, role: string): Playbook {
  const cat = normalizeCategory(category);
  const roleSteps = isPlaybookRole(role) ? ROLE_STEPS[role] : [];
  const pitfalls = [
    ...CATEGORY_PITFALLS[cat],
    ...(isPlaybookRole(role) ? [ROLE_PITFALLS[role]] : []),
  ].slice(0, 6);
  let steps = [...CATEGORY_STEPS[cat], ...roleSteps].slice(0, MAX_STEPS);
  // 结构上不会低于 MIN_STEPS（最短的题型基础表也有 12 条），这里只做防御。
  if (steps.length < MIN_STEPS) steps = [...steps, ...CATEGORY_STEPS.unknown].slice(0, MIN_STEPS);
  return { category: cat, title: CATEGORY_TITLES[cat], steps, pitfalls };
}
