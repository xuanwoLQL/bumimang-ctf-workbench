/**
 * DOM 小工具。
 *
 * 注意：所有对 `document` / `window` 的访问都放在函数体内，模块顶层不碰，
 * 这样该文件可以被 Node 直接 import（smoke 测试会 import 同目录的纯逻辑模块，
 * 只要不调用这些函数就不会触发 DOM 依赖）。
 */

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** 转义任何要插进 innerHTML 的外部文本（agent 输出、命令全文等）。 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

export type Children = Array<Node | string | null | undefined>;

export function el(tag: string, attrs?: Record<string, string | null>, children?: Children): HTMLElement {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null) n.setAttribute(k, v);
    }
  }
  if (children) append(n, ...children);
  return n;
}

export function append(parent: Node, ...children: Children): void {
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === "string") parent.appendChild(document.createTextNode(c));
    else parent.appendChild(c);
  }
}

export function clear(n: Node): void {
  while (n.firstChild) n.removeChild(n.firstChild);
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function text(s: string): Text {
  return document.createTextNode(s);
}

/** 安全的 HTML 片段节点：把文本转义后作为子元素包进去。 */
export function htmlLine(html: string): HTMLElement {
  const n = document.createElement("span");
  n.innerHTML = html;
  return n;
}
