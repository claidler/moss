// Moss — Changes view: read-only git diff API over configured repos.
//
// MOSS_REPOS="/path/a,/path/b" exposes each git worktree. Routes:
//   GET /api/diff/repos                 -> repo cards (branch, dirty count, recent commits)
//   GET /api/diff/commits?repo=ID       -> recent commits (for pickers)
//   GET /api/diff/diff?repo=ID&from=R   -> structured unified diff (working tree vs R)
//   GET /api/diff/diff?repo=ID&from=R&to=S -> commit range S..R
// Refs are pattern-checked; paths only ever follow a `--` separator.
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { json } = require("./http-utils");
const { REPOS } = require("./config");

const GIT_MS = 8000;
const MAX_FILES = 80;
const MAX_FILE_BYTES = 220_000;
const REF_RE = /^[A-Za-z0-9_./@{}^~:+-]{1,120}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function git(cwd, args, maxBuffer) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_MS, maxBuffer: maxBuffer || 4_000_000, env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: "0" }) },
      (err, stdout) => resolve(err ? null : String(stdout))
    );
  });
}

// id -> absolute path, for configured repos that are real worktrees.
async function repoMap() {
  const entries = await Promise.all(
    REPOS.map(async (p) => {
      const top = await git(p, ["rev-parse", "--show-toplevel"]);
      const root = top === null ? "" : top.trim();
      return root || null;
    })
  );
  const out = new Map();
  for (const root of entries) {
    if (!root) continue;
    const id = path.basename(root).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "repo";
    let key = id;
    let n = 2;
    while (out.has(key)) key = id + "-" + n++;
    out.set(key, root);
  }
  return out;
}

async function repoCard(id, root) {
  const [branch, status, aheadBehind, logRaw] = await Promise.all([
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["status", "--porcelain", "--untracked-files=no"]),
    git(root, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
    git(root, ["log", "-n", "15", "--format=%H%x09%an%x09%at%x09%s"]),
  ]);
  const changed = status === null ? -1 : status.split("\n").filter(Boolean).length;
  let ahead = 0;
  let behind = 0;
  if (aheadBehind) {
    const parts = aheadBehind.trim().split(/\s+/);
    behind = Number(parts[0]) || 0;
    ahead = Number(parts[1]) || 0;
  }
  const commits = (logRaw || "")
    .split("\n")
    .filter(Boolean)
    .slice(0, 15)
    .map((line) => {
      const [sha, author, ts, subject] = line.split("\t");
      return { sha, short: sha.slice(0, 7), author, ts: Number(ts) || 0, subject: subject || "" };
    });
  return {
    id,
    name: path.basename(root),
    branch: branch.trim() || "(detached)",
    changed,
    ahead,
    behind,
    commits,
  };
}

// Parse `git diff` output into files -> hunks -> typed lines.
function parseDiff(text) {
  const files = [];
  let cur = null;
  let hunk = null;
  let headerLines = 0;
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^diff --git /.test(line)) {
      cur = { path: "", oldPath: "", status: "M", binary: false, additions: 0, deletions: 0, hunks: [] };
      files.push(cur);
      hunk = null;
      headerLines = 0;
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      if (m) {
        cur.oldPath = m[1];
        cur.path = m[2];
      }
      continue;
    }
    if (!cur) continue;
    if (/^(index|--- |\+\+\+ )/.test(line)) continue;
    let m = line.match(/^new file mode (\d+)/);
    if (m) { cur.status = "A"; continue; }
    m = line.match(/^deleted file mode (\d+)/);
    if (m) { cur.status = "D"; continue; }
    m = line.match(/^rename from (.*)$/);
    if (m) { cur.oldPath = m[1]; cur.status = "R"; continue; }
    m = line.match(/^rename to (.*)$/);
    if (m) { cur.path = m[1]; continue; }
    m = line.match(/^copy from (.*)$/);
    if (m) { cur.oldPath = m[1]; cur.status = "C"; continue; }
    m = line.match(/^copy to (.*)$/);
    if (m) { cur.path = m[1]; continue; }
    if (line === "Binary files " + "" || /^Binary files /.test(line)) { cur.binary = true; continue; }
    m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+")) {
      hunk.lines.push({ t: "+", txt: line.slice(1) });
      cur.additions++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ t: "-", txt: line.slice(1) });
      cur.deletions++;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — cosmetic, skip.
    } else {
      hunk.lines.push({ t: " ", txt: line.startsWith(" ") ? line.slice(1) : "" });
    }
    headerLines++;
  }
  return files.filter((f) => f.path);
}

