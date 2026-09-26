import { botsEl, log } from "./state.js";
import { timeLabel } from "./format.js";
import { switchChat } from "./chats.js";
import { openNote } from "./board.js";

const box = document.getElementById("searchInput");
const clearBtn = document.getElementById("searchClear");
const resultsEl = document.getElementById("searchResults");

const MIN_Q = 2;
const DEBOUNCE_MS = 150;
let timer = null;
let gen = 0;

function closeSearch() {
  resultsEl.hidden = true;
  resultsEl.innerHTML = "";
  botsEl.style.display = "";
}

function highlight(el, text, tokens) {
  const re = tokens.length
    ? new RegExp("(" + tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi")
    : null;
  if (!re) {
    el.textContent = text;
    return;
  }
  let last = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const mark = document.createElement("mark");
    mark.textContent = m[0];
    el.appendChild(mark);
    last = m.index + m[0].length;
    if (!m[0].length) re.lastIndex++;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

function chatRow(hit, tokens) {
  const row = document.createElement("div");
  row.className = "s-row";
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  const t = document.createElement("div");
  t.className = "s-title";
  highlight(t, hit.title || "New chat", tokens);
  row.appendChild(t);
  if (hit.snippet) {
    const s = document.createElement("div");
    s.className = "s-snippet";
    highlight(s, hit.snippet, tokens);
    row.appendChild(s);
  }
  const meta = document.createElement("div");
  meta.className = "s-meta";
  meta.textContent = [hit.role, timeLabel(hit.updatedAt)].filter(Boolean).join(" · ");
  row.appendChild(meta);
  const go = () => {
    box.value = "";
    clearBtn.hidden = true;
    closeSearch();
    switchChat(hit.id).then(() => {
      jumpToMessage(hit.mi);
    }).catch(() => {});
  };
  row.addEventListener("click", go);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
  return row;
}

// The chat may repaint once more right after switchChat (deferred hydration
// fetch), which replaces the flashed node, so re-apply once if detached.
function jumpToMessage(mi) {
  if (mi == null || mi < 0) return;
  const apply = () => {
    const rows = log.querySelectorAll(".msg");
    const target = rows[mi];
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1800);
  };
  apply();
  setTimeout(() => {
    const rows = log.querySelectorAll(".msg");
    const target = rows[mi];
    if (target && !target.isConnected) apply();
  }, 400);
}

function noteRow(hit, tokens) {
  const row = document.createElement("div");
  row.className = "s-row";
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  const t = document.createElement("div");
  t.className = "s-title";
  highlight(t, hit.title || "Automation", tokens);
  row.appendChild(t);
  if (hit.snippet) {
    const s = document.createElement("div");
    s.className = "s-snippet";
    highlight(s, hit.snippet, tokens);
    row.appendChild(s);
  }
  const meta = document.createElement("div");
  meta.className = "s-meta";
  meta.textContent = "Automation · " + timeLabel(hit.createdAt);
  row.appendChild(meta);
  row.addEventListener("click", () => {
    box.value = "";
    clearBtn.hidden = true;
    closeSearch();
    openNote(hit.id);
  });
  return row;
}

function group(label) {
  const g = document.createElement("div");
  g.className = "search-group";
  g.textContent = label;
  return g;
}

function render(q, data) {
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  resultsEl.innerHTML = "";
  if (data.chats && data.chats.length) {
    resultsEl.appendChild(group("Chats"));
    data.chats.forEach((h) => resultsEl.appendChild(chatRow(h, tokens)));
  }
  if (data.notes && data.notes.length) {
    resultsEl.appendChild(group("Automations"));
    data.notes.forEach((h) => resultsEl.appendChild(noteRow(h, tokens)));
  }
  if (!resultsEl.childNodes.length) {
    const e = document.createElement("div");
    e.className = "search-empty";
    e.textContent = "No matches";
    resultsEl.appendChild(e);
  }
  botsEl.style.display = "none";
  resultsEl.hidden = false;
}

async function run(q) {
  const my = ++gen;
  try {
    const res = await fetch("/api/search?q=" + encodeURIComponent(q), { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    if (my !== gen || box.value.trim() !== q) return;
    render(q, data);
  } catch {}
}

function onInput() {
  const q = box.value.trim();
  clearBtn.hidden = !q;
  if (timer) clearTimeout(timer);
  if (q.length < MIN_Q) {
    gen++;
    closeSearch();
    return;
  }
  timer = setTimeout(() => run(q), DEBOUNCE_MS);
}

export function bootSearch() {
  if (!box || !resultsEl) return;
  box.addEventListener("input", onInput);
  clearBtn.addEventListener("click", () => {
    box.value = "";
    clearBtn.hidden = true;
    gen++;
    closeSearch();
    box.focus();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && box.value) {
      e.stopPropagation();
      box.value = "";
      clearBtn.hidden = true;
      gen++;
      closeSearch();
    }
  });
}
