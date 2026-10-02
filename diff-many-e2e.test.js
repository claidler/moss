// Repro: Changes view — with many changed files the rows were reported as
// "grey lines you can't click". Locks: every file row renders, every head is
// clickable (toggles .open, body becomes visible), and rows are clickable even
// when tapped immediately after the repo opens (before the diff paints).
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { chromium } = require(
  fs.existsSync(path.join(__dirname, "node_modules/playwright-core"))
    ? "playwright-core"
    : "/home/claidler/.local/node/lib/node_modules/openclaw/node_modules/playwright-core"
);

const N = 30;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-diff-many-"));
const repo = path.join(dir, "demo");
fs.mkdirSync(repo, { recursive: true });
function git(args) { return execFileSync("git", args, { cwd: repo, encoding: "utf8" }); }
git(["init", "-b", "main"]);
git(["config", "user.email", "moss@test"]);
git(["config", "user.name", "Moss Test"]);
fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
git(["add", "."]); git(["commit", "-m", "c1 base"]);
for (let i = 0; i < N; i++) fs.writeFileSync(path.join(repo, "f" + i + ".txt"), "content " + i + "\n");
process.env.MOSS_REPOS = repo;

const { boot } = require("./e2e/harness");
const EXECUTABLE = "/home/claidler/.cache/ms-playwright/chromium_headless_shell-1223/chrome-linux/headless_shell";
let h = null, browser = null;

test.before(async () => {
  h = await boot();
  browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});
test.after(async () => {
  if (browser) await browser.close();
  if (h) await h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function openApp() {
  const page = await browser.newPage();
  await page.goto(h.base + "/login", { waitUntil: "domcontentloaded" });
  await page.fill("#pw", fs.readFileSync(path.join(__dirname, "data", "PASSWORD"), "utf8").trim());
  await Promise.all([
    page.waitForURL(h.base + "/", { timeout: 10000 }),
    page.click("button[type=submit]"),
  ]);
  await page.waitForSelector(".bot-row.diff-row", { timeout: 10000 });
  return page;
}

test("API returns every changed file", async () => {
  const r = await h.api("/api/diff/diff?repo=demo&from=HEAD&to=");
  assert.equal(r.status, 200);
  assert.equal(r.json.files.length, N, "all " + N + " files present");
});

test("many file rows all render and are individually clickable", async () => {
  const page = await openApp();
  try {
    await page.click(".bot-row.diff-row");
    await page.waitForSelector(".diff-repo-card", { timeout: 10000 });
    await page.click(".diff-repo-card");
    await page.waitForSelector(".diff-file", { timeout: 10000 });

    const count = await page.$$eval(".diff-file", (els) => els.length);
    assert.equal(count, N, "all rows painted");

    // Every head is a real button and toggles its own body open.
    const idxs = [0, 4, 9, 14, 22, N - 1];
    for (const i of idxs) {
      await page.evaluate((n) => document.querySelectorAll(".diff-file .diff-file-head")[n].click(), i);
    }
    const openStates = await page.$$eval(".diff-file", (els) =>
      els.map((el) => ({ open: el.classList.contains("open"), shown: getComputedStyle(el.querySelector(".diff-body")).display !== "none" }))
    );
    for (const i of idxs) {
      assert.ok(openStates[i].open, "row " + i + " has .open");
      assert.ok(openStates[i].shown, "row " + i + " body visible");
    }
    const closed = openStates.filter((s, i) => ![0, 4, 9, 14, 22, N - 1].includes(i));
    assert.ok(closed.every((s) => !s.open), "untouched rows stay collapsed");

    // Toggling one open row closed again works.
    await page.evaluate(() => document.querySelectorAll(".diff-file .diff-file-head")[4].click());
    const after = await page.$$eval(".diff-file", (els) => els.map((el) => el.classList.contains("open")));
    assert.ok(!after[4], "row 4 closed again");
    assert.ok(after[9], "row 9 still open");
  } finally {
    await page.close();
  }
});

test("rows are clickable immediately after opening the repo (no waiting)", async () => {
  const page = await openApp();
  try {
    await page.click(".bot-row.diff-row");
    await page.waitForSelector(".diff-repo-card", { timeout: 10000 });
    // Click the repo card and immediately a would-be row region: rows may not
    // exist yet, so just click the card and then the first head as soon as the
    // toolbar appears — before waiting for .diff-file.
    await page.click(".diff-repo-card");
    await page.waitForSelector(".diff-toolbar", { timeout: 10000 });
    await page.click(".diff-file .diff-file-head", { timeout: 10000 });
    await page.waitForSelector(".diff-file.open", { timeout: 5000 });
    const shown = await page.$eval(".diff-file.open .diff-body", (el) => getComputedStyle(el).display !== "none");
    assert.ok(shown, "early-tapped row opens");
  } finally {
    await page.close();
  }
});
