import { askEl, state, isLiveView } from "./state.js";
import { pendingQuestions, upsertQuestion } from "./tools.js";

export function resetAskUi(id) {
  if (state.askUi.id === id) return;
  state.askUi = { id: id || "", step: 0, picked: {}, other: "", submitting: false, error: "" };
}

export function renderAsk(chat) {
  const pending = pendingQuestions(chat && chat.questions);
  if (!pending.length) {
    askEl.hidden = true;
    askEl.innerHTML = "";
    resetAskUi("");
    return;
  }
  const q = pending[0];
  resetAskUi(q.id);
  const items = q.questions || [];
  if (state.askUi.step >= items.length) state.askUi.step = Math.max(0, items.length - 1);
  const item = items[state.askUi.step] || items[0];
  const multi = !!(item && item.multiSelect);
  const selected = state.askUi.picked[item.questionId] || [];
  const last = state.askUi.step >= items.length - 1;
  askEl.hidden = false;
  askEl.innerHTML = "";
  const top = document.createElement("div");
  top.className = "ask-top";
  const kicker = document.createElement("div");
  kicker.className = "ask-kicker";
  kicker.textContent = "Question";
  top.appendChild(kicker);
  if (items.length > 1) {
    const step = document.createElement("div");
    step.className = "ask-step";
    step.textContent = (state.askUi.step + 1) + " / " + items.length;
    top.appendChild(step);
  }
  askEl.appendChild(top);
  if (item.header) {
    const h = document.createElement("div");
    h.className = "ask-header";
    h.textContent = item.header;
    askEl.appendChild(h);
  }
  const prompt = document.createElement("div");
  prompt.className = "ask-prompt";
  prompt.textContent = item.question || "Choose one";
  askEl.appendChild(prompt);
  const opts = document.createElement("div");
  opts.className = "ask-opts";
  const options = item.options || [];
  options.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ask-opt" + (multi ? " multi" : "") + (selected.includes(opt.label) ? " selected" : "");
    btn.disabled = state.askUi.submitting;
    const mark = document.createElement("span");
    mark.className = "ask-mark";
    mark.textContent = selected.includes(opt.label) ? "✓" : "";
    const copy = document.createElement("span");
    copy.className = "ask-copy";
    const strong = document.createElement("strong");
    strong.textContent = opt.label;
    copy.appendChild(strong);
    if (opt.description) {
      const small = document.createElement("small");
      small.textContent = opt.description;
      copy.appendChild(small);
    }
    const kbd = document.createElement("span");
    kbd.className = "ask-kbd";
    kbd.textContent = String(i + 1);
    btn.appendChild(mark);
    btn.appendChild(copy);
    btn.appendChild(kbd);
    btn.addEventListener("click", () => chooseAskOption(chat, q, item, opt.label, false));
    opts.appendChild(btn);
  });
  const otherBtn = document.createElement("button");
  otherBtn.type = "button";
  otherBtn.className = "ask-opt other" + (state.askUi.other.trim() && selected.includes(state.askUi.other.trim()) ? " selected" : "");
  otherBtn.disabled = state.askUi.submitting;
  const otherMark = document.createElement("span");
  otherMark.className = "ask-mark";
  const otherCopy = document.createElement("span");
  otherCopy.className = "ask-copy";
  const otherInput = document.createElement("input");
  otherInput.className = "ask-other";
  otherInput.type = "text";
  otherInput.maxLength = 500;
  otherInput.placeholder = "Other…";
  otherInput.value = state.askUi.other;
  otherInput.disabled = state.askUi.submitting;
  otherInput.addEventListener("input", () => {
    state.askUi.other = otherInput.value;
  });
  otherInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const text = otherInput.value.trim();
      if (text) chooseAskOption(chat, q, item, text, true);
    }
  });
  otherCopy.appendChild(otherInput);
  otherBtn.appendChild(otherMark);
  otherBtn.appendChild(otherCopy);
  otherBtn.addEventListener("click", () => otherInput.focus());
  opts.appendChild(otherBtn);
  askEl.appendChild(opts);
  const foot = document.createElement("div");
  foot.className = "ask-foot";
  if (state.askUi.error) {
    const err = document.createElement("div");
    err.className = "ask-err";
    err.textContent = state.askUi.error;
    foot.appendChild(err);
  }
  if (state.askUi.step > 0) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "ask-back";
    back.textContent = "Back";
    back.disabled = state.askUi.submitting;
    back.addEventListener("click", () => {
      state.askUi.step -= 1;
      renderAsk(chat);
    });
    foot.appendChild(back);
  }
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "ask-skip";
  skip.textContent = "Skip";
  skip.disabled = state.askUi.submitting;
  skip.addEventListener("click", () => sendAsk(chat, q, true));
  foot.appendChild(skip);
  const needSend = multi || !options.length || !last || state.askUi.other.trim();
  if (needSend || items.length > 1) {
    const send = document.createElement("button");
    send.type = "button";
    send.className = "ask-send";
    send.textContent = last ? (state.askUi.submitting ? "Sending…" : "Send") : "Continue";
    send.disabled = state.askUi.submitting;
    send.addEventListener("click", () => {
      const text = state.askUi.other.trim();
      if (text) {
        chooseAskOption(chat, q, item, text, true);
        return;
      }
      if (!last) {
        if (!(state.askUi.picked[item.questionId] || []).length) {
          state.askUi.error = "Pick an option";
          renderAsk(chat);
          return;
        }
        state.askUi.step += 1;
        state.askUi.error = "";
        renderAsk(chat);
        return;
      }
      sendAsk(chat, q, false);
    });
    foot.appendChild(send);
  }
  askEl.appendChild(foot);
}

