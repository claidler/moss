import { thumbsEl, MAX_IMAGES, stagedImages } from "./state.js";

export function stagedSnapshot() {
  return stagedImages.slice(0, MAX_IMAGES).map((s) => ({
    url: s.url,
    mime: s.mime || mimeOf(s.url),
    fileName: s.fileName || ""
  }));
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

export function renderThumbs() {
  thumbsEl.innerHTML = "";
  thumbsEl.hidden = !stagedImages.length;
  stagedImages.forEach((item, i) => {
    const wrap = document.createElement("div");
    wrap.className = "thumb";
    const img = document.createElement("img");
    img.alt = "";
    img.src = item.url;
    const x = document.createElement("button");
    x.type = "button";
    x.setAttribute("aria-label", "Remove photo");
    x.textContent = "\u00d7";
    x.addEventListener("click", () => {
      stagedImages.splice(i, 1);
      renderThumbs();
    });
    wrap.appendChild(img);
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

export async function stageFiles(files) {
  const list = Array.from(files || []);
  for (const file of list) {
    if (!file) continue;
    if (stagedImages.length >= MAX_IMAGES) break;
    const url = await resizeImage(file);
    if (!url) continue;
    stagedImages.push({ url, mime: mimeOf(url), fileName: file.name || "" });
  }
  renderThumbs();
}
