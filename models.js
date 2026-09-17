// Moss — OpenClaw model catalog and per-chat model/thinking overrides.
const { json, readBody } = require("./http-utils");
const { loadStore, saveStore, touchChat } = require("./store");
const { gatewayRpc } = require("./gateway");
const { applyRunOverlay } = require("./runs");

// Canonical ladder plus provider-profile extras (adaptive/max/ultra).
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
const THINK_IDS = new Set(Object.keys(THINK_LABELS));
const PROVIDER_LABELS = {
  spark: "Spark",
  xai: "xAI",
  openrouter: "OpenRouter",
  groq: "Groq",
  novita: "Novita",
  openai: "OpenAI",
};

let catalogCache = { at: 0, payload: null };
const CATALOG_MS = 60_000;

function capitalize(text) {
  const s = String(text || "");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function thinkLabel(id) {
  const key = String(id || "").trim().toLowerCase();
  return THINK_LABELS[key] || capitalize(key);
}

// Keep provider-declared labels (binary "on", "Maximum"); fall back to the
// canonical label when the gateway just echoes the level id back.
function levelLabel(id, rawLabel) {
  const raw = String(rawLabel || "").trim();
  if (!raw || raw.toLowerCase() === id) return thinkLabel(id);
  return capitalize(raw);
}

function providerLabel(id) {
  const key = String(id || "").trim();
  if (!key) return "";
  return PROVIDER_LABELS[key.toLowerCase()] || key;
}

function modelRef(m) {
  const id = String((m && m.id) || "").trim();
  const provider = String((m && m.provider) || "").trim();
  if (!id) return "";
  if (provider && (id === provider || id.startsWith(provider + "/"))) return id;
  return provider ? provider + "/" + id : id;
}

function projectCatalog(raw) {
  const models = ((raw && raw.models) || [])
    .filter((m) => m && m.available !== false)
    .map((m) => {
      const levels = (Array.isArray(m.thinkingLevels) ? m.thinkingLevels : [])
        .map((x) => {
          const id = String((x && x.id) || x || "").trim().toLowerCase();
          if (!id) return null;
          return { id, label: levelLabel(id, x && x.label) };
        })
        .filter(Boolean);
      const tags = Array.isArray(m.tags) ? m.tags : [];
      return {
        id: modelRef(m),
        name: String(m.name || m.alias || m.id || "").trim(),
        provider: String(m.provider || "").trim(),
        providerLabel: providerLabel(m.provider),
        thinkingLevels: levels,
        thinkingDefault: m.thinkingDefault ? String(m.thinkingDefault).trim().toLowerCase() : null,
        isDefault: tags.includes("default"),
        configured: tags.includes("configured") || tags.includes("default"),
      };
    })
    .filter((m) => m.id);
  models.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    const p = a.provider.localeCompare(b.provider);
    if (p) return p;
    return a.name.localeCompare(b.name);
  });
  const def = models.find((m) => m.isDefault) || models[0] || null;
  return {
    models,
    defaultModel: def ? def.id : "",
    defaultThinking: def && def.thinkingDefault ? def.thinkingDefault : null,
  };
}

async function listModels(force) {
  if (!force && catalogCache.payload && Date.now() - catalogCache.at < CATALOG_MS) {
    return catalogCache.payload;
  }
  const raw = await gatewayRpc(["operator.read"], "models.list", { view: "configured" }, 25000);
  const payload = projectCatalog(raw);
  catalogCache = { at: Date.now(), payload };
  return payload;
}

function chatOverrides(chatId) {
  if (!chatId) return { model: "", thinkingLevel: "" };
  try {
    const store = loadStore();
    const chat = store.chats.find((c) => c.id === chatId);
    return {
      model: chat && typeof chat.model === "string" ? chat.model.trim() : "",
      thinkingLevel: chat && typeof chat.thinkingLevel === "string" ? chat.thinkingLevel.trim() : "",
    };
  } catch {
    return { model: "", thinkingLevel: "" };
  }
}

async function applyChatSession(chatId, model, thinkingLevel) {
  if (!chatId) return false;
  const params = { key: "moss-" + chatId };
  params.model = model ? model : null;
  params.thinkingLevel = thinkingLevel ? thinkingLevel : null;
  try {
    await gatewayRpc(
      ["operator.write", "operator.admin"],
      "sessions.patch",
      params,
      12000
    );
    return true;
  } catch (e) {
    console.log("moss-model patch skipped:", e && e.message);
    return false;
  }
}

function normalizeSettings(body, catalog) {
  let model = body && body.model != null ? String(body.model).trim() : "";
  let thinkingLevel = body && body.thinkingLevel != null ? String(body.thinkingLevel).trim().toLowerCase() : "";
  if (thinkingLevel && !THINK_IDS.has(thinkingLevel)) thinkingLevel = "";
  const models = (catalog && catalog.models) || [];
  const defaultModel = (catalog && catalog.defaultModel) || "";
  if (model && defaultModel && model === defaultModel) model = "";
  if (thinkingLevel) {
    const entry = models.find((m) => m.id === (model || defaultModel));
    const allowed = entry && Array.isArray(entry.thinkingLevels)
      ? entry.thinkingLevels.map((l) => l.id)
      : [];
    if (allowed.length && !allowed.includes(thinkingLevel)) thinkingLevel = "";
  }
  return { model, thinkingLevel };
}

async function api(req, res) {
  const url = (req.url || "").split("?")[0];
  if (url === "/api/models" && req.method === "GET") {
    try {
      json(res, 200, await listModels());
    } catch (e) {
      if (catalogCache.payload) json(res, 200, catalogCache.payload);
      else json(res, 502, { error: (e && e.message) || "models.list failed" });
    }
    return true;
  }
  const m = url.match(/^\/api\/chats\/([^/]+)\/settings$/);
  if (!m || req.method !== "PUT") return false;
  const id = m[1];
  const store = loadStore();
  const chat = store.chats.find((c) => c.id === id);
  if (!chat) {
    json(res, 404, { error: "missing" });
    return true;
  }
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  } catch {
    json(res, 400, { error: "bad json" });
    return true;
  }
  let catalog = catalogCache.payload;
  try {
    catalog = await listModels();
  } catch (e) {
    if (!catalog) catalog = { models: [], defaultModel: "", defaultThinking: null };
  }
  const next = normalizeSettings(body, catalog);
  if (next.model) chat.model = next.model;
  else delete chat.model;
  if (next.thinkingLevel) chat.thinkingLevel = next.thinkingLevel;
  else delete chat.thinkingLevel;
  chat.updatedAt = Date.now();
  touchChat(store, chat);
  saveStore(store);
  applyChatSession(id, next.model, next.thinkingLevel).catch(() => {});
  json(res, 200, applyRunOverlay(chat));
  return true;
}

module.exports = {
  api,
  listModels,
  chatOverrides,
  applyChatSession,
  projectCatalog,
  modelRef,
};
