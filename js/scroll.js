import { log, toBottomBtn } from "./state.js";

export function logNearBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 48;
}

export function syncToBottom() {
  if (!toBottomBtn) return;
  const overflowing = log.scrollHeight > log.clientHeight + 8;
  toBottomBtn.hidden = !overflowing || logNearBottom();
}

export function stickToBottom(force) {
  if (force || logNearBottom()) log.scrollTop = log.scrollHeight;
  syncToBottom();
}
