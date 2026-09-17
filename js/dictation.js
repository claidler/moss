import { input, sendBtn, micBtn, dictationStatus } from "./state.js";
import { syncBusy } from "./chats.js";

const MAX_MS = 120000;
let rec = null;
let chunks = [];
let stream = null;
let timer = null;
let mode = "idle";

function supported() {
  const secure =
    window.isSecureContext ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1";
  return !!(
    secure &&
    navigator.mediaDevices &&
    navigator.mediaDevices.getUserMedia &&
    window.MediaRecorder
  );
}

function pickMime() {
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function setStatus(text, err) {
  if (!dictationStatus) return;
  if (!text) {
    dictationStatus.hidden = true;
    dictationStatus.textContent = "";
    dictationStatus.classList.remove("err");
    return;
  }
  dictationStatus.hidden = false;
  dictationStatus.textContent = text;
  dictationStatus.classList.toggle("err", !!err);
}

function paint() {
  if (!micBtn) return;
  micBtn.classList.toggle("recording", mode === "recording");
  micBtn.classList.toggle("transcribing", mode === "transcribing");
  micBtn.setAttribute("aria-pressed", mode === "recording" ? "true" : "false");
  micBtn.disabled = mode === "transcribing";
  if (mode === "idle") {
    syncBusy();
    return;
  }
  if (sendBtn) sendBtn.disabled = true;
  if (input) input.setAttribute("placeholder", mode === "recording" ? "Listening…" : "Transcribing…");
  if (mode === "recording") setStatus("Listening — tap the mic to stop");
  else setStatus("Transcribing…");
}

function stopTracks() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

function fillComposer(text) {
  const t = String(text || "").trim();
  if (!t) {
    setStatus("No speech detected — try again", true);
    return;
  }
  const cur = (input.value || "").trim();
  input.value = cur ? cur + " " + t : t;
  input.dispatchEvent(new Event("input"));
  input.focus();
  setStatus("");
}

function upload(blob) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/transcribe");
    xhr.setRequestHeader("Content-Type", blob.type || "audio/webm");
    xhr.withCredentials = true;
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        data = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.text || "");
      else reject(new Error(data.error || "transcribe failed"));
    };
    xhr.onerror = () => reject(new Error("network"));
    xhr.send(blob);
  });
}

async function onStop() {
  stopTracks();
  const type = (rec && rec.mimeType) || "audio/webm";
  const blob = new Blob(chunks, { type: String(type).split(";")[0] || "audio/webm" });
  rec = null;
  chunks = [];
  mode = "transcribing";
  paint();
  if (!blob.size) {
    mode = "idle";
    paint();
    setStatus("No audio captured — try again", true);
    return;
  }
  try {
    const text = await upload(blob);
    fillComposer(text);
  } catch (e) {
    setStatus((e && e.message) || "transcribe failed", true);
  }
  mode = "idle";
  paint();
}

function stopRec() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (rec && rec.state !== "inactive") rec.stop();
  else {
    stopTracks();
    mode = "idle";
    paint();
  }
}

async function startRec() {
  const mime = pickMime();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    setStatus("Microphone blocked", true);
    return;
  }
  chunks = [];
  rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  rec.onstop = () => {
    onStop();
  };
  rec.start(250);
  mode = "recording";
  paint();
  timer = setTimeout(stopRec, MAX_MS);
}

function toggle() {
  if (mode === "transcribing") return;
  if (mode === "recording") {
    stopRec();
    return;
  }
  startRec();
}

export function bindDictation() {
  if (!micBtn) return;
  if (!supported()) {
    micBtn.hidden = true;
    return;
  }
  micBtn.addEventListener("click", toggle);
  window.addEventListener("pagehide", () => {
    if (mode === "recording") stopRec();
    else stopTracks();
  });
}
