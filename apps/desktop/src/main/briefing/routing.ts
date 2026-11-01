/**
 * 技能库路由（P2-B）。
 *
 * 输入：题型 + 角色（+ 技能库是否配置/根目录/包名）。
 * 输出：该题型常见路径的**提示**（path + title + when），只给路由不塞全文。
 *
 * 约束：
 *  - 纯数据表，不读真实技能库；路径相对技能库根。
 *  - 不擅自扩 docs 索引：ctf-solver 根目录的 SSTI.md 等主题全文不在 index.ts 的
 *    docs 里，这里仍可以给路径提示；agent 用 skill_read 读，skill_search 不会返回它。
 *  - 未配置技能库时明确写“无技能库”，不静默降级。
 */

import type { TaskCategory } from "../../../../../packages/shared-protocol/events.ts";
import { normalizeCategory } from "./playbooks.ts";

export interface SkillSuggestion {
  /** 相对技能库根的 POSIX 路径。 */
  path: string;
  title: string;
  when: string;
}

export interface SkillRoutingPackage {
  name: string;
  path: string;
  why: string;
}

export interface SkillRouting {
  root: string | null;
  packages: SkillRoutingPackage[];
  suggestions: SkillSuggestion[];
  note?: string;
}

export interface SkillRoutingInput {
  category: unknown;
  role: string;
  configured: boolean;
  root?: string | null;
  /** SkillRuntime.status().packages；未传时按题型给默认包。 */
  packages?: string[];
  /** V2-P0-1：技能库来源；packaged 时明确提示“内置最小库”。 */
  source?: "env" | "config" | "dev" | "packaged" | null;
}

const PACKAGE_WHY: Record<string, string> = {
  "ctf-solver": "经典 CTF 单题：Web/Misc/Crypto/Reverse/Pwn 知识与 WP/脚本索引",
  "ctf-0day": "授权靶场渗透 / 应急响应 / AWD 双线手册",
};

function s(path: string, title: string, when: string): SkillSuggestion {
  return { path: `skills/${path}`, title, when };
}

const CATEGORY_SUGGESTIONS: Record<TaskCategory, SkillSuggestion[]> = {
  web: [
    s("ctf-solver/SSTI.md", "SSTI 全文", "怀疑模板注入时；根目录全文不在检索索引里，按此路径 skill_read"),
    s("ctf-solver/SQL.idx.md", "SQL 注入索引", "确认注入点后按方向精读"),
    s("ctf-solver/文件上传漏洞.idx.md", "文件上传索引", "有上传入口时"),
    s("ctf-solver/文件包含.idx.md", "文件包含索引", "参数像文件名/路径时"),
    s("ctf-solver/SSRF漏洞.idx.md", "SSRF 索引", "服务端代为请求 URL 时"),
    s("ctf-solver/JWT.idx.md", "JWT 索引", "看到 token/cookie 时"),
    s("ctf-solver/php代码审计.md", "PHP 代码审计", "有源码时从路由审到 sink"),
    s("ctf-solver/命令执行.md", "命令执行", "参数进入系统命令时"),
    s("ctf-solver/PAYLOAD-CHEATSHEET.md", "高频 payload", "需要快速对照 payload 时"),
  ],
  misc: [
    s("ctf-solver/图片隐写.idx.md", "图片隐写索引", "附件是图片时"),
    s("ctf-solver/音频隐写.md", "音频隐写", "附件是音频时"),
    s("ctf-solver/压缩包总结.idx.md", "压缩包攻击索引", "附件是 zip/rar/7z 时"),
    s("ctf-0day/知识库/图片隐写与损坏修复.md", "图片损坏修复", "图片打不开或 CRC 异常时"),
  ],
  crypto: [
    s("ctf-solver/AI-SEARCH-INDEX.md", "CTF 检索索引", "先定位题型与关键词"),
    s("ctf-solver/CTF常用脚本及工具/SCRIPTS-INDEX.md", "脚本索引", "需要现成加解密脚本时"),
    s("ctf-0day/知识库/题型图鉴.md", "题型图鉴", "判断是否伪装成 crypto 的杂项题"),
  ],
  reverse: [
    s("ctf-solver/CTF常用脚本及工具/reverse", "逆向脚本目录", "需要反编译/脱壳辅助脚本时"),
    s("ctf-0day/知识库/AI-Agent工具层逆向.md", "工具层逆向", "题目涉及 agent/插件/协议逆向时"),
    s("ctf-0day/知识库/题型图鉴.md", "题型图鉴", "判断逆向与 pwn/misc 的边界"),
  ],
  pwn: [
    s("ctf-solver/SKILL.md", "ctf-solver 入口", "先确认是否有 pwn 专项内容"),
    s("ctf-solver/AI-SEARCH-INDEX.md", "CTF 检索索引", "Pwn 知识库未单独收录，用检索找 WP/脚本"),
    s("ctf-solver/CTF常用脚本及工具/SCRIPTS-INDEX.md", "脚本索引", "需要 exploit/分析脚本模板时"),
  ],
  pentest: [
    s("ctf-0day/知识库/端口与服务速查.md", "端口与服务速查", "拿到目标后先做服务识别"),
    s("ctf-0day/知识库/打穿短表.md", "打穿短表", "需要快速打点路径时"),
    s("ctf-0day/知识库/内网横向.md", "内网横向", "拿到初始权限后"),
    s("ctf-0day/知识库/提权-Linux.md", "Linux 提权", "拿到 Linux shell 后"),
    s("ctf-0day/知识库/提权-Windows.md", "Windows 提权", "拿到 Windows shell 后"),
    s("ctf-0day/知识库/中间件漏洞.md", "中间件漏洞", "指纹命中中间件时"),
    s("ctf-0day/知识库/弱口令与爆破.md", "弱口令与爆破", "有登录入口时"),
    s("ctf-0day/知识库/系统指纹速查卡.md", "系统指纹速查卡", "需要快速判断 OS/中间件版本时"),
  ],
  ir: [
    s("ctf-0day/知识库/应急响应总纲.md", "应急响应总纲", "接管应急题先读"),
    s("ctf-0day/知识库/应急与取证通用判据.md", "通用判据", "每条结论定证据等级时"),
    s("ctf-0day/知识库/应急-Windows深度取证.md", "Windows 深度取证", "目标是 Windows 时"),
    s("ctf-0day/知识库/应急-勒索与钓鱼.md", "勒索与钓鱼", "出现加密/钓鱼样本时"),
    s("ctf-0day/知识库/应急-流量与隧道.md", "流量与隧道", "需要分析 PCAP/外联时"),
    s("ctf-0day/知识库/内存取证.md", "内存取证", "有内存镜像时"),
    s("ctf-0day/知识库/内存马排查.md", "内存马排查", "Web 服务异常但文件干净时"),
    s("ctf-0day/知识库/反取证-清痕迹与查痕迹.md", "反取证", "日志缺失/时间被篡改时"),
  ],
  awd: [
    s("ctf-0day/知识库/权限维持与AWD.md", "AWD 权限维持", "攻防两端都要读"),
    s("ctf-0day/知识库/比赛节奏与赛制.md", "比赛节奏与赛制", "开赛先确认轮次/flag 规则"),
    s("ctf-0day/知识库/打穿短表.md", "打穿短表", "攻击轮快速找入口"),
    s("ctf-0day/知识库/端口与服务速查.md", "端口与服务速查", "确认本队服务清单时"),
  ],
  unknown: [
    s("ctf-solver/SKILL.md", "ctf-solver 入口", "先判断是不是经典 CTF 单题"),
    s("ctf-0day/SKILL.md", "ctf-0day 入口", "怀疑是渗透/应急/AWD 场景时"),
    s("ctf-solver/AI-SEARCH-INDEX.md", "CTF 检索索引", "需要按关键词找知识/WP/脚本时"),
    s("ctf-0day/知识库/题型图鉴.md", "题型图鉴", "题型不明时先对照"),
  ],
};