export function chooseAskOption(chat, q, item, label, isOther) {
  if (!item || state.askUi.submitting) return;
  const key = item.questionId;
  if (item.multiSelect) {
    const cur = state.askUi.picked[key] ? state.askUi.picked[key].slice() : [];
    const i = cur.indexOf(label);
    if (i >= 0) cur.splice(i, 1);
    else cur.push(label);
    state.askUi.picked[key] = cur;
    if (isOther) state.askUi.other = label;
    state.askUi.error = "";
    renderAsk(chat);
    return;
  }
  state.askUi.picked[key] = [label];
  if (isOther) state.askUi.other = label;
  state.askUi.error = "";
  const last = state.askUi.step >= (q.questions || []).length - 1;
  if (!last) {
    state.askUi.step += 1;
    renderAsk(chat);
    return;
  }
  sendAsk(chat, q, false);
}

export async function sendAsk(chat, q, cancel) {
  if (!chat || !q || state.askUi.submitting) return;
  const answers = {};
  if (!cancel) {
    for (const item of q.questions || []) {
      const vals = (state.askUi.picked[item.questionId] || []).map((s) => String(s).trim()).filter(Boolean);
      if (!vals.length) {
        state.askUi.error = "Pick an option";
        renderAsk(chat);
        return;
      }
      answers[item.questionId] = item.multiSelect ? vals : [vals[vals.length - 1]];
    }
  }
  state.askUi.submitting = true;
  state.askUi.error = "";
  renderAsk(chat);
  try {
    const res = await fetch("/api/chats/" + chat.id + "/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cancel ? { id: q.id, cancel: true } : { id: q.id, answers })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    const next = data.questions || [];
    if (next.length) chat.questions = next;
    else upsertQuestion(chat.questions || (chat.questions = []), Object.assign({}, q, {
      status: cancel ? "cancelled" : "answered",
      answers: cancel ? undefined : { answers }
    }));
    const last = (chat.messages || [])[(chat.messages || []).length - 1];
    if (last && last.role === "assistant") {
      last.questions = slimClientQuestions(chat.questions);
    } else {
      chat.liveQuestions = slimClientQuestions(chat.questions);
    }
    await state.hooks.saveChat(chat);
    if (isLiveView(chat.id)) {
      if (state.view === "chat") state.hooks.paintChat(chat);
      else {
        state.hooks.syncBusy();
        renderAsk(chat);
      }
    }
  } catch (e) {
    state.askUi.submitting = false;
    state.askUi.error = (e && e.message) || "Could not send";
    if (isLiveView(chat.id)) renderAsk(chat);
  }
}

export function slimClientQuestions(questions) {
  return (questions || []).filter((q) => q && q.id).map((q) => ({
    id: q.id,
    status: q.status || "pending",
    createdAtMs: q.createdAtMs,
    expiresAtMs: q.expiresAtMs,
    questions: q.questions || [],
    answers: q.answers
  }));
}
