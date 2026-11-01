/**
 * 「无 bundler」的渲染进程加载机制：注册一个自定义 scheme，把
 * `apps/desktop/src/renderer/**`（以及 renderer.html）按需读出来，`.ts` 文件
 * 现场用 Node 的 `module.stripTypeScriptTypes` 剥掉类型、以 `text/javascript` 返回。
 *
 * 这样 renderer.html 里的 `<script type="module" src="./src/renderer/main.ts">`
 * 在浏览器侧就能直接跑 TypeScript，不需要 webpack/vite/esbuild。
 *
 * 用法（Lane A 在 `src/main/electron/main.ts` 里调用）：
 *   registerRendererProtocol();
 *   win.loadURL("bumimang://./renderer.html");
 *
 * ⚠ 实测发现（Lane B，2026-10-13，electron 44.7.0 / Node 24.21.0）：
 *   在 `protocol.handle` 的 handler **内部**做文件 I/O（无论 `fs/promises` 的
 *   `readFile` 还是 `fs.readFileSync`）会卡死——`readFile` 的 Promise 永不 settle、
 *   `readFileSync` 也不返回，导致页面空白。同样的读取放在 handler 之外（启动时）
 *   完全正常。因此本实现改为：**在 `registerRendererProtocol()` 时一次性把整个
 *   renderer 资产树读进内存 + 现场剥类型，handler 只做内存查表，零 I/O。**
 *   Lane A 若要在主进程里读盘，请勿放在 protocol handler 内（或先探明原因）。
 */
import { protocol } from "electron";
import { readFileSync, readdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const RENDERER_SCHEME = "bumimang";

/** 映射到 apps/desktop/（renderer.html、src/renderer/** 都在这下面）。 */
const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

interface Asset {
  type: string;
  body: Buffer;
}

/** 把 URL 的 pathname 归一化成资产表的相对键（统一 `/` 分隔）。 */
function resolveRel(requestUrl: string): string {
  const url = new URL(requestUrl);
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  return rel === "" ? "renderer.html" : rel;
}

/** 递归收集目录下所有文件的相对路径（`/` 分隔）。 */
function walk(dir: string, prefix: string, out: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(abs, rel, out);
    else out.set(rel, abs);
  }
}

/** 启动时一次性读盘 + 剥 .ts 类型，handler 里只查内存。 */
function buildAssets(): Map<string, Asset> {
  const files = new Map<string, string>();
  files.set("renderer.html", path.join(APP_ROOT, "renderer.html"));
  walk(path.join(APP_ROOT, "src", "renderer"), "src/renderer", files);

  const assets = new Map<string, Asset>();
  for (const [rel, abs] of files) {
    const ext = path.extname(abs).toLowerCase();
    let body = readFileSync(abs);
    if (ext === ".ts") {
      body = Buffer.from(stripTypeScriptTypes(body.toString("utf8")), "utf8");
    }
    assets.set(rel, { type: MIME[ext] ?? "application/octet-stream", body });
  }
  return assets;
}

let assetCache: Map<string, Asset> | null = null;

export function registerRendererProtocol(): void {
  if (assetCache == null) assetCache = buildAssets();

  protocol.handle(RENDERER_SCHEME, (request) => {
    const rel = resolveRel(request.url);
    const asset = assetCache!.get(rel);
    if (!asset) return new Response("not found", { status: 404 });
    return new Response(asset.body, { headers: { "content-type": asset.type } });
  });
}
