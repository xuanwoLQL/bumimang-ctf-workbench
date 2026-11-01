/**
 * WP9-C1：AWD / IR 只读导出（md/csv/json）。
 *
 * 纯函数：返回 content 字符串；不写文件、不发 events/audit、不接平台。
 * Hub 负责审计（只记 format/count，不记 content/flag 明文）。
 */
import type { AwdView, IrView } from "../../../../../packages/shared-protocol/events.ts";

export type AwDirExportFormat = "md" | "csv" | "json";

function mdCell(v: unknown): string {
  return String(v ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}
function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}
function iso(now: number): string {
  return new Date(now).toISOString();
}

export function exportAwd(view: AwdView, format: AwDirExportFormat, now = Date.now()): string {
  if (format === "json") {
    return JSON.stringify(
      {
        format: "json",
        exportedAt: now,
        taskId: view.taskId,
        round: view.round,
        services: view.services,
        flags: view.flags,
        patches: view.patches,
        checks: view.checks,
        attacks: view.attacks,
        warnings: view.warnings ?? [],
      },
      null,
      2,
    );
  }
  if (format === "csv") {
    const lines = [
      csvRow(["type", "round", "name", "target", "status", "owner", "patchStatus", "value", "evidence", "witness", "detail", "at"]),
    ];
    if (view.round) {
      lines.push(csvRow(["round", view.round.number, "", "", view.round.state, "", "", "", "", "", `${view.round.startedAt}-${view.round.endsAt}`, view.round.endsAt]));
    }
    for (const s of view.services) {
      lines.push(csvRow(["service", "", s.name, s.target, s.status, s.ownerSessionId ?? "", s.patchStatus ?? "", "", "", "", "", ""]));
    }
    for (const g of view.flags) {
      for (const c of g.candidates) {
        lines.push(csvRow(["flag", g.round, "", "", c.status, "", "", c.value, c.evidence, "", c.submittedAt != null ? "submitted" : "not-submitted", c.submittedAt ?? ""]));
      }
    }
    for (const p of view.patches) {
      lines.push(csvRow(["patch", "", p.service, "", p.status, "", "", p.vuln, p.evidence, p.witness ?? "", "", ""]));
    }
    for (const c of view.checks) {
      lines.push(csvRow(["check", c.round, c.item, "", c.status, "", "", "", c.evidence ?? "", "", "", ""]));
    }
    for (const a of view.attacks) {
      lines.push(csvRow(["attack", "", a.attacker, a.target, a.result, "", "", a.action, a.evidence ?? "", "", "", a.at]));
    }
    return lines.join("\n");
  }
  const lines: string[] = [
    "# AWD 导出",
    "",
    `导出时间：${iso(now)}`,
    `任务：${view.taskId}`,
    "",
    "## 轮次",
    view.round
      ? `第 ${view.round.number} 轮 · ${view.round.state} · ${iso(view.round.startedAt)} → ${iso(view.round.endsAt)}`
      : "未开始轮次",
    "",
    "## 服务",
    "| 名称 | 目标 | 状态 | 负责 | 补丁 |",
    "| --- | --- | --- | --- | --- |",
    ...view.services.map((s) => `| ${mdCell(s.name)} | ${mdCell(s.target)} | ${mdCell(s.status)} | ${mdCell(s.ownerSessionId ?? "")} | ${mdCell(s.patchStatus ?? "")} |`),
    "",
    "## Flag 轮换",
    "| 轮次 | flag | 状态 | 证据 | 提交 |",
    "| --- | --- | --- | --- | --- |",
    ...view.flags.flatMap((g) =>
      g.candidates.map((c) => `| ${g.round} | ${mdCell(c.value)} | ${mdCell(c.status)} | ${mdCell(c.evidence)} | ${c.submittedAt != null ? "已提交" : "未提交"} |`),
    ),
    "",
    "## 补丁",
    "| 服务 | 漏洞 | 状态 | 证据 | witness |",
    "| --- | --- | --- | --- | --- |",
    ...view.patches.map((p) => `| ${mdCell(p.service)} | ${mdCell(p.vuln)} | ${mdCell(p.status)} | ${mdCell(p.evidence)} | ${mdCell(p.witness ?? "")} |`),
    "",
    "## 防守检查",
    "| 轮次 | 项 | 状态 | 证据 |",
    "| --- | --- | --- | --- |",
    ...view.checks.map((c) => `| ${c.round} | ${mdCell(c.item)} | ${mdCell(c.status)} | ${mdCell(c.evidence ?? "")} |`),
    "",
    "## 攻击日志",
    "| 攻击方 | 目标 | 动作 | 结果 | 证据 |",
    "| --- | --- | --- | --- | --- |",
    ...view.attacks.map((a) => `| ${mdCell(a.attacker)} | ${mdCell(a.target)} | ${mdCell(a.action)} | ${mdCell(a.result)} | ${mdCell(a.evidence ?? "")} |`),
  ];
  if (view.warnings?.length) {
    lines.push("", "## 解析告警", ...view.warnings.map((w) => `- ${w}`));
  }
  return lines.join("\n");
}

