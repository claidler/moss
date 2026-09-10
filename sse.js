// Moss — SSE/chunk helpers: gateway event mapping and completion-chunk formatting.
const { clipText } = require("./text");

// Gateway `agent`/`session.tool` event -> normalized tool or thinking entry.
function fromAgentTool(payload) {
  const data = payload && payload.data;
  if (!data || typeof data !== "object") return null;
  const name = String(data.name || "tool");
  const id = String(data.toolCallId || data.id || name);
  const phase = String(data.phase || "");
  if (phase !== "start" && phase !== "result" && phase !== "update" && phase !== "error") return null;
  return {
    id,
    name,
    phase: phase === "update" ? "start" : phase,
    args: clipText(data.args, 4000),
    result: clipText(data.result, 8000),
    isError: Boolean(data.isError),
  };
}

function fromThinkingPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const stream = String(payload.stream || "");
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
  if (stream === "thinking") {
    const text = String(data.text || data.delta || "").trim();
    if (!text) return null;
    return { id: String(data.itemId || "thinking"), text: clipText(text, 8000), replace: true };
  }
  if (stream === "item") {
    const kind = String(data.kind || "");
    const phase = String(data.phase || "");
    if (kind !== "preamble" && kind !== "commentary") return null;
    if (phase && phase !== "update" && phase !== "start") return null;
    const text = String(data.progressText || data.text || data.delta || "").trim();
    if (!text) return null;
    return { id: String(data.itemId || data.title || "preamble"), text: clipText(text, 8000), replace: true };
  }
  if (String(data.phase || "") === "commentary") {
    const text = String(data.text || data.delta || "").trim();
    if (!text) return null;
    return { id: String(data.itemId || "commentary"), text: clipText(text, 8000), replace: true };
  }
  return null;
}

function chunkPayload(identity, delta) {
  return {
    id: identity.id || "chatcmpl_moss",
    object: "chat.completion.chunk",
    created: identity.created || Math.floor(Date.now() / 1000),
    model: identity.model || "openclaw/default",
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

function toolSse(identity, tool) {
  return "data: " + JSON.stringify(chunkPayload(identity, { moss_tool: tool })) + "\n\n";
}

function thinkingSse(identity, thinking) {
  return "data: " + JSON.stringify(chunkPayload(identity, { moss_thinking: { items: thinking } })) + "\n\n";
}

function questionSse(identity, question) {
  return "data: " + JSON.stringify(chunkPayload(identity, { moss_question: question })) + "\n\n";
}

module.exports = {
  fromAgentTool,
  fromThinkingPayload,
  chunkPayload,
  toolSse,
  thinkingSse,
  questionSse,
};
