export function renderMd(text) {
  const src = text || "";
  const raw = window.marked ? marked.parse(src, { breaks: true, gfm: true }) : src;
  return window.DOMPurify ? DOMPurify.sanitize(raw, {
    ADD_TAGS: ["details", "summary", "video", "source", "picture", "mark", "figure", "figcaption", "kbd"],
    ADD_ATTR: ["open", "controls", "poster", "playsinline"]
  }) : raw;
}

export function langOf(code) {
  const m = String(code.className || "").match(/language-([\w+-]+)/i);
  return ((m && m[1]) || "").toLowerCase();
}

export function prismId(lang) {
  const map = {
    html: "markup", xml: "markup", svg: "markup", xhtml: "markup",
    js: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "javascript", typescript: "javascript",
    py: "python", sh: "bash", shell: "bash", zsh: "bash",
    yml: "yaml"
  };
  return map[lang] || lang;
}

export function highlightCode(code, lang) {
  if (!window.Prism || !code) return;
  const id = prismId(lang);
  if (!id || !Prism.languages[id]) return;
  try {
    code.innerHTML = Prism.highlight(code.textContent || "", Prism.languages[id], id);
  } catch (e) {}
}

// A whole HTML document as a message renders through the preview/code toggle.
// Bare fragments (a stray <div> mid-prose) stay on the markdown path, where
// marked + DOMPurify already inline-render them.
export function looksDocHtml(src) {
  const t = String(src || "").trim();
  return /^<!doctype\s+html/i.test(t) || /^<html[\s>]/i.test(t);
}

// "svg" | "doc" | "fragment" | null — how a fenced block or raw message renders.
export function htmlKindOf(lang, src) {
  const s = String(src || "");
  if (!s.trim()) return null;
  if (lang === "svg" || (lang !== "html" && lang !== "xml" && lang !== "xhtml" && !lang && /^\s*<svg[\s>]/i.test(s))) return "svg";
  if (lang === "html" || lang === "xml" || lang === "xhtml") return looksDocHtml(s) ? "doc" : "fragment";
  return null;
}

export function canPreview(lang, src) {
  return htmlKindOf(lang, src) !== null;
}

// Light tokens mirror css/app.css :root; dark overrides sit in a
// prefers-color-scheme block *inside* the frame so the sandboxed document
// follows the system theme on its own (verified on Chromium; srcdoc iframes
// inherit the UI's forced scheme, so Playwright colourScheme tests it honestly).
const THEME_VARS =
  ":root{color-scheme:light dark;--bg:#fafaf8;--fg:#1a1a1a;--card:#ffffff;--muted:#f0f0ed;--muted-fg:#6c6c70;" +
  "--border:#e8e8e4;--primary:#1a1a1a;--primary-fg:#f1f1ef;--ok:#228b3b;--mark:#3b82f6;" +
  "--font:ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Inter,sans-serif}" +
  "@media (prefers-color-scheme:dark){:root{--bg:#0d0d0e;--fg:#ececee;--card:#141416;--muted:#1a1a1d;" +
  "--muted-fg:#85858a;--border:#26262a;--primary:#f1f1ef;--primary-fg:#1a1a1a;--ok:#4ecb71}}";

const THEME_BASE =
  "html{background:transparent}body{color:var(--fg);font-family:var(--font)}" +
  "img,video,canvas,svg{max-width:100%;height:auto}";

function themeStyle(hostedDoc) {
  return (
    "<style id=\"moss-theme\">" + THEME_VARS +
    (hostedDoc ? THEME_BASE : "html,body{margin:0;background:transparent}body{color-scheme:inherit}") +
    "</style>"
  );
}

function sizerScript() {
  return "<script>(function(){function s(){var h=Math.max(document.documentElement.scrollHeight,document.body&&document.body.scrollHeight||0);parent.postMessage({mossHtmlHeight:h},\"*\")}addEventListener(\"load\",s);if(document.readyState===\"complete\")s();try{new ResizeObserver(s).observe(document.documentElement)}catch(e){}})();<\/script>";
}

const LINK_BASE = "<base target=\"_blank\">";