export function exportIr(view: IrView, format: AwDirExportFormat, now = Date.now()): string {
  if (format === "json") {
    return JSON.stringify(
      {
        format: "json",
        exportedAt: now,
        taskId: view.taskId,
        evidence: view.evidence,
        timeline: view.timeline,
        questions: view.questions,
        analysis: view.analysis ?? [],
        attachments: view.attachments,
        artifacts: view.artifacts,
        warnings: view.warnings ?? [],
      },
      null,
      2,
    );
  }
  if (format === "csv") {
    const lines = [
      csvRow(["type", "id", "path", "status", "detail", "evidence", "witness", "at", "candidates", "gaps"]),
    ];
    for (const e of view.evidence) {
      lines.push(csvRow(["evidence", e.id, e.path, e.kind, e.sha256 ?? "", e.evidence, e.witness ?? "", e.addedAt, "", ""]));
    }
    for (const t of view.timeline) {
      lines.push(csvRow(["timeline", t.id, "", "", `${t.source}: ${t.event}${t.impact ? ` (impact=${t.impact})` : ""}`, t.evidence ?? "", "", t.at, "", ""]));
    }
    for (const q of view.questions) {
      const cands = (q.candidates ?? [])
        .filter((c) => c.value)
        .map((c) => `${c.value}${c.confidence ? ` (${Math.round(c.confidence * 100)}%)` : ""}`)
        .join("; ");
      const gaps = (q.gaps ?? []).join("; ");
      lines.push(
        csvRow([
          "question",
          q.id,
          "",
          q.status,
          `${q.question}${q.answer ? ` => ${q.answer}` : ""}`,
          q.evidence ?? "",
          "",
          "",
          cands,
          gaps,
        ]),
      );
    }
    return lines.join("\n");
  }
  const lines: string[] = [
    "# IR 导出",
    "",
    `导出时间：${iso(now)}`,
    `任务：${view.taskId}`,
    "",
    "## 证据板",
    "| 类型 | 路径 | 证据 | sha256 | witness | 来源 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...view.evidence.map((e) => `| ${mdCell(e.kind)} | ${mdCell(e.path)} | ${mdCell(e.evidence)} | ${mdCell(e.sha256 ?? "")} | ${mdCell(e.witness ?? "")} | ${mdCell(e.source)} |`),
    "",
    "## 时间线",
    "| 时间 | 来源 | 事件 | 影响 | 证据 |",
    "| --- | --- | --- | --- | --- |",
    ...view.timeline.map((t) => `| ${iso(t.at)} | ${mdCell(t.source)} | ${mdCell(t.event)} | ${mdCell(t.impact ?? "")} | ${mdCell(t.evidence ?? "")} |`),
    "",
    "## 问题 / 答题卡",
    "| 问题 | 状态 | 答案 | 证据 | 候选（未确认） | 缺口 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...view.questions.map((q) => {
      const cands = (q.candidates ?? [])
        .filter((c) => c.value)
        .map((c) => `${c.value}${c.confidence ? ` (${Math.round(c.confidence * 100)}%)` : ""}`)
        .join("; ");
      return `| ${mdCell(q.question)} | ${mdCell(q.status)} | ${mdCell(q.answer ?? "")} | ${mdCell(q.evidence ?? "")} | ${mdCell(cands)} | ${mdCell((q.gaps ?? []).join("; "))} |`;
    }),
  ];
  if (view.analysis?.length) {
    lines.push(
      "",
      "## 分析运行",
      "| 分析器 | 输入 | 事实 | 时间线 | IOC | 告警 | 工具 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...view.analysis.map(
        (a) =>
          `| ${mdCell(a.analyzerId)} | ${mdCell(a.input)} | ${a.facts} | ${a.timeline} | ${a.iocs} | ${mdCell(a.warnings.slice(0, 3).join("; "))} | ${mdCell(a.tools.map((t) => `${t.tool}:${t.ok ? "ok" : t.timedOut ? "timeout" : "fail"}`).join(", "))} |`,
      ),
    );
  }
  if (view.warnings?.length) {
    lines.push("", "## 解析告警", ...view.warnings.map((w) => `- ${w}`));
  }
  return lines.join("\n");
}
