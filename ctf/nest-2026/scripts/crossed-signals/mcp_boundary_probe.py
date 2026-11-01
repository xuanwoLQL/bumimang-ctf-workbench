#!/usr/bin/env python3
"""Compare MCP gateway authorization headers with the tool JSON arguments."""

from __future__ import annotations

import argparse
import json

import requests


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--assigned-vin", required=True)
    parser.add_argument("--target-vin", required=True)
    parser.add_argument(
        "--tool",
        choices=["get_vehicle_health", "get_update_status"],
        default="get_update_status",
    )
    args = parser.parse_args()

    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": args.tool,
            "arguments": {"vin": args.target_vin},
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {
                    "name": "northline-service-console",
                    "version": "1.0.0",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
            },
        },
    }
    headers = {
        "Authorization": f"Bearer {args.token}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": args.tool,
        "Mcp-Param-VIN": args.assigned_vin,
    }
    response = requests.post(
        args.base.rstrip("/") + "/mcp",
        headers=headers,
        json=request,
        timeout=20,
    )
    print(f"HTTP {response.status_code}")
    try:
        print(json.dumps(response.json(), indent=2, ensure_ascii=False))
    except ValueError:
        print(response.text)
    return 0 if response.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
