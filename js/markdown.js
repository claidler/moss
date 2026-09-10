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

export function canPreview(lang, src) {
  if (lang === "html" || lang === "svg" || lang === "xml" || lang === "xhtml") return true;
  if (lang) return false;
  return /^\s*(<!DOCTYPE html|<html[\s>]|<svg[\s>])/i.test(src);
}

export function previewDoc(src, lang) {
  const sizer = "<script>(function(){function s(){var h=Math.max(document.documentElement.scrollHeight,document.body&&document.body.scrollHeight||0);parent.postMessage({mossHtmlHeight:h},\"*\")}addEventListener(\"load\",s);if(document.readyState===\"complete\")s();try{new ResizeObserver(s).observe(document.documentElement)}catch(e){}})();<\/script>";
  const body = src || "";
  if (lang === "svg" || /^\s*<svg[\s>]/i.test(body)) {
    return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>html,body{margin:0;background:transparent;display:grid;place-items:center;min-height:120px;padding:12px}svg{max-width:100%;height:auto}</style></head><body>" + body + sizer + "</body></html>";
  }
  if (/^\s*(<!DOCTYPE|<html[\s>])/i.test(body)) {
    if (/<\/body>/i.test(body)) return body.replace(/<\/body>/i, sizer + "</body>");
    if (/<\/html>/i.test(body)) return body.replace(/<\/html>/i, sizer + "</html>");
    return body + sizer;
  }
  return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>html,body{margin:0;padding:12px;font:16px/1.45 system-ui,sans-serif}img,video,canvas,svg{max-width:100%;height:auto}</style></head><body>" + body + sizer + "</body></html>";
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
    const previewable = !!allowPreview && canPreview(lang, src) && src.trim();
    if (previewable) {
      wrap.dataset.kind = (lang === "svg" || /^\s*<svg[\s>]/i.test(src)) ? "svg" : "html";
      wrap.dataset.view = "preview";
      const bPrev = document.createElement("button");
      bPrev.type = "button";
      bPrev.dataset.tab = "preview";
      bPrev.className = "on";
      bPrev.textContent = "Preview";
      const bCode = document.createElement("button");
      bCode.type = "button";
      bCode.dataset.tab = "code";
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
  const looksHtml = /^\s*(<!DOCTYPE html|<html[\s>])/i.test(src) && !/```/.test(src);
  if (looksHtml) {
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
  el.innerHTML = renderMd(src);
  wrapTables(el);
  enhanceCodeBlocks(el, preview);
}
