import { input, state } from "./state.js";

const MAX_VISIBLE = 40;
let skills = [];
let visible = [];
let active = 0;
let loading = false;
let loaded = false;
let lastQuery = null;

function menu() {
  return document.getElementById("slashMenu");
}

function slashQuery(value) {
  const m = String(value || "").match(/^\s*\/([^\s]*)$/);
  return m ? m[1].toLowerCase() : null;
}

function rankSkill(skill, query) {
  if (!query) return 1;
  const name = String(skill && skill.name || "");
  const title = String(skill && skill.title || "").toLowerCase();
  const description = String(skill && skill.description || "").toLowerCase();
  if (name === query) return 4;
  if (name.startsWith(query)) return 3;
  if (title.startsWith(query)) return 2;
  if (name.includes(query) || title.includes(query) || description.includes(query)) return 1;
  return 0;
}

function matchSkills(list, query) {
  const q = String(query || "").trim().toLowerCase();
  const ranked = [];
  for (const skill of list) {
    const rank = rankSkill(skill, q);
    if (rank) ranked.push({ skill, rank });
  }
  ranked.sort((a, b) => b.rank - a.rank || a.skill.name.localeCompare(b.skill.name));
  return ranked.map((row) => row.skill).slice(0, MAX_VISIBLE);
}

function isOpen() {
  const el = menu();
  return !!(el && !el.hidden);
}

export function hideSlashMenu() {
  const el = menu();
  if (!el) return;
  el.hidden = true;
  el.innerHTML = "";
  visible = [];
  active = 0;
  lastQuery = null;
  if (input) {
    input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-expanded", "false");
  }
}

function markActive() {
  const el = menu();
  if (!el) return;
  const items = el.querySelectorAll(".slash-option");
  items.forEach((btn, i) => {
    const on = i === active;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
    if (on) {
      if (input) input.setAttribute("aria-activedescendant", btn.id);
      btn.scrollIntoView({ block: "nearest" });
    }
  });
}

function applySkill(skill) {
  if (!input || !skill) return;
  const lead = (String(input.value).match(/^\s*/) || [""])[0];
  input.value = lead + "/" + skill.name + " ";
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
  hideSlashMenu();
  input.focus();
  const n = input.value.length;
  try { input.setSelectionRange(n, n); } catch (e) {}
}

function emptyRow(text) {
  const row = document.createElement("div");
  row.className = "slash-empty";
  row.textContent = text;
  return row;
}

function render(query) {
  const el = menu();
  if (!el || !input) return;
  if (state.view === "board") {
    hideSlashMenu();
    return;
  }
  el.innerHTML = "";
  const head = document.createElement("div");
  head.className = "slash-group";
  head.textContent = "Skills";
  el.appendChild(head);

  if (loading && !skills.length) {
    el.appendChild(emptyRow("Loading skills…"));
    el.hidden = false;
    input.setAttribute("aria-expanded", "true");
    return;
  }

  visible = matchSkills(skills, query);
  if (!visible.length) {
    el.appendChild(emptyRow(skills.length ? "No matching skills" : "No skills available"));
    el.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.removeAttribute("aria-activedescendant");
    return;
  }

  if (lastQuery !== query) {
    active = 0;
    lastQuery = query;
  }
  if (active >= visible.length) active = 0;
  visible.forEach((skill, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slash-option" + (i === active ? " on" : "");
    btn.id = "slash-opt-" + i;
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", i === active ? "true" : "false");
    const name = document.createElement("span");
    name.className = "slash-option-name";
    name.textContent = "/" + skill.name;
    btn.appendChild(name);
    if (skill.description) {
      const desc = document.createElement("span");
      desc.className = "slash-option-desc";
      desc.textContent = skill.description;
      btn.appendChild(desc);
    }
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => applySkill(skill));
    btn.addEventListener("pointerenter", () => {
      active = i;
      markActive();
    });
    el.appendChild(btn);
  });
  el.hidden = false;
  input.setAttribute("aria-expanded", "true");
  markActive();
}

async function loadSkills() {
  if (loading) return;
  loading = true;
  try {
    const res = await fetch("/api/commands", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data && Array.isArray(data.skills)) skills = data.skills;
    loaded = true;
  } catch (e) {
    if (!skills.length) skills = [];
  } finally {
    loading = false;
    if (slashQuery(input && input.value) != null) render(slashQuery(input.value));
  }
}

function onInput() {
  const q = slashQuery(input && input.value);
  if (q == null) {
    hideSlashMenu();
    return;
  }
  if (!loaded) loadSkills();
  render(q);
}

function onKey(e) {
  if (!isOpen()) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    hideSlashMenu();
    return;
  }
  if (!visible.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    active = (active + 1) % visible.length;
    markActive();
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    active = (active - 1 + visible.length) % visible.length;
    markActive();
    return;
  }
  if ((e.key === "Enter" || e.key === "Tab") && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    applySkill(visible[active]);
  }
}

export function bootSlash() {
  if (!input) return;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", "slashMenu");
  input.setAttribute("aria-expanded", "false");
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", (e) => {
    const el = menu();
    if (!el || el.hidden) return;
    if (el.contains(e.target) || e.target === input) return;
    hideSlashMenu();
  }, true);
  loadSkills();
}
