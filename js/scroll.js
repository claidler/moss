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

// Capture the viewport before a full repaint. If the user was near the bottom,
// the restore keeps it pinned; otherwise it holds the absolute scroll offset so
// the text being read stays put while thinking streams and the log re-renders.
export function captureScroll() {
  const pinned = logNearBottom();
  const top = log.scrollTop;
  return function restoreScroll() {
    log.scrollTop = pinned ? log.scrollHeight : top;
    syncToBottom();
  };
}
