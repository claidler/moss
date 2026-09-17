import { state, viewingChatId } from "./state.js";

// Canonical ladder plus provider-profile extras (adaptive/max/ultra).
// The picker list itself comes from gateway thinkingLevels per model.
const THINK_LABELS = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  adaptive: "Adaptive",
  max: "Max",
  ultra: "Ultra",
};
const NEEDLE = {
  off: -70,
  minimal: -42,
  low: -18,
  medium: 18,
  high: 42,
  xhigh: 62,
  adaptive: 18,
  max: 78,
  ultra: 90,
};

let catalog = { models: [], defaultModel: "", defaultThinking: null };
let bound = false;
let searchQuery = "";

function $(id) {
  return document.getElementById(id);
}

function thinkLabel(id) {
  const key = String(id || "").trim().toLowerCase();
  return THINK_LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Thinking");
}

// Prefer the gateway-declared label (binary providers ship "on"); keep it
// when it differs from the id, otherwise use the canonical label.
function displayLabel(level) {
  const raw = String((level && level.label) || "").trim();
  const id = String((level && level.id) || "").trim().toLowerCase();
  if (!raw || raw.toLowerCase() === id) return thinkLabel(id);
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function chatById(id) {
  return state.chats.find((c) => c.id === id);
}

function currentChat() {
  return chatById(viewingChatId());
}

function entryFor(id) {
  if (!id) return catalog.models.find((m) => m.isDefault) || catalog.models[0] || null;
  return catalog.models.find((m) => m.id === id) || null;
}

function selectedModel(chat) {
  return (chat && chat.model) || "";
}

function selectedThinking(chat) {
  return (chat && chat.thinkingLevel) || "";
}

function effectiveModel(chat) {
  return selectedModel(chat) || catalog.defaultModel || "";
}

function effectiveThinking(chat) {
  const explicit = selectedThinking(chat);
  if (explicit) return explicit;
  const entry = entryFor(effectiveModel(chat));
  return (entry && entry.thinkingDefault) || catalog.defaultThinking || "off";
}

function closePickers(except) {
  ["modelPick", "thinkPick"].forEach((id) => {
    const el = $(id);
    if (el && el !== except) el.open = false;
  });
}

function setNeedle(level) {
  const needle = document.querySelector("#thinkGauge .chip-effort-needle");
  if (!needle) return;
  const deg = NEEDLE[level] != null ? NEEDLE[level] : 0;
  needle.style.transform = "rotate(" + deg + "deg)";
}

export function waitSettings(chat) {
  return chat && chat.settingsChain ? chat.settingsChain : Promise.resolve();
}

function modelButton(entry, selectedId, inheritDefault) {
  const selected = inheritDefault ? entry.isDefault : entry.id === selectedId;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chip-option" + (selected ? " on" : "");
  btn.setAttribute("role", "option");
  btn.setAttribute("aria-selected", selected ? "true" : "false");
  btn.dataset.model = entry.isDefault ? "" : entry.id;
  const copy = document.createElement("span");
  copy.className = "chip-option-copy";
  const title = document.createElement("span");
  title.className = "chip-option-title";
  title.textContent = entry.name || entry.id;
  copy.appendChild(title);
  if (entry.isDefault) {
    const badge = document.createElement("span");
    badge.className = "chip-option-badge";
    badge.textContent = "Default";
    copy.appendChild(badge);
  }
  btn.appendChild(copy);
  if (selected) {
    const mark = document.createElement("span");
    mark.className = "chip-option-check";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "✓";
    btn.appendChild(mark);
  }
  return btn;
}

function renderModelMenu(chat) {
  const menu = $("modelMenu");
  if (!menu) return;
  menu.innerHTML = "";
  const search = document.createElement("input");
  search.id = "modelSearch";
  search.className = "chip-search";
  search.type = "search";
  search.placeholder = "Search models";
  search.value = searchQuery;
  search.autocomplete = "off";
  search.addEventListener("input", () => {
    searchQuery = search.value;
    renderModelMenu(currentChat() || chat);
    const next = $("modelSearch");
    if (next) {
      next.focus();
      const n = next.value.length;
      try { next.setSelectionRange(n, n); } catch (e) {}
    }
  });
  search.addEventListener("keydown", (e) => e.stopPropagation());
  menu.appendChild(search);

  const q = searchQuery.trim().toLowerCase();
  const selectedId = selectedModel(chat);
  const inheritDefault = !selectedId;
  const groups = [];
  const seen = new Map();
  catalog.models.forEach((m) => {
    const hay = ((m.name || "") + " " + (m.id || "") + " " + (m.providerLabel || "")).toLowerCase();
    if (q && !hay.includes(q)) return;
    const key = m.providerLabel || m.provider || "Other";
    if (!seen.has(key)) {
      seen.set(key, []);
      groups.push(key);
    }
    seen.get(key).push(m);
  });
  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "chip-empty";
    empty.textContent = catalog.models.length ? "No matching models" : "Loading models…";
    menu.appendChild(empty);
    return;
  }
  groups.forEach((key) => {
    const head = document.createElement("div");
    head.className = "chip-group";
    head.textContent = key;
    menu.appendChild(head);
    seen.get(key).forEach((entry) => {
      const btn = modelButton(entry, selectedId, inheritDefault);
      btn.addEventListener("click", () => pickModel(btn.dataset.model || ""));
      menu.appendChild(btn);
    });
  });
}

