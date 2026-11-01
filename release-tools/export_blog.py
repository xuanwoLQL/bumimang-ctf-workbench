#!/usr/bin/env python3
"""Export the public project page and sanitized NEST 2026 posts into Hugo."""

from __future__ import annotations

import argparse
import re
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path


DIRECTION = {
    "web-": "Web",
    "pwn-": "Pwn",
    "crypto-": "Crypto",
    "misc-": "Misc",
    "reverse-": "Reverse",
}


def yaml_list(values: list[str]) -> str:
    def quote(value: str) -> str:
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

    return "[" + ", ".join(quote(value) for value in values) + "]"


def yaml_scalar(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def front_matter(
    *,
    title: str,
    slug: str,
    description: str,
    when: datetime,
    direction: str | None = None,
    cover: str | None = None,
) -> str:
    tags = ["CTF", "强网拟态", "不迷茫"]
    if direction:
        tags.append(direction)
    lines = [
        "---",
        f"title: {yaml_scalar(title)}",
        f"slug: {yaml_scalar(slug)}",
        f"date: {when.isoformat()}",
        f"lastmod: {when.isoformat()}",
        "draft: false",
        'author: ["xuanwo"]',
        f"description: {yaml_scalar(description)}",
        f"tags: {yaml_list(tags)}",
        'categories: ["CTF Writeup", "第九届强网拟态"]',
        'series: ["第九届强网拟态 2026"]',
        "ShowToc: true",
        "TocOpen: false",
        "hidemeta: false",
        "comments: false",
    ]
    if cover:
        lines.extend(["cover:", f"  image: {yaml_scalar(cover)}", "  relative: false"])
    lines.append("---")
    return "\n".join(lines) + "\n"


def title_of(text: str, fallback: str) -> tuple[str, str]:
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.startswith("# "):
            title = line[2:].strip()
            return title, "\n".join(lines[index + 1 :]).lstrip()
    return fallback, text


def direction_of(path: Path) -> str:
    for prefix, direction in DIRECTION.items():
        if path.name.startswith(prefix):
            return direction
    raise ValueError(f"unknown direction: {path.name}")


def copy_images(repo: Path, blog: Path) -> dict[str, str]:
    out_dir = blog / "static" / "images" / "projects" / "bumimang"
    out_dir.mkdir(parents=True, exist_ok=True)
    mapping = {
        "workbench.png": repo / "ctf/nest-2026/evidence/workbench.png",
        "platform-rank.png": repo / "ctf/nest-2026/evidence/platform-rank.png",
        "smart-surveillance-board.png": (
            repo / "ctf/nest-2026/evidence/smart-surveillance-board.png"
        ),
        "uae-qr.png": repo / "ctf/nest-2026/evidence/uae-qr.png",
    }
    public = {}
    for name, source in mapping.items():
        if source.exists():
            shutil.copy2(source, out_dir / name)
            public[name] = f"/images/projects/bumimang/{name}"
    return public


def overview_post(blog: Path, images: dict[str, str], github_url: str) -> None:
    when = datetime(2026, 11, 1, 12, 30, tzinfo=timezone(timedelta(hours=8)))
    cover = images.get("workbench.png")
    content = front_matter(
        title="第九届强网拟态：不迷茫多 Agent 工作台 18 题复盘",
        slug="nest-2026-bumimang-overview",
        description=(
            "第九届“强网”拟态防御国际精英挑战赛预选赛赛后总复盘："
            "四 Agent 并行、共享黑板、低延迟界面、14 个已确认 flag 与分方向 WP。"
        ),
        when=when,
        cover=cover,
    )
    content += (
        "\n> 参赛队：不迷茫队 · 平台完成 18 题 · 排行榜截图 7547 分 · "
        "本地终态快照折算 7555 分  \n"
        f"> 项目源码：[{github_url}]({github_url})\n\n"
    )
    if cover:
        content += f"![不迷茫多 Agent 工作台]({cover})\n\n"
    content += (
        "## 这次比赛做成了什么\n\n"
        "- 连接比赛平台并完整展示当前账号可见题单、分值、附件、靶机与解题状态。\n"
        "- 把 Codex、Claude Code、OpenCode、DeepSeek Harness 编成四路 Agent。\n"
        "- 单题最多 4 Agent，全局最多 12 并发；共享事实、死路、意图和租约。\n"
        "- 用 E0/E1/E2 证据等级约束提交，平台拒绝后把原因回灌给所有 Agent。\n"
        "- 比赛面板按视图订阅和分区脏检查，实测切换 p95 16.6ms、longtask 0。\n\n"
        "## 最终结果\n\n"
        "| 指标 | 结果 |\n| --- | ---: |\n"
        "| 平台可访问题 | 24 |\n"
        "| 平台完成 | 18 |\n"
        "| 排行榜截图 | 第 157 名 / 7547 分 / 18/26 |\n"
        "| 本地终态折算 | 7555 分 |\n"
        "| 已确认 flag 原文 | 14 |\n\n"
    )
    if "platform-rank.png" in images:
        content += f"![比赛排行榜]({images['platform-rank.png']})\n\n"
    content += (
        "## 分方向 WP\n\n"
        "所有文章都保留完整复现逻辑、关键命令、证据等级和修复建议。"
        "平台完成但本地没有 flag 原文的题目会明确标注“证据缺口”。\n\n"
        "### Web\n\n"
        "- [Ghost-in-the-Queue](/posts/2026/11/nest-2026-web-ghost-in-the-queue/)\n"
        "- [Undercurrent](/posts/2026/11/nest-2026-web-undercurrent/)\n"
        "- [Crossed Signals](/posts/2026/11/nest-2026-web-crossed-signals/)\n\n"
        "### Pwn\n\n"
        "- [Pending Review](/posts/2026/11/nest-2026-pwn-pending-review/)\n"
        "- [Smart Surveillance Camera](/posts/2026/11/nest-2026-pwn-smart-surveillance/)\n"
        "- [SilGate](/posts/2026/11/nest-2026-pwn-silgate/)\n\n"
        "### Crypto\n\n"
        "- [dropout](/posts/2026/11/nest-2026-crypto-dropout/)\n"
        "- [Immobilizer](/posts/2026/11/nest-2026-crypto-immobilizer/)\n"
        "- [Off the Curve](/posts/2026/11/nest-2026-crypto-off-the-curve/)\n"
        "- [Premaster](/posts/2026/11/nest-2026-crypto-premaster/)\n\n"
        "### Misc\n\n"
        "- [FilmReader](/posts/2026/11/nest-2026-misc-filmreader/)\n"
        "- [Pickle-Me-Not](/posts/2026/11/nest-2026-misc-pickle-me-not/)\n"
        "- [LLM Pipeline](/posts/2026/11/nest-2026-misc-llm-pipeline/)\n"
        "- [UAE](/posts/2026/11/nest-2026-misc-uae/)\n"
        "- [Causal Mosaic](/posts/2026/11/nest-2026-misc-causal-mosaic/)\n"
        "- [SilentWeights](/posts/2026/11/nest-2026-misc-silentweights/)\n\n"
        "### Reverse\n\n"
        "- [Wasmnesia](/posts/2026/11/nest-2026-reverse-wasmnesia/)\n"
        "- [Bootleg Update](/posts/2026/11/nest-2026-reverse-bootleg-update/)\n\n"
        "## 发布口径\n\n"
        "- 账号、密码、JWT、Cookie、API Key 和私钥全部脱敏。\n"
        "- 动态靶机地址改为 `<TARGET_HOST>` / `<TARGET_PORT>` 或环境变量。\n"
        "- 只发布授权比赛内容，不提供对公网未授权资产的操作指令。\n"
        "- 所有本地推断都标注证据等级，不把猜测写成事实。\n\n"
        f"完整源码、脚本和台账：<{github_url}>\n"
    )
    (blog / "content" / "posts" / "nest-2026-overview.md").write_text(
        content, encoding="utf-8"
    )


def project_page(blog: Path, images: dict[str, str], github_url: str) -> None:
    cover = images.get("workbench.png")
    content = (
        "---\n"
        'slug: "bumimang-ctf-workbench"\n'
        'title: "不迷茫 · Multi-Agent CTF Workbench"\n'
        'description: "四 Agent 并行、共享黑板、证据驱动提交与低延迟比赛面板的 Windows CTF 工作台。"\n'
        "date: 2026-11-01T12:20:00+08:00\n"
        "lastmod: 2026-11-01T12:20:00+08:00\n"
        f'repo: "{github_url}"\n'
        'language: "TypeScript"\n'
        'tech: ["Electron", "ACP", "MCP", "SQLite", "TypeScript"]\n'
        "featured: true\n"
        "ShowToc: true\n"
        "comments: false\n"
        "---\n\n"
    )
    if cover:
        content += f"![不迷茫工作台]({cover})\n\n"
    content += (
        "## 为什么做它\n\n"
        "比赛时真正拖慢速度的不是模型不会做，而是：题单同步慢、多个 Agent 各做一遍、"
        "结论散落在终端、flag 没有证据、界面每次刷新都卡。"
        "不迷茫把这些环节收进一个本地桌面工作台，让 Agent 负责解题，人只处理边界。\n\n"
        "## 四个核心设计\n\n"
        "1. **平台层**：Nest/CyberPeace、CTFd、CTFy MCP 适配，题单、附件、靶机和提交统一。\n"
        "2. **编排层**：Codex/Claude/OpenCode/DSH 四路 ACP，单题 4 Agent、全局 12 并发。\n"
        "3. **证据层**：共享黑板 + E0/E1/E2 + 平台拒绝回灌，不接受无证据 flag。\n"
        "4. **低延迟 UI**：隐藏视图不渲染、分区脏检查、300ms 黑板刷新合并。\n\n"
        "## 实测性能\n\n"
        "| 指标 | 改造前 | 改造后 |\n| --- | ---: | ---: |\n"
        "| 可见 DOM | 2431 | 699 |\n"
        "| Performance.Nodes | 24466 | 5131 |\n"
        "| 视图切换 p95 | 无法稳定测量 | 16.6ms |\n"
        "| 切换 longtask | 多次 | 0 |\n\n"
        "## 比赛验证\n\n"
        "第九届“强网”拟态预选赛中，平台可访问 24 题、完成 18 题，"
        "排行榜截图第 157 名、7547 分；本地保留并确认 14 个 flag 原文。"
        "全部 18 题 WP 已按方向发布，证据不足的题目明确标注缺口。\n\n"
        "## 快速开始\n\n"
        "- [Windows 便携版](https://github.com/xuanwoLQL/bumimang-ctf-workbench/releases/download/v0.1.0/bumimang-0.1.0-portable.exe)\n"
        "- [Windows 安装版](https://github.com/xuanwoLQL/bumimang-ctf-workbench/releases/download/v0.1.0/bumimang-0.1.0-setup.exe)\n\n"
        "```powershell\n"
        f"git clone {github_url}.git\n"
        "cd bumimang-ctf-workbench\n"
        "Copy-Item config/app.example.json config/app.json\n"
        "Copy-Item config/platform.example.json config/platform.json\n"
        "npm install\n"
        "npm run smoke\n"
        "```\n\n"
        "## 质检\n\n"
        "- `npm run verify:all`：全量通过\n"
        "- `npm run smoke`：渲染层 ALL PASS\n"
        "- `npm run verify:flags`：214/214\n"
        "- `npm run verify:concurrency`：19/19\n"
        "- `npm run verify:hardening`：49/49\n"
        "- 公开源码敏感信息审计：0 findings\n\n"
        f"仓库：<{github_url}>\n\n"
        "比赛总复盘：[第九届强网拟态 18 题复盘](/posts/2026/11/nest-2026-bumimang-overview/)\n"
    )
    (blog / "content" / "projects" / "bumimang.md").write_text(
        content, encoding="utf-8"
    )


def export_posts(repo: Path, blog: Path, github_url: str) -> None:
    writeups = repo / "ctf" / "nest-2026" / "writeups"
    target_dir = blog / "content" / "posts"
    target_dir.mkdir(parents=True, exist_ok=True)
    base = datetime(2026, 11, 1, 12, 31, tzinfo=timezone(timedelta(hours=8)))
    paths = sorted(path for path in writeups.glob("*.md") if path.name != "README.md")
    for index, path in enumerate(paths):
        direction = direction_of(path)
        fallback = path.stem
        title, body = title_of(path.read_text(encoding="utf-8"), fallback)
        cover = None
        if path.name == "pwn-smart-surveillance.md":
            cover = "/images/projects/bumimang/smart-surveillance-board.png"
        elif path.name == "misc-uae.md":
            cover = "/images/projects/bumimang/uae-qr.png"
        slug = "nest-2026-" + path.stem
        content = front_matter(
            title=title,
            slug=slug,
            description=f"第九届强网拟态 {direction} 题 {title} 的完整复现与证据链。",
            when=base + timedelta(minutes=index),
            direction=direction,
            cover=cover,
        )
        content += (
            "\n> 第九届“强网”拟态防御国际精英挑战赛预选赛 · 不迷茫队  \n"
            f"> 项目源码：[{github_url}]({github_url})\n\n"
        )
        if cover:
            content += f"![{title}]({cover})\n\n"
        content += body + "\n"
        (target_dir / f"{slug}.md").write_text(content, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--blog-root", type=Path, required=True)
    parser.add_argument(
        "--github-url",
        default="https://github.com/xuanwoLQL/bumimang-ctf-workbench",
    )
    args = parser.parse_args()

    repo = args.repo_root.resolve()
    blog = args.blog_root.resolve()
    images = copy_images(repo, blog)
    overview_post(blog, images, args.github_url)
    project_page(blog, images, args.github_url)
    export_posts(repo, blog, args.github_url)
    post_count = len(list((repo / "ctf/nest-2026/writeups").glob("*.md"))) - 1
    print(f"posts={post_count}")
    print(f"images={len(images)}")
    print(blog / "content" / "posts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
