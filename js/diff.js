// Moss — Changes view: browse git diffs across configured repos, with
// per-language syntax highlighting (including Lean) inside the hunks.
import { log, chatTitle, headAvatar, state, syncDayNav } from "./state.js";
import { setView } from "./board.js";
import { prismId } from "./markdown.js";

const diffState = {
  repos: null,
  repo: null,      // repo id when a repo diff is open
  base: "",        // "" = working tree vs HEAD; otherwise a commit sha (range base)
  data: null,
  open: new Set(), // open file paths
  seq: 0,          // diff-request generation; only the newest may paint
};

export function diffGlyph() {
  return `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="10" cy="7" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="10" cy="25" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="22" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 10v12M13 12h4a3 3 0 0 1 3 3v0a5 5 0 0 1-5 5h-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
}

export function renderDiffRow() {
  const row = document.createElement("div");
  row.className = "bot-row diff-row" + (state.view === "diff" ? " active" : "");
  if (state.view === "diff") row.setAttribute("aria-current", "true");
  row.innerHTML =
    `<div class="avatar diff-face">${diffGlyph()}</div>
     <div><div class="bot-name"></div><div class="bot-preview"></div></div>
     <div class="bot-time"></div>
     <span></span>`;
  row.querySelector(".bot-name").textContent = "Changes";
  const repos = diffState.repos;
  row.querySelector(".bot-preview").textContent = repos && repos.length
    ? repos.map((r) => (r.changed > 0 ? r.name + " ●" : r.name)).join(" · ")
    : "Git diffs across your repos";
  row.addEventListener("click", () => {
    if (state.suppressBoardClick) return;
    openDiff();
  });
  return row;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const EXT_LANGS = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", pyw: "python",
  sh: "bash", bash: "bash", zsh: "bash",
  json: "json", yaml: "yaml", yml: "yaml",
  rs: "rust", go: "go",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  java: "java", rb: "ruby", toml: "toml", sql: "sql",
  hs: "haskell", lhs: "haskell", ml: "ocaml", mli: "ocaml",
  lua: "lua", md: "markdown", markdown: "markdown", nix: "nix",
  v: "coq", coq: "coq", lean: "lean",
  zig: "zig", jl: "julia", ex: "elixir", exs: "elixir",
  erl: "erlang", hrl: "erlang", kt: "kotlin", kts: "kotlin",
  swift: "swift", dart: "dart", r: "r", pl: "perl", pm: "perl",
};

function langForPath(p) {
  const base = String(p || "").split("/").pop() || "";
  if (/^dockerfile/i.test(base)) return "docker";
  if (/^makefile$|^GNUmakefile$|\.mak$|\.mk$/i.test(base)) return "makefile";
  const m = base.match(/\.([A-Za-z0-9]+)$/);
  if (!m) return "";
  return EXT_LANGS[m[1].toLowerCase()] || "";
}

function highlightLine(txt, lang) {
  const id = prismId(lang);
  if (window.Prism && id && Prism.languages[id]) {
    try {
      return Prism.highlight(txt, Prism.languages[id], id);
    } catch (e) {}
  }
  return esc(txt);
}

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return "now";
  if (s < 5400) return Math.round(s / 60) + "m";
  if (s < 129600) return Math.round(s / 3600) + "h";
  return Math.round(s / 86400) + "d";
}

const STATUS_LABEL = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied" };

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function loadRepos() {
  try {
    const data = await fetchJson("/api/diff/repos");
    diffState.repos = data.repos || [];
  } catch (e) {
    diffState.repos = [];
  }
}

export async function openDiff() {
  setView("diff");
  state.hooks.setNav(false);
  log.innerHTML = "";
  state.stamped = false;
  state.emptyEl = null;
  chatTitle.textContent = "Changes";
  headAvatar.className = "avatar diff-face";
  headAvatar.innerHTML = diffGlyph();
  syncDayNav([], 0);
  state.hooks.syncBusy();
  if (!diffState.repos) {
    log.innerHTML = '<div id="empty"><h2>Changes</h2><p>Loading repos…</p></div>';
    state.emptyEl = document.getElementById("empty");
  }
  // Re-fetch repo cards on every entry (Chris, 2026-10-01): commits landed
  // while the app sat open must appear in the commit picker and dirty pills
  // without a full page reload — the old one-shot cache is why new changes
  // "didn't come through" when moving between commits.
  await loadRepos();
  state.hooks.renderList();
  if (diffState.repo) await paintDiffRepo();
  else paintDiffRepos();
}

function paintDiffRepos() {
  log.innerHTML = "";
  const repos = diffState.repos || [];
  if (!repos.length) {
    log.innerHTML = '<div id="empty"><h2>No repos</h2><p>Set <code>MOSS_REPOS</code> to a comma-separated list of git directories to browse diffs here.</p></div>';
    state.emptyEl = document.getElementById("empty");
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "diff-repos";
  repos.forEach((r) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "diff-repo-card";
    const dirty = r.changed > 0 ? `<span class="diff-pill dirty">${r.changed} changed</span>`
      : r.changed === 0 ? `<span class="diff-pill clean">clean</span>`
      : "";
    const ab = r.ahead || r.behind
      ? `<span class="diff-pill ab">${r.ahead ? "↑" + r.ahead : ""}${r.ahead && r.behind ? " " : ""}${r.behind ? "↓" + r.behind : ""}</span>`
      : "";
    const last = r.commits && r.commits[0];
    card.innerHTML =
      `<div class="diff-repo-top">
         <span class="diff-repo-name"></span>
         <span class="diff-repo-branch"></span>
       </div>
       <div class="diff-repo-pills">${dirty}${ab}</div>
       <div class="diff-repo-last">${last ? `<b>${esc(last.short)}</b> ${esc(last.subject)} · ${ago(last.ts)}` : "no commits"}</div>`;
    card.querySelector(".diff-repo-name").textContent = r.name;
    card.querySelector(".diff-repo-branch").textContent = r.branch;
    card.addEventListener("click", () => {
      diffState.repo = r.id;
      diffState.base = "";
      diffState.data = null;
      diffState.open = new Set();
      openDiff();
    });
    wrap.appendChild(card);
  });
  log.appendChild(wrap);
}

async function paintDiffRepo() {
  const repo = (diffState.repos || []).find((r) => r.id === diffState.repo);
  log.innerHTML = "";
  const bar = document.createElement("div");
  bar.className = "diff-toolbar";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "diff-back";
  back.textContent = "‹ Repos";
  back.addEventListener("click", () => {
    diffState.repo = null;
    diffState.data = null;
    paintDiffRepos();
  });
  bar.appendChild(back);
  const name = document.createElement("span");
  name.className = "diff-repo-name";
  name.textContent = repo ? repo.name : diffState.repo;
  bar.appendChild(name);
  const branch = document.createElement("span");
  branch.className = "diff-repo-branch";
  branch.textContent = repo ? repo.branch : "";
  bar.appendChild(branch);
  const pick = document.createElement("select");
  pick.className = "diff-base";
  const optWork = document.createElement("option");
  optWork.value = "";
  optWork.textContent = "Uncommitted changes";
  pick.appendChild(optWork);
  ((repo && repo.commits) || []).slice(0, 15).forEach((c) => {
    const o = document.createElement("option");
    o.value = c.sha;
    o.textContent = `Since ${c.short} · ${c.subject.slice(0, 48)}`;
    pick.appendChild(o);
  });
  pick.value = diffState.base;
  pick.addEventListener("change", () => {
    diffState.base = pick.value;
    diffState.data = null;
    diffState.open = new Set();
    openDiff();
  });
  bar.appendChild(pick);
  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "diff-reload";
  reload.textContent = "↻";
  reload.title = "Reload";
  reload.addEventListener("click", () => {
    diffState.data = null;
    openDiff();
  });
  bar.appendChild(reload);
  log.appendChild(bar);

  if (!diffState.data) {
    // Tag the request with a generation: rapid base switches used to paint
    // the previous base's diff under the new picker selection, so only the
    // newest response is allowed to store data or repaint.
    const seq = ++diffState.seq;
    const q = "repo=" + encodeURIComponent(diffState.repo) +
      "&from=HEAD&to=" + encodeURIComponent(diffState.base);
    const pending = document.createElement("div");
    pending.className = "diff-none";
    pending.textContent = "Loading diff…";
    log.appendChild(pending);
    try {
      const fresh = await fetchJson("/api/diff/diff?" + q);
      if (seq !== diffState.seq) return;
      diffState.data = fresh;
    } catch (e) {
      if (seq !== diffState.seq) return;
      diffState.data = { files: [], error: true };
    }
    if (diffState.repo) return paintDiffRepo();
    return;
  }

  const data = diffState.data;
  const files = data.files || [];
  const summary = document.createElement("div");
  summary.className = "diff-summary";
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  summary.innerHTML = `${files.length} file${files.length === 1 ? "" : "s"} · <span class="d-add">+${adds}</span> <span class="d-del">−${dels}</span>${data.truncated ? " · <em>truncated</em>" : ""}`;
  log.appendChild(summary);
  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "diff-none";
    empty.textContent = diffState.base ? "No changes in this range." : "Working tree is clean.";
    log.appendChild(empty);
    return;
  }
  // Files always start collapsed (Chris, 2026-10-01): the head row is the only
  // thing painted until tapped, so the diff list stays short on every repo.
  files.forEach((f) => log.appendChild(paintFile(f)));
}

function paintFile(f) {
  const box = document.createElement("div");
  box.className = "diff-file" + (diffState.open.has(f.path) ? " open" : "");
  const head = document.createElement("button");
  head.type = "button";
  head.className = "diff-file-head";
  const scls = { A: "a", D: "d", R: "r", C: "r" }[f.status] || "m";
  const pathLabel = f.status === "R" && f.oldPath && f.oldPath !== f.path ? f.oldPath + " → " + f.path : f.path;
  head.innerHTML =
    `<span class="diff-status s-${scls}" title="${STATUS_LABEL[f.status] || f.status}">${esc(f.status)}</span>
     <span class="diff-path"></span>
     <span class="diff-counts"><b class="d-add">+${f.additions}</b> <b class="d-del">−${f.deletions}</b></span>
     <span class="diff-chev">›</span>`;
  head.querySelector(".diff-path").textContent = pathLabel;
  head.addEventListener("click", () => {
    if (diffState.open.has(f.path)) {
      diffState.open.delete(f.path);
      box.classList.remove("open");
    } else {
      diffState.open.add(f.path);
      if (!box.dataset.filled) fillFile(body, f);
      box.classList.add("open");
    }
  });
  box.appendChild(head);

  // Hunks live in a body wrapper that CSS shows only while .open, so the
  // toggle is a plain class flip and can never desync from the open set.
  const body = document.createElement("div");
  body.className = "diff-body";
  box.appendChild(body);

  if (diffState.open.has(f.path)) fillFile(body, f);
  return box;
}

// Hunks are built lazily on first open so a 40-file diff stays snappy to paint.
function fillFile(body, f) {
  body.parentElement.dataset.filled = "1";
  if (f.binary) {
    const bin = document.createElement("div");
    bin.className = "diff-none";
    bin.textContent = "Binary file";
    body.appendChild(bin);
    return;
  }
  if (!f.hunks.length && f.status === "D") {
    const gone = document.createElement("div");
    gone.className = "diff-none";
    gone.textContent = "File deleted";
    body.appendChild(gone);
    return;
  }
  const lang = langForPath(f.path);
  f.hunks.forEach((h) => {
    const hunk = document.createElement("div");
    hunk.className = "diff-hunk";
    const hh = document.createElement("div");
    hh.className = "diff-hunk-head";
    hh.textContent = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
    hunk.appendChild(hh);
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    h.lines.forEach((ln) => {
      const row = document.createElement("div");
      row.className = "dl " + (ln.t === "+" ? "add" : ln.t === "-" ? "del" : "ctx");
      const o = document.createElement("span");
      o.className = "dl-no";
      const n = document.createElement("span");
      n.className = "dl-no";
      if (ln.t !== "+") o.textContent = oldNo++;
      if (ln.t !== "-") n.textContent = newNo++;
      const txt = document.createElement("code");
      txt.className = "dl-txt" + (lang ? " language-" + lang : "");
      txt.innerHTML = highlightLine(ln.txt, lang) || "&nbsp;";
      row.appendChild(o);
      row.appendChild(n);
      row.appendChild(txt);
      hunk.appendChild(row);
    });
    body.appendChild(hunk);
  });
}