function renderThinkMenu(chat) {
  const menu = $("thinkMenu");
  if (!menu) return;
  menu.innerHTML = "";
  const entry = entryFor(effectiveModel(chat));
  const levels = (entry && entry.thinkingLevels && entry.thinkingLevels.length)
    ? entry.thinkingLevels
    : [{ id: "off", label: "Off" }, { id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }];
  const current = effectiveThinking(chat);
  const inherit = !selectedThinking(chat);
  levels.forEach((level) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip-option" + (level.id === current ? " on" : "");
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", level.id === current ? "true" : "false");
    btn.dataset.level = level.id;
    const copy = document.createElement("span");
    copy.className = "chip-option-copy";
    const title = document.createElement("span");
    title.className = "chip-option-title";
    title.textContent = displayLabel(level);
    copy.appendChild(title);
    if (inherit && entry && entry.thinkingDefault === level.id) {
      const badge = document.createElement("span");
      badge.className = "chip-option-badge";
      badge.textContent = "Default";
      copy.appendChild(badge);
    }
    btn.appendChild(copy);
    if (level.id === current) {
      const mark = document.createElement("span");
      mark.className = "chip-option-check";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = "✓";
      btn.appendChild(mark);
    }
    btn.addEventListener("click", () => pickThinking(level.id));
    menu.appendChild(btn);
  });
}

export function syncModelBar(chat) {
  const bar = $("modelBar");
  if (!bar) return;
  const modelLabel = $("modelLabel");
  const thinkLabelEl = $("thinkLabel");
  const thinkPick = $("thinkPick");
  const entry = entryFor(effectiveModel(chat));
  if (modelLabel) modelLabel.textContent = (entry && (entry.name || entry.id)) || "Model";
  const level = effectiveThinking(chat);
  if (thinkLabelEl) thinkLabelEl.textContent = thinkLabel(level);
  setNeedle(level);
  const levels = (entry && entry.thinkingLevels) || [];
  if (thinkPick) thinkPick.hidden = catalog.models.length > 0 && levels.length === 0;
  if ($("modelPick") && $("modelPick").open) renderModelMenu(chat);
  if ($("thinkPick") && $("thinkPick").open) renderThinkMenu(chat);
}

function persistSettings(chat) {
  const body = {
    model: chat.model || "",
    thinkingLevel: chat.thinkingLevel || "",
  };
  chat.settingsChain = fetch("/api/chats/" + chat.id + "/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((res) => {
    if (!res.ok) throw new Error("HTTP " + res.status);
  }).catch(() => {});
  return chat.settingsChain;
}

function pickModel(id) {
  const chat = currentChat();
  if (!chat) return;
  const next = id || "";
  const prev = selectedModel(chat);
  const prevThink = selectedThinking(chat);
  chat.model = next;
  const entry = entryFor(effectiveModel(chat));
  const allowed = (entry && entry.thinkingLevels || []).map((l) => l.id);
  if (chat.thinkingLevel && allowed.length && !allowed.includes(chat.thinkingLevel)) {
    chat.thinkingLevel = "";
  }
  closePickers();
  syncModelBar(chat);
  if (next !== prev || selectedThinking(chat) !== prevThink) persistSettings(chat);
}

function pickThinking(id) {
  const chat = currentChat();
  if (!chat) return;
  const entry = entryFor(effectiveModel(chat));
  const next = id || "";
  const inherit = entry && entry.thinkingDefault === next && !chat.model ? "" : next;
  const prev = selectedThinking(chat);
  chat.thinkingLevel = inherit;
  closePickers();
  syncModelBar(chat);
  if ((chat.thinkingLevel || "") !== prev) persistSettings(chat);
}

function bindPickers() {
  if (bound) return;
  bound = true;
  const modelPick = $("modelPick");
  const thinkPick = $("thinkPick");
  if (modelPick) {
    modelPick.addEventListener("toggle", () => {
      if (modelPick.open) {
        closePickers(modelPick);
        renderModelMenu(currentChat());
        const search = $("modelSearch");
        if (search) search.focus();
      }
    });
  }
  if (thinkPick) {
    thinkPick.addEventListener("toggle", () => {
      if (thinkPick.open) {
        closePickers(thinkPick);
        renderThinkMenu(currentChat());
      }
    });
  }
  document.addEventListener("pointerdown", (e) => {
    const bar = $("modelBar");
    if (!bar || bar.contains(e.target)) return;
    closePickers();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePickers();
  });
}

export async function bootModels() {
  bindPickers();
  syncModelBar(currentChat());
  try {
    const res = await fetch("/api/models", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data && Array.isArray(data.models)) catalog = data;
  } catch (e) {}
  syncModelBar(currentChat());
}