export function previewDoc(src, lang) {
  const kind = htmlKindOf(lang, src) || (looksDocHtml(src) ? "doc" : "fragment");
  const body = src || "";
  const sizer = sizerScript();
  if (kind === "svg") {
    return "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" + themeStyle(false) +
      "<style>html,body{margin:0;padding:0}body{display:grid;place-items:center;min-height:120px;padding:12px}</style>" +
      "</head><body>" + body + sizer + "</body></html>";
  }
  if (kind === "doc") {
    const inject = themeStyle(true) + LINK_BASE;
    let out = body;
    if (/<head[^>]*>/i.test(out)) out = out.replace(/<head([^>]*)>/i, (m) => m + inject);
    else if (/<body[^>]*>/i.test(out)) out = out.replace(/<body([^>]*)>/i, (m) => m + inject);
    else out = inject + out;
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, sizer + "</body>");
    else if (/<\/html>/i.test(out)) out = out.replace(/<\/html>/i, sizer + "</html>");
    else out = out + sizer;
    return out;
  }
  return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    themeStyle(false) + LINK_BASE +
    "<style>body{padding:14px;color:var(--fg);font:15px/1.55 var(--font)}a{color:var(--mark)}</style>" +
    "</head><body>" + body + sizer + "</body></html>";
}

export function enhanceCodeBlocks(root, allowPreview) {
  if (!root) return;
  root.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentNode;
    if (!pre || (pre.parentNode && pre.parentNode.classList.contains("code-pane"))) return;
    const lang = langOf(code);
    const src = code.textContent || "";
    const wrap = document.createElement("div");
    wrap.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-head";
    const label = document.createElement("span");
    label.className = "code-lang";
    label.textContent = lang || "code";
    head.appendChild(label);
    const kind = allowPreview ? htmlKindOf(lang, src) : null;
    const previewable = !!kind && !!src.trim();
    if (previewable) {
      wrap.dataset.kind = kind;
      // The 1s live repaint calls setBubble again on the same .md element;
      // honour the reader's last tab choice (recorded by app.js) so a
      // Preview/Code flip is not yanked back mid-run.
      if (!wrap.dataset.view) wrap.dataset.view = (root.dataset && root.dataset.htmlView) || "preview";
      const on = wrap.dataset.view === "preview" ? "preview" : "code";
      const bPrev = document.createElement("button");
      bPrev.type = "button";
      bPrev.dataset.tab = "preview";
      bPrev.classList.toggle("on", on === "preview");
      bPrev.textContent = "Preview";
      const bCode = document.createElement("button");
      bCode.type = "button";
      bCode.dataset.tab = "code";
      bCode.classList.toggle("on", on === "code");
      bCode.textContent = "Code";
      head.appendChild(bPrev);
      head.appendChild(bCode);
    }
    const copy = document.createElement("button");
    copy.type = "button";
    copy.dataset.copy = "1";
    copy.textContent = "Copy";
    head.appendChild(copy);
    const pane = document.createElement("div");
    pane.className = "code-pane";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(head);
    wrap.appendChild(pane);
    pane.appendChild(pre);
    if (previewable) {
      const frame = document.createElement("iframe");
      frame.className = "html-frame";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.title = "HTML preview";
      frame.srcdoc = previewDoc(src, lang);
      wrap.appendChild(frame);
    }
    highlightCode(code, lang);
  });
}

export function wrapTables(el) {
  el.querySelectorAll(".md table, table").forEach((t) => {
    if (t.parentElement && t.parentElement.classList.contains("table-wrap")) return;
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    t.parentNode.insertBefore(wrap, t);
    wrap.appendChild(t);
  });
}

export function setBubble(el, text, opts) {
  const src = text || "";
  const preview = !opts || opts.preview !== false;
  // Restore the reader's Preview/Code choice across full log rebuilds
  // (captured by captureGroupOpenStates, threaded through add opts).
  if (opts && (opts.mdView === "code" || opts.mdView === "preview")) el.dataset.htmlView = opts.mdView;
  // Whole HTML documents render through the themed iframe preview with a
  // Code toggle. The old backtick veto is gone: a document containing a
  // `code span` or fenced example is still an HTML document.
  if (looksDocHtml(src)) {
    el.innerHTML = "";
    const code = document.createElement("code");
    code.className = "language-html";
    code.textContent = src;
    const pre = document.createElement("pre");
    pre.appendChild(code);
    el.appendChild(pre);
    enhanceCodeBlocks(el, preview);
    return;
  }
  // Ordinary markdown: inline HTML (fragments, <details>, figures…) already
  // renders here through marked + DOMPurify.
  el.innerHTML = renderMd(src);
  wrapTables(el);
  enhanceCodeBlocks(el, preview);
}
