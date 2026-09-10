import { log, input, sendBtn, askEl, attachBtn, attachInput, toBottomBtn, state } from "./state.js";
import { boot, checkGateway, send, clearComposer, setNav, createChat, refreshVisible } from "./chats.js";
import { stagedSnapshot, stageFiles } from "./media.js";
import { hideNoteMenu, markAllRead, bindLongPress, showNoteMenuFor } from "./board.js";
import { syncToBottom, stickToBottom } from "./scroll.js";

if (toBottomBtn) {
  log.addEventListener("scroll", syncToBottom);
  toBottomBtn.addEventListener("click", () => { stickToBottom(true); });
}

log.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-tab]");
  if (tab) {
    const block = tab.closest(".code-block");
    if (!block) return;
    block.dataset.view = tab.dataset.tab;
    block.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b === tab));
    return;
  }
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  const block = btn.closest(".code-block");
  const code = block && block.querySelector("pre code");
  if (!code) return;
  const text = code.textContent || "";
  const done = () => {
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy"; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {});
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try { if (document.execCommand("copy")) done(); } catch (err) {}
  ta.remove();
});
window.addEventListener("message", (e) => {
  const h = e && e.data && e.data.mossHtmlHeight;
  if (h == null) return;
  document.querySelectorAll("iframe.html-frame").forEach((frame) => {
    if (frame.contentWindow !== e.source) return;
    const px = Math.min(Math.max(Number(h) || 0, 80), Math.round(window.innerHeight * 0.7));
    frame.style.height = px + "px";
  });
});
document.getElementById("form").addEventListener("submit", (e) => {
  e.preventDefault();
});
sendBtn.addEventListener("click", () => {
  const text = input.value.trim();
  const images = stagedSnapshot();
  if (!text && !images.length) return;
  clearComposer();
  send(text || "(photo)", images);
});
attachBtn.addEventListener("click", () => {
  attachInput.click();
});
attachInput.addEventListener("change", () => {
  stageFiles(attachInput.files);
  attachInput.value = "";
});
document.getElementById("openNav").addEventListener("click", () => setNav(true));
document.getElementById("closeNav").addEventListener("click", () => setNav(false));
document.getElementById("scrim").addEventListener("click", () => setNav(false));
document.getElementById("newChat").addEventListener("click", () => createChat());
document.getElementById("markAllRead").addEventListener("click", () => markAllRead());
document.addEventListener("pointerdown", (e) => {
  const menu = document.getElementById("noteMenu");
  if (!menu || menu.hidden) return;
  if (menu.contains(e.target)) return;
  hideNoteMenu();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideNoteMenu();
});
bindLongPress(document.querySelector(".chat-head"), () => {
  showNoteMenuFor(document.querySelector(".chat-head"));
}, () => state.view !== "chat");
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === "Return") e.stopPropagation();
});
document.addEventListener("keydown", (e) => {
  if (askEl.hidden || state.askUi.submitting) return;
  const tag = e.target && e.target.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return;
  const n = Number(e.key);
  if (n >= 1 && n <= 4) {
    const btn = askEl.querySelectorAll(".ask-opt:not(.other)")[n - 1];
    if (btn) {
      e.preventDefault();
      btn.click();
    }
  }
});

checkGateway();
boot().then(() => {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshVisible();
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) refreshVisible();
  });
});
input.focus();