async function diffFor(root, from, to) {
  // to set  -> `git diff to from` (committed range)
  // to unset -> `git diff from` (from vs working tree, incl. untracked)
  let text = null;
  let truncated = false;
  if (to) {
    text = await git(root, ["diff", "--no-color", "--no-ext-diff", "--find-renames", "--unified=3", to, from, "--"], MAX_FILE_BYTES * 6);
  } else {
    text = await git(root, ["diff", "--no-color", "--no-ext-diff", "--find-renames", "--unified=3", from, "--"], MAX_FILE_BYTES * 6);
    if (text === null) return { files: [], truncated: false };
    // Untracked files: synthesize an added-file diff for each.
    const untrackedRaw = await git(root, ["ls-files", "--others", "--exclude-standard"]);
    const untracked = (untrackedRaw || "").split("\n").filter(Boolean).slice(0, MAX_FILES);
    const extras = [];
    for (const up of untracked) {
      let buf = null;
      try { buf = fs.readFileSync(path.join(root, up)); } catch {}
      if (!buf) continue;
      if (buf.includes(0)) {
        extras.push({ path: up, oldPath: up, status: "A", binary: true, additions: 0, deletions: 0, hunks: [] });
        continue;
      }
      const bodyLines = buf.toString("utf8").split("\n");
      // Trailing newline yields a phantom empty last line; drop it.
      if (bodyLines.length && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();
      extras.push({
        path: up,
        oldPath: up,
        status: "A",
        binary: false,
        additions: bodyLines.length,
        deletions: 0,
        hunks: [{
          oldStart: 0, oldLines: 0, newStart: 1, newLines: bodyLines.length,
          lines: bodyLines.map((l) => ({ t: "+", txt: l })),
        }],
      });
    }
    const files = parseDiff(text).concat(extras);
    if (files.length > MAX_FILES) { truncated = true; return { files: capFiles(files), truncated }; }
    return { files, truncated };
  }
  if (text === null) return { files: [], truncated: false };
  const files = parseDiff(text);
  if (files.length > MAX_FILES) return { files: capFiles(files), truncated: true };
  return { files, truncated };
}

function capFiles(files) {
  return files.slice(0, MAX_FILES).map((f) => ({
    ...f,
    hunks: f.hunks.slice(0, 40).map((h) => ({ ...h, lines: h.lines.slice(0, 2000) })),
  }));
}

async function api(req, res) {
  const u = new URL(req.url || "/", "http://moss.local");
  const p0 = u.pathname;
  if (p0 !== "/api/diff/repos" && p0 !== "/api/diff/commits" && p0 !== "/api/diff/diff") return false;
  if (req.method !== "GET") {
    json(res, 405, { error: "method" });
    return true;
  }
  if (p0 === "/api/diff/repos") {
    const map = await repoMap();
    const repos = await Promise.all(
      Array.from(map.entries()).map(([id, root]) => repoCard(id, root))
    );
    json(res, 200, { repos });
    return true;
  }
  const map = await repoMap();
  const id = String(u.searchParams.get("repo") || "");
  if (!ID_RE.test(id) || !map.has(id)) {
    json(res, 404, { error: "repo" });
    return true;
  }
  const root = map.get(id);
  if (p0 === "/api/diff/commits") {
    const logRaw = await git(root, ["log", "-n", "60", "--format=%H%x09%an%x09%at%x09%s"]);
    const commits = (logRaw || "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, author, ts, subject] = line.split("\t");
        return { sha, short: sha.slice(0, 7), author, ts: Number(ts) || 0, subject: subject || "" };
      });
    json(res, 200, { commits });
    return true;
  }
  const from = String(u.searchParams.get("from") || "HEAD");
  const to = String(u.searchParams.get("to") || "");
  if (!REF_RE.test(from) || (to && !REF_RE.test(to))) {
    json(res, 400, { error: "ref" });
    return true;
  }
  const out = await diffFor(root, from, to);
  out.files = out.files.map((f) => ({
    ...f,
    hunks: f.hunks.slice(0, 40).map((h) => ({ ...h, lines: h.lines.slice(0, 2000) })),
  }));
  json(res, 200, { repo: id, from, to: to || null, ...out });
  return true;
}

module.exports = { api, parseDiff };
