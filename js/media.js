import { thumbsEl, MAX_IMAGES, stagedImages, viewingChatId } from "./state.js";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i;

function isImageFile(file) {
  const type = String(file.type || "");
  return type.startsWith("image/") || IMG_EXT.test(file.name || "");
}

function humanSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
  return (b / (1024 * 1024)).toFixed(1) + " MB";
}

export function isImageItem(item) {
  return !!item && item.kind !== "file";
}

// Staged composer attachments split into inline images + uploaded file refs.
export function stagedSnapshot() {
  const items = stagedImages.slice(0, MAX_IMAGES);
  return {
    images: items.filter(isImageItem).map((s) => ({
      url: s.url,
      mime: s.mime || mimeOf(s.url),
      fileName: s.fileName || ""
    })),
    files: items.filter((i) => i.kind === "file").map((i) => ({
      path: i.path,
      fileName: i.fileName || "",
      mime: i.mime || "",
      size: Number(i.size) || 0
    }))
  };
}

export function normalizeImages(images) {
  return (images || []).map((item) => {
    if (!item) return null;
    if (typeof item === "string") return { url: item, mime: mimeOf(item), fileName: "" };
    const url = item.url || "";
    if (!url) return null;
    return { url, mime: item.mime || mimeOf(url), fileName: item.fileName || "" };
  }).filter(Boolean).slice(0, MAX_IMAGES);
}

export function normalizeFiles(files) {
  return (files || []).filter((f) => f && f.path).slice(0, MAX_IMAGES).map((f) => ({
    path: String(f.path),
    fileName: String(f.fileName || ""),
    mime: String(f.mime || ""),
    size: Number(f.size) || 0
  }));
}

export function attachmentHint(items) {
  const names = (items || []).map((i) => i && i.fileName).filter(Boolean);
  const paths = (items || []).map((i) => i && i.path).filter(Boolean);
  if (!(items && items.length) && !names.length && !paths.length) return "";
  const bits = [];
  if (paths.length) {
    bits.push("Moss saved attached images to: " + paths.join(", ") + ". Use view_image with those exact paths if you need to re-inspect.");
  } else {
    bits.push("These photos are already visible in this message. Do not call view_image with guessed paths under ~/.openclaw/media/inbound — Moss did not store them under the original filename.");
  }
  if (names.length) bits.push("Original filenames: " + names.join(", ") + ".");
  return bits.join(" ");
}

// Non-image uploads arrive on the gateway host's disk before the turn; the
// model opens them with file tools instead of seeing bytes inline.
export function fileHint(files) {
  const items = normalizeFiles(files);
  if (!items.length) return "";
  const bits = [
    "Moss saved attached files to: " + items.map((f) => f.path).join(", ") +
    ". Open them with your file tools (read, or the matching document skill) using those exact paths."
  ];
  const names = items.map((f) => f.fileName).filter(Boolean);
  if (names.length) bits.push("Original filenames: " + names.join(", ") + ".");
  return bits.join(" ");
}

export function renderThumbs() {
  thumbsEl.innerHTML = "";
  thumbsEl.hidden = !stagedImages.length;
  stagedImages.forEach((item, i) => {
    const wrap = document.createElement("div");
    wrap.className = "thumb" + (isImageItem(item) ? "" : " file");
    if (isImageItem(item)) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = item.url;
      wrap.appendChild(img);
    } else {
      const chip = document.createElement("div");
      chip.className = "thumb-file";
      const name = document.createElement("span");
      name.className = "thumb-file-name";
      name.textContent = item.fileName || "file";
      const size = document.createElement("span");
      size.className = "thumb-file-size";
      size.textContent = humanSize(item.size);
      chip.appendChild(name);
      chip.appendChild(size);
      wrap.appendChild(chip);
    }
    const x = document.createElement("button");
    x.type = "button";
    x.setAttribute("aria-label", "Remove attachment");
    x.textContent = "\u00d7";
    x.addEventListener("click", () => {
      stagedImages.splice(i, 1);
      renderThumbs();
    });
    wrap.appendChild(x);
    thumbsEl.appendChild(wrap);
  });
}

export function clearStaged() {
  stagedImages.length = 0;
  renderThumbs();
}

export function mimeOf(dataUrl) {
  const m = /^data:([^;,]+)/.exec(dataUrl || "");
  return m ? m[1] : "image/jpeg";
}

export function resizeImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result || "");
      if (!src) {
        resolve("");
        return;
      }
      const img = new Image();
      img.onload = () => {
        const maxEdge = 1600;
        const w0 = img.naturalWidth || img.width || 1200;
        const h0 = img.naturalHeight || img.height || 1200;
        const scale = Math.min(1, maxEdge / Math.max(w0, h0));
        const w = Math.max(1, Math.round(w0 * scale));
        const h = Math.max(1, Math.round(h0 * scale));
        try {
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.85) || src);
        } catch (err) {
          resolve(src);
        }
      };
      img.onerror = () => resolve(src);
      img.src = src;
    };
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

async function uploadFile(file) {
  const chat = viewingChatId() || "";
  const q =
    "?name=" + encodeURIComponent(file.name || "upload") +
    "&type=" + encodeURIComponent(file.type || "application/octet-stream") +
    "&chat=" + encodeURIComponent(chat);
  const res = await fetch("/api/uploads" + q, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file
  });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  if (!j || !j.path) return null;
  return { kind: "file", path: j.path, fileName: j.fileName || file.name || "file", mime: j.mime || file.type || "", size: j.size || file.size || 0 };
}

export async function stageFiles(files) {
  const list = Array.from(files || []);
  for (const file of list) {
    if (!file) continue;
    if (stagedImages.length >= MAX_IMAGES) break;
    if (isImageFile(file)) {
      const url = await resizeImage(file);
      if (!url) continue;
      stagedImages.push({ url, mime: mimeOf(url), fileName: file.name || "" });
    } else {
      if (file.size > MAX_FILE_BYTES) continue;
      const up = await uploadFile(file).catch(() => null);
      if (up) stagedImages.push(up);
    }
  }
  renderThumbs();
}
