// Changes view: diff parsing + /api/diff routes against a real temp git repo.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-diff-"));
const repo = path.join(dir, "demo");
fs.mkdirSync(repo, { recursive: true });

function git(args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

git(["init", "-b", "main"]);
git(["config", "user.email", "moss@test"]);
git(["config", "user.name", "Moss Test"]);
fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
fs.writeFileSync(path.join(repo, "keep.lean"), "theorem t : True := trivial\n");
git(["add", "."]);
git(["commit", "-m", "initial"]);
const baseSha = git(["rev-parse", "HEAD"]).trim();
// Modify a tracked file, delete another, add an untracked one.
fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo TWEAKED\nthree\nfour\n");
fs.writeFileSync(path.join(repo, "b.txt"), "brand new\n");
git(["add", "b.txt"]);
git(["rm", "--cached", "-q", "keep.lean"]);
fs.rmSync(path.join(repo, "keep.lean"));

process.env.MOSS_REPOS = repo;
const diff = require("./diff");

test.after(() => {
  delete process.env.MOSS_REPOS;
  fs.rmSync(dir, { recursive: true, force: true });
});

function call(url, method) {
  return new Promise((resolve) => {
    const req = { url, method: method || "GET" };
    const res = {
      writeHead(code) { res.code = code; },
      end(body) {
        let json = null;
        try { json = JSON.parse(body); } catch {}
        resolve({ code: res.code, json, body });
      },
    };
    diff.api(req, res).then((hit) => {
      if (!hit) resolve({ code: 0, json: null, body: "" });
    });
  });
}

test("parseDiff classifies added, deleted, context lines and counts", () => {
  const raw = git(["diff", "--no-color", "HEAD"]);
  const files = diff.parseDiff(raw);
  const a = files.find((f) => f.path === "a.txt");
  assert.ok(a, "a.txt present");
  assert.equal(a.status, "M");
  assert.equal(a.deletions, 1);
  assert.equal(a.additions, 2);
  const h = a.hunks[0];
  assert.ok(h.lines.some((l) => l.t === "-" && l.txt === "two"));
  assert.ok(h.lines.some((l) => l.t === "+" && l.txt === "two TWEAKED"));
  assert.ok(h.lines.some((l) => l.t === " " && l.txt === "one"));
  const k = files.find((f) => f.path === "keep.lean");
  assert.ok(k && k.status === "D", "deleted file flagged");
});

test("GET /api/diff/repos lists the configured repo with branch and dirty count", async () => {
  const r = await call("/api/diff/repos");
  assert.equal(r.code, 200);
  const repos = r.json.repos;
  assert.equal(repos.length, 1);
  assert.equal(repos[0].name, "demo");
  assert.equal(repos[0].branch, "main");
  assert.ok(repos[0].changed >= 2, "modified + staged-delete visible in dirty count");
  assert.ok(repos[0].commits[0].subject);
});

test("GET /api/diff/diff returns working-tree diff including untracked files", async () => {
  const r = await call("/api/diff/diff?repo=demo&from=HEAD");
  assert.equal(r.code, 200);
  const paths = r.json.files.map((f) => f.path);
  assert.ok(paths.includes("a.txt"));
  assert.ok(paths.includes("b.txt"), "untracked file synthesized as added");
  const b = r.json.files.find((f) => f.path === "b.txt");
  assert.equal(b.status, "A");
  assert.ok(b.hunks[0].lines.every((l) => l.t === "+"));
});

test("GET /api/diff/diff with a commit range diffs two commits", async () => {
  fs.writeFileSync(path.join(repo, "b.txt"), "brand new\n");
  git(["add", "b.txt"]);
  git(["commit", "-m", "add b"]);
  const head = git(["rev-parse", "HEAD"]).trim();
  const r = await call(`/api/diff/diff?repo=demo&from=${head}&to=${baseSha}`);
  assert.equal(r.code, 200);
  const paths = r.json.files.map((f) => f.path);
  assert.ok(paths.includes("b.txt"), "commit range shows the added file");
});

test("unknown repo and bad refs are rejected", async () => {
  assert.equal((await call("/api/diff/diff?repo=nope&from=HEAD")).code, 404);
  assert.equal((await call("/api/diff/diff?repo=demo&from=HEAD;rm+-rf")).code, 400);
});

test("POST is a method error", async () => {
  assert.equal((await call("/api/diff/repos", "POST")).code, 405);
});

test("parseDiff handles renames", () => {
  fs.writeFileSync(path.join(repo, "c.txt"), "content\n");
  git(["add", "c.txt"]);
  git(["commit", "-m", "add c"]);
  git(["mv", "c.txt", "d.txt"]);
  const files = diff.parseDiff(git(["diff", "--cached", "--find-renames", "--no-color", "HEAD"]));
  const d = files.find((f) => f.path === "d.txt");
  assert.ok(d && d.status === "R" && d.oldPath === "c.txt");
});