const ROLE_SUGGESTIONS: Record<string, SkillSuggestion[]> = {
  lead: [
    s("ctf-0day/知识库/破局模型.md", "破局模型", "需要决定先打哪个方向时"),
    s("ctf-0day/知识库/比赛节奏与赛制.md", "比赛节奏与赛制", "安排分工与时间盒时"),
  ],
  verify: [
    s("ctf-solver/PAYLOAD-CHEATSHEET.md", "高频 payload", "核对 payload 是否与题型匹配时"),
    s("ctf-0day/知识库/应急与取证通用判据.md", "证据判据", "确认 E1/E2 与 witness 写法时"),
  ],
  recon: [
    s("ctf-0day/知识库/系统指纹速查卡.md", "系统指纹速查卡", "快速判断目标系统/服务时"),
    s("ctf-0day/知识库/端口与服务速查.md", "端口与服务速查", "规划扫描与识别顺序时"),
  ],
  scribe: [
    s("ctf-0day/scripts/台账模板.md", "台账模板", "需要记录命令、回显与结论时"),
    s("ctf-solver/CTF常用脚本及工具/SCRIPTS-INDEX.md", "脚本索引", "记录用过的脚本与参数时"),
  ],
};

function defaultPackages(category: TaskCategory): string[] {
  switch (category) {
    case "pentest":
    case "ir":
    case "awd":
      return ["ctf-0day"];
    case "web":
    case "misc":
    case "crypto":
    case "reverse":
    case "pwn":
      return ["ctf-solver", "ctf-0day"];
    default:
      return ["ctf-solver", "ctf-0day"];
  }
}

/**
 * 组装路由。未配置技能库时不抛错：返回明确说明 + 空建议。
 * suggestions 已按 path 去重（题型建议优先于角色建议）。
 */
export function buildSkillRouting(input: SkillRoutingInput): SkillRouting {
  const category = normalizeCategory(input.category);
  if (!input.configured) {
    return {
      root: null,
      packages: [],
      suggestions: [],
      note: "无技能库，使用 playbook 与已有工具",
    };
  }

  const packageNames = (input.packages && input.packages.length > 0
    ? input.packages
    : defaultPackages(category)
  ).filter((name, idx, arr) => arr.indexOf(name) === idx);
  const packages = packageNames.map((name) => ({
    name,
    path: `skills/${name}`,
    why: PACKAGE_WHY[name] ?? "技能包",
  }));

  const seen = new Set<string>();
  const suggestions: SkillSuggestion[] = [];
  for (const item of [
    ...CATEGORY_SUGGESTIONS[category],
    ...(ROLE_SUGGESTIONS[input.role] ?? []),
  ]) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    suggestions.push(item);
  }

  return {
    root: input.root ?? null,
    packages,
    suggestions,
    note:
      input.source === "packaged"
        ? "内置最小技能库：含路由/自有知识库/脚本索引，不含第三方 WP 全文；若某路径 skill_read 报 missing，改用 skill_search 或配置外置完整技能库"
        : "路径相对技能库根；先用 skill_search 检索，确认命中后再 skill_read 精读全文",
  };
}
