// Moss — slash-command skill catalog from gateway commands.list.
const { json } = require("./http-utils");
const { gatewayRpc } = require("./gateway");
const { AGENT_ID } = require("./config");

let catalogCache = { at: 0, payload: null };
const CATALOG_MS = 60_000;

function stripSlash(value) {
  return String(value || "").trim().replace(/^\//, "");
}

function projectSkills(raw) {
  const commands = Array.isArray(raw && raw.commands) ? raw.commands : [];
  const skills = [];
  const seen = new Set();
  for (const cmd of commands) {
    if (!cmd || typeof cmd !== "object") continue;
    if (String(cmd.source || "").toLowerCase() !== "skill") continue;
    const name = stripSlash(cmd.name).toLowerCase();
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const title = stripSlash(cmd.skillDisplayName || cmd.name);
    skills.push({
      name,
      title: title || name,
      description: String(cmd.description || "").trim(),
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills };
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

function matchSkills(skills, query) {
  const q = String(query || "").trim().toLowerCase();
  const list = Array.isArray(skills) ? skills : [];
  const ranked = [];
  for (const skill of list) {
    const rank = rankSkill(skill, q);
    if (rank) ranked.push({ skill, rank });
  }
  ranked.sort((a, b) => b.rank - a.rank || a.skill.name.localeCompare(b.skill.name));
  return ranked.map((row) => row.skill);
}

async function listSkills(force) {
  if (!force && catalogCache.payload && Date.now() - catalogCache.at < CATALOG_MS) {
    return catalogCache.payload;
  }
  const raw = await gatewayRpc(
    ["operator.read"],
    "commands.list",
    { agentId: AGENT_ID, includeArgs: true, scope: "text" },
    25000
  );
  const payload = projectSkills(raw);
  catalogCache = { at: Date.now(), payload };
  return payload;
}

async function api(req, res) {
  const url = (req.url || "").split("?")[0];
  if (url !== "/api/commands" || req.method !== "GET") return false;
  try {
    json(res, 200, await listSkills());
  } catch (e) {
    if (catalogCache.payload) json(res, 200, catalogCache.payload);
    else json(res, 502, { error: (e && e.message) || "commands.list failed" });
  }
  return true;
}

module.exports = {
  api,
  listSkills,
  projectSkills,
  matchSkills,
};
