#!/usr/bin/env python3
"""Export a sanitized competition ledger from the local 不迷茫 board."""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = Path(os.environ.get("BUMIMANG_WORKSPACE", Path(os.environ["APPDATA"]) / "bumimang" / "workspace"))
OUT_DIR = ROOT / "ctf" / "nest-2026"


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def main() -> None:
    state = read_json(WORKSPACE / "platform-state.json")
    db = sqlite3.connect(f"file:{WORKSPACE / 'board.db'}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row

    tasks = {
        row["id"]: dict(row)
        for row in db.execute(
            "select id,title,status,answer,solved_by,created_at,updated_at,category,points "
            "from tasks"
        )
    }
    tasks_by_title: dict[str, list[dict]] = {}
    for task in tasks.values():
        tasks_by_title.setdefault(str(task.get("title") or "").strip().casefold(), []).append(task)
    flags_by_task: dict[str, list[dict]] = {}
    for row in db.execute(
        """
        select task_id,value,evidence,status,submit_status,submit_detail,first_seen
        from flag_candidates
        order by first_seen
        """
    ):
        item = dict(row)
        flags_by_task.setdefault(item["task_id"], []).append(item)

    challenges = []
    curated_path = OUT_DIR / "curated-flags.json"
    curated = read_json(curated_path) if curated_path.exists() else {}
    for challenge in state.get("challenges", []):
        task_id = challenge.get("taskId") or state.get("taskByChallenge", {}).get(challenge.get("id"))
        if not task_id:
            matches = tasks_by_title.get(str(challenge.get("title") or "").strip().casefold(), [])
            matches.sort(
                key=lambda task: (
                    task.get("status") == "solved",
                    int(task.get("updated_at") or task.get("created_at") or 0),
                ),
                reverse=True,
            )
            task_id = matches[0]["id"] if matches else None
        task = tasks.get(task_id or "", {})
        flags = flags_by_task.get(task_id or "", [])
        accepted = [
            flag for flag in flags
            if flag["status"] == "confirmed" or flag["submit_status"] == "ok"
        ]
        if not accepted and task.get("answer"):
            accepted = [
                {
                    "value": task["answer"],
                    "evidence": "task-answer",
                    "submit_status": "ok",
                    "first_seen": task.get("updated_at"),
                }
            ]
        if not accepted:
            accepted = [
                {
                    "value": flag["value"],
                    "evidence": flag.get("evidence", "E2"),
                    "submit_status": flag.get("submitStatus", "ok"),
                    "first_seen": None,
                    "source": flag.get("source"),
                }
                for flag in curated.get(str(challenge.get("title") or ""), [])
            ]
        challenges.append(
            {
                "id": challenge.get("id"),
                "title": challenge.get("title"),
                "direction": challenge.get("direction"),
                "category": challenge.get("category"),
                "points": challenge.get("points"),
                "solvedCount": challenge.get("solvedCount"),
                "isSolved": challenge.get("isSolved") is True,
                "taskId": task_id,
                "taskStatus": task.get("status"),
                "acceptedFlags": [
                    {
                        "value": flag["value"],
                        "evidence": flag["evidence"],
                        "submitStatus": flag["submit_status"],
                        "firstSeen": flag["first_seen"],
                        "source": flag.get("source"),
                    }
                    for flag in accepted
                ],
                "candidateCount": len(flags),
            }
        )

    solved = [item for item in challenges if item["isSolved"]]
    ledger = {
        "event": "第九届“强网”拟态防御国际精英挑战赛预选赛",
        "generatedFrom": "不迷茫本地黑板与平台只读快照",
        "race": state.get("race"),
        "summary": {
            "visible": len(challenges),
            "solved": len(solved),
            "points": sum(int(item.get("points") or 0) for item in solved),
            "capturedAcceptedFlags": sum(len(item["acceptedFlags"]) for item in solved),
        },
        "challenges": challenges,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "competition-ledger.json").write_text(
        json.dumps(ledger, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    lines = [
        "# 第九届“强网”拟态防御国际精英挑战赛 · 本地证据总台账",
        "",
        "> 由 `release-tools/export_nest_2026.py` 从本地黑板生成。",
        "> 只包含平台判定已完成的题目；动态靶机地址、账号、Token 不在公开台账中。",
        "",
        f"- 当前可见：**{ledger['summary']['visible']}**",
        f"- 平台已完成：**{ledger['summary']['solved']}**",
        f"- 本地捕获且已接受 flag：**{ledger['summary']['capturedAcceptedFlags']}**",
        "",
        "| 题名 | 方向 | 分值 | 平台状态 | flag | 任务 |",
        "| --- | --- | ---: | --- | --- | --- |",
    ]
    for item in challenges:
        flags = "<br>".join(f"`{flag['value']}`" for flag in item["acceptedFlags"]) or "平台已完成，本地未保留原文"
        lines.append(
            f"| {item['title']} | {item['direction']} | {item['points']} | "
            f"{'已解' if item['isSolved'] else '未解'} | {flags} | {item['taskId'] or '-'} |"
        )
    (OUT_DIR / "competition-ledger.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(OUT_DIR / "competition-ledger.json")
    print(OUT_DIR / "competition-ledger.md")


if __name__ == "__main__":
    main()
