// Persist Moss photo uploads to the OpenClaw workspace so view_image
// can use a real path instead of guessing media/inbound filenames.
const fs = require("fs");
const path = require("path");
const { OPENCLAW_DIR } = require("./config");

const UPLOAD_DIR = path.join(OPENCLAW_DIR, "workspace", "moss-uploads");

function sanitizeUploadName(name) {
  const base = path
    .basename(String(name || "image"))
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return base || "image.jpg";
}

function extFor(mime, fileName) {
  const fromName = path.extname(sanitizeUploadName(fileName)).toLowerCase();
  if (fromName && fromName.length <= 8) return fromName;
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".jpg";
}

function decodeDataUrl(dataUrl) {
  const raw = String(dataUrl || "");
  const m = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(raw);
  if (!m) return null;
  try {
    return { mime: m[1], buf: Buffer.from(m[2], "base64") };
  } catch {
    return null;
  }
}

// Store any raw upload (photo, PDF, doc, text) under the managed upload dir.
function persistUpload(chatId, index, fileName, buf, mime) {
  if (!buf || !buf.length) return null;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  const ext = extFor(mime, fileName);
  const stem = sanitizeUploadName(fileName).replace(/\.[^.]+$/, "") || "upload";
  const id = String(chatId || "chat").replace(/[^\w.-]+/g, "_").slice(0, 32);
  const outName = id + "-" + Date.now() + "-" + index + "-" + stem + ext;
  const outPath = path.join(UPLOAD_DIR, outName);
  fs.writeFileSync(outPath, buf, { mode: 0o600 });
  return {
    path: outPath,
    fileName: sanitizeUploadName(fileName),
    mime: String(mime || "application/octet-stream"),
    size: buf.length
  };
}

function persistDataUrlImage(chatId, index, fileName, dataUrl) {
  const decoded = decodeDataUrl(dataUrl);
  if (!decoded || !decoded.buf.length) return null;
  return persistUpload(chatId, index, fileName, decoded.buf, decoded.mime);
}

// True when p is an existing file inside the managed upload directory.
function isManagedUploadPath(p) {
  if (!p) return false;
  const abs = path.resolve(String(p));
  if (abs !== UPLOAD_DIR && !abs.startsWith(UPLOAD_DIR + path.sep)) return false;
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function attachmentNote(paths, names) {
  const bits = [];
  if (paths && paths.length) {
    bits.push(
      "Moss saved attached images to: " +
        paths.join(", ") +
        ". Use view_image with those exact paths if you need to re-inspect."
    );
  } else {
    bits.push(
      "These photos are already visible in this message. Do not call view_image with guessed paths under ~/.openclaw/media/inbound — Moss did not store them under the original filename."
    );
  }
  if (names && names.length) bits.push("Original filenames: " + names.join(", ") + ".");
  return bits.join(" ");
}

// Note for non-image uploads (documents, sheets, audio, ...): the bytes are
// not sent to the model inline; the model opens them from disk with tools.
function fileAttachmentNote(paths, names) {
  if (!paths || !paths.length) return "";
  const bits = [
    "Moss saved attached files to: " +
      paths.join(", ") +
      ". Open them with your file tools (read, or the matching document skill) using those exact paths."
  ];
  if (names && names.length) bits.push("Original filenames: " + names.join(", ") + ".");
  return bits.join(" ");
}

function persistMessageImages(messages, chatId) {
  if (!Array.isArray(messages)) return [];
  let lastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || !Array.isArray(m.content)) continue;
    if (m.content.some((p) => p && p.type === "image_url" && p.image_url && String(p.image_url.url || "").startsWith("data:"))) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx < 0) return [];
  const m = messages[lastIdx];
  const names = Array.isArray(m.imageNames) ? m.imageNames : [];
  const saved = [];
  let imgN = 0;
  m.content.forEach((part) => {
    if (!part || part.type !== "image_url") return;
    const url = part.image_url && part.image_url.url;
    if (!url || !String(url).startsWith("data:")) return;
    const fileName = part.fileName || names[imgN] || "image.jpg";
    const out = persistDataUrlImage(chatId || "chat", imgN, fileName, url);
    if (out) saved.push(out.path);
    imgN += 1;
  });
  if (!saved.length) return [];
  const note = attachmentNote(saved, names.filter(Boolean));
  const textPart = m.content.find((p) => p && p.type === "text");
  if (textPart) {
    const prev = String(textPart.text || "");
    if (!prev.includes("Moss saved attached images to:")) textPart.text = prev.trim() + "\n\n" + note;
  } else m.content.unshift({ type: "text", text: note });
  return saved;
}

module.exports = {
  UPLOAD_DIR,
  sanitizeUploadName,
  decodeDataUrl,
  persistUpload,
  isManagedUploadPath,
  persistDataUrlImage,
  persistMessageImages,
  attachmentNote,
  fileAttachmentNote,
};
