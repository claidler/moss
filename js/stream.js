export function streamChat(body, signal, onJson) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/v1/chat/completions");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "text/event-stream");
    try { xhr.overrideMimeType("text/plain; charset=utf-8"); } catch (e) {}
    xhr.timeout = 0;
    let seen = 0;
    let buf = "";
    const pump = () => {
      const all = xhr.responseText || "";
      if (all.length <= seen) return;
      buf += all.slice(seen);
      seen = all.length;
      let n;
      while ((n = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, n).trim();
        buf = buf.slice(n + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try { onJson(JSON.parse(data)); } catch (e) {}
      }
    };
    xhr.onprogress = pump;
    xhr.onload = () => {
      pump();
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else if (xhr.status === 409) {
        const err = new Error("pending");
        err.code = "pending";
        reject(err);
      } else reject(new Error("HTTP " + xhr.status + " " + String(xhr.responseText || "").slice(0, 240)));
    };
    xhr.onerror = () => reject(new TypeError("Failed to fetch"));
    xhr.onabort = () => {
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal) {
      if (signal.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(JSON.stringify(body));
  });
}
