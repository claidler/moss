// Repro: Changes view — switching the base commit must update the diff.
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-diff-switch-"));
const repo = path.join(dir, "demo");
fs.mkdirSync(repo, { recursive: true });
function git(args) { return execFileSync("git", args, { cwd: repo, encoding: "utf8" }); }
git(["init", "-b", "main"]);
git(["config", "user.email", "moss@test"]);
git(["config", "user.name", "Moss Test"]);
fs.writeFileSync(path.join(repo, "one.txt"), "one\n");
git(["add", "."]); git(["commit", "-m", "c1 one"]);
const sha1 = git(["rev-parse", "HEAD"]).trim();
fs.writeFileSync(path.join(repo, "two.txt"), "two\n");
git(["add", "."]); git(["commit", "-m", "c2 two"]);
const sha2 = git(["rev-parse", "HEAD"]).trim();
fs.writeFileSync(path.join(repo, "three.txt"), "three\n");
git(["add", "."]); git(["commit", "-m", "c3 three"]);
const sha3 = git(["rev-parse", "HEAD"]).trim();
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

async function paths(page) {
  return page.$$eval(".diff-path", (els) => els.map((e) => e.textContent));
}

test("switching base commits updates the diff", async () => {
  const page = await openApp();
  try {
    await page.click(".bot-row.diff-row");
    await page.waitForSelector(".diff-repo-card", { timeout: 10000 });
    await page.click(".diff-repo-card");
    await page.waitForSelector(".diff-toolbar", { timeout: 10000 });

    // Clean tree: uncommitted shows none.
    let none = await page.$(".diff-none");
    assert.ok(none, "clean tree message");

    // Pick base = c1 -> expect two.txt + three.txt
    await page.selectOption(".diff-base", sha1);
    await page.waitForSelector(".diff-file", { timeout: 10000 });
    let p = await paths(page);
    assert.ok(p.includes("two.txt") && p.includes("three.txt"), "base c1 shows c2+c3: " + p);
    assert.ok(!p.includes("one.txt"), "base c1 excludes c1 file");

    // Pick base = c2 -> expect three.txt only
    await page.selectOption(".diff-base", sha2);
    await page.waitForFunction(
      () => {
        const els = [...document.querySelectorAll(".diff-path")].map((e) => e.textContent);
        return els.includes("three.txt") && !els.includes("two.txt");
      },
      { timeout: 5000 }
    ).catch(() => {});
    p = await paths(page);
    console.log("AFTER SWITCH TO c2:", JSON.stringify(p));
    assert.ok(p.includes("three.txt") && !p.includes("two.txt"), "base c2 shows only c3: " + p);

    // Untracked new file appears under Uncommitted
    fs.writeFileSync(path.join(repo, "four.txt"), "four\n");
    await page.selectOption(".diff-base", "");
    await page.waitForFunction(
      () => [...document.querySelectorAll(".diff-path")].some((e) => e.textContent === "four.txt"),
      { timeout: 5000 }
    ).catch(() => {});
    p = await paths(page);
    console.log("AFTER SWITCH TO WORKING:", JSON.stringify(p));
    assert.ok(p.includes("four.txt"), "working tree shows untracked: " + p);
  } finally {
    await page.close();
  }
});

test("a new commit made while the view is open reaches the picker on reload", async () => {
  const page = await openApp();
  try {
    await page.click(".bot-row.diff-row");
    await page.waitForSelector(".diff-repo-card", { timeout: 10000 });
    await page.click(".diff-repo-card");
    await page.waitForSelector(".diff-toolbar", { timeout: 10000 });

    // Land a fresh commit while the view sits open (the live-app scenario).
    fs.writeFileSync(path.join(repo, "five.txt"), "five\n");
    git(["add", "."]); git(["commit", "-m", "c5 five"]);
    const sha5full = git(["rev-parse", "HEAD"]).trim();
    const sha5 = sha5full.slice(0, 7);

    const optsBefore = await page.$$eval(".diff-base option", (els) => els.map((e) => e.value));
    assert.ok(!optsBefore.includes(sha5full), "picker is stale before reload");

    await page.click(".diff-reload");
    await page.waitForFunction(
      (sha) => [...document.querySelectorAll(".diff-base option")].some((o) => o.value.startsWith(sha)),
      sha5,
      { timeout: 5000 }
    );
    // And it is selectable: base on the new commit shows a clean tree.
    await page.selectOption(".diff-base", sha5full);
    await page.waitForSelector(".diff-none", { timeout: 5000 });
    assert.match(await page.textContent(".diff-none"), /clean|No changes/);
  } finally {
    await page.close();
  }
});
