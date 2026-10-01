// Browser e2e for the Changes view: drives the real Moss UI in headless
// Chromium against the real server + FakeGateway, with MOSS_REPOS pointed at
// a temp git repo that has a dirty working tree (incl. a Lean file).
// Run: node --test diff-e2e.test.js
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

// The harness inherits process.env, so export the repo before boot().
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-diff-e2e-"));
const repo = path.join(dir, "demo");
fs.mkdirSync(repo, { recursive: true });
function git(args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}
git(["init", "-b", "main"]);
git(["config", "user.email", "moss@test"]);
git(["config", "user.name", "Moss Test"]);
fs.writeFileSync(path.join(repo, "Proof.lean"), "theorem t : True := trivial\n");
fs.writeFileSync(path.join(repo, "clean.txt"), "untouched\n");
git(["add", "."]);
git(["commit", "-m", "initial"]);
fs.writeFileSync(path.join(repo, "Proof.lean"), "theorem t : True := by\n  exact trivial\n");
fs.writeFileSync(path.join(repo, "new.js"), "const x = 1;\n");
process.env.MOSS_REPOS = repo;

const { boot } = require("./e2e/harness");

const EXECUTABLE = "/home/claidler/.cache/ms-playwright/chromium_headless_shell-1223/chrome-linux/headless_shell";

let h = null;
let browser = null;

test.before(async () => {
  h = await boot();
  browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
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
  await page.waitForSelector("#bots", { timeout: 10000 });
  return page;
}

test("Changes row opens the repo cards, a repo opens a highlighted diff", async () => {
  const page = await openApp();
  try {
    // Sidebar carries a Changes row next to Automations.
    await page.waitForSelector(".bot-row.diff-row", { timeout: 10000 });
    assert.match(await page.textContent(".bot-row.diff-row .bot-name"), /Changes/);

    await page.click(".bot-row.diff-row");
    await page.waitForSelector(".diff-repo-card", { timeout: 10000 });
    assert.match(await page.textContent(".diff-repo-name"), /demo/);
    assert.match(await page.textContent(".diff-repo-branch"), /main/);
    assert.match(await page.textContent(".diff-pill.dirty"), /changed/);

    // Open the repo: modified Lean file + untracked JS file show up.
    await page.click(".diff-repo-card");
    await page.waitForSelector(".diff-file", { timeout: 10000 });
    const paths = await page.$$eval(".diff-path", (els) => els.map((e) => e.textContent));
    assert.ok(paths.includes("Proof.lean"), "modified tracked file listed: " + paths.join(","));
    assert.ok(paths.includes("new.js"), "untracked file listed: " + paths.join(","));

    // Expand the Lean file (auto-opens with <=8 files, but be explicit).
    const leanFile = page.locator(".diff-file", { hasText: "Proof.lean" });
    const leanHead = leanFile.locator(".diff-file-head");
    await leanHead.click();
    await leanFile.locator(".dl").first().waitFor({ timeout: 5000 });

    // Lean syntax highlighting actually ran: the keyword token exists.
    const kw = await leanFile.locator(".dl-txt .token.keyword").evaluateAll((els) =>
      els.map((e) => e.textContent)
    );
    assert.ok(kw.includes("theorem"), "Lean keyword highlighted, got: " + JSON.stringify(kw));

    // Line-type classes present: added lines carry .add, and both gutters exist.
    assert.ok((await page.$$(".dl.add")).length >= 1, "added lines rendered");

    // Composer is hidden in the diff view.
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.querySelector(".composer-stack")).display),
      "none"
    );

    // Back to the repo list.
    await page.click(".diff-back");
    await page.waitForSelector(".diff-repo-card", { timeout: 5000 });
  } finally {
    await page.close();
  }
});
