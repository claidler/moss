export const log = document.getElementById("log");
export const input = document.getElementById("input");
export const sendBtn = document.getElementById("send");
export const stopBtn = document.getElementById("stop");
export const statusEl = document.getElementById("status");
export const botsEl = document.getElementById("bots");
export const chatTitle = document.getElementById("chatTitle");
export const headAvatar = document.getElementById("headAvatar");
export const askEl = document.getElementById("ask");
export const toBottomBtn = document.getElementById("toBottom");
export const attachBtn = document.getElementById("attachBtn");
export const attachInput = document.getElementById("attachInput");
export const micBtn = document.getElementById("micBtn");
export const dictationStatus = document.getElementById("dictationStatus");
export const thumbsEl = document.getElementById("thumbs");
export const MAX_IMAGES = 8;
export const stagedImages = [];
export const state = {
  chats: [],
  activeId: null,
  stamped: false,
  emptyEl: null,
  askUi: { id: "", step: 0, picked: {}, other: "", submitting: false, error: "" },
  view: "chat",
  notes: [],
  notesUnread: 0,
  noteOpen: null,
  noteChatId: null,
  noteContent: "",
  switchGen: 0,
  notesTimer: null,
  notesSeen: new Set(),
  notesReady: false,
  suppressBoardClick: false,
  noteMenuTimer: null,
  pollTimer: null,
  pollInFlight: false,
  hooks: {}
};

export function viewingChatId() {
  if (state.view === "article") return state.noteChatId;
  if (state.view === "board") return null;
  return state.activeId;
}

export function isLiveView(chatId) {
  return !!chatId && viewingChatId() === chatId;
}
