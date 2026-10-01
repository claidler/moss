// One-shot live check: log into the running Moss service, open Changes,
// click a repo, click a file, confirm highlighted diff lines render.
// Uses waitForFunction + in-page clicks because the sidebar re-renders every
// second (pending chats) and detaches Playwright element handles.
const fs = require("fs");
const path = require("path");
const { chromium } = require(
  fs.existsSync(path.join(__dirname, "node_modules/playwright-core"))
    ? "playwright-core"
    : "/home/claidler/.local/node/lib/node_modules/openclaw/node_modules/playwright-core"
);
const EXECUTABLE = "/home/claidler/.cache/ms-playwright/chromium_headless_shell-1223/chrome-linux/headless_shell";
const BASE = "http://127.0.0.1:8190";

const wait = (page, fn, ms = 15000) => page.waitForFunction(fn, null, { timeout: ms });

(async () => {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGE-EXC:", String(e).slice(0, 200)));

  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
  await page.fill("#pw", fs.readFileSync(path.join(__dirname, "data", "PASSWORD"), "utf8").trim());
  await Promise.all([page.waitForURL(BASE + "/", { timeout: 10000 }), page.click("button[type=submit]")]);
  await wait(page, () => !!document.querySelector(".bot-row.diff-row"));
  console.log("OK sidebar Changes row");

  await page.evaluate(() => document.querySelector(".bot-row.diff-row").click());
  await wait(page, () => document.querySelectorAll(".diff-repo-card").length > 0);
  const names = await page.$$eval(".diff-repo-name", (els) => els.map((e) => e.textContent));
  console.log("OK repo cards:", names.join(", "));
  await page.screenshot({ path: "/tmp/diff-repos.png" });

  await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll(".diff-repo-card"))
      .find((c) => c.textContent.includes("moss"));
    card.click();
  });
  await wait(page, () => document.querySelectorAll(".diff-file").length > 0);
  const paths = await page.$$eval(".diff-path", (els) => els.map((e) => e.textContent));
  console.log("OK files listed (" + paths.length + "):", paths.slice(0, 8).join(", "));

  await page.evaluate(() => {
    const box = Array.from(document.querySelectorAll(".diff-file"))
      .find((f) => f.textContent.includes("js/board.js"));
    box.querySelector(".diff-file-head").click();
  });
  await wait(page, () => {
    const box = Array.from(document.querySelectorAll(".diff-file"))
      .find((f) => f.textContent.includes("js/board.js"));
    return !!(box && box.querySelector(".dl"));
  });
  const stats = await page.evaluate(() => {
    const box = Array.from(document.querySelectorAll(".diff-file"))
      .find((f) => f.textContent.includes("js/board.js"));
    return {
      adds: box.querySelectorAll(".dl.add").length,
      dels: box.querySelectorAll(".dl.del").length,
      toks: Array.from(new Set(Array.from(box.querySelectorAll(".dl-txt .token"))
        .map((e) => e.className.replace("token ", "")))),
    };
  });
  console.log("OK diff lines: +" + stats.adds + " -" + stats.dels + "; token types:", stats.toks.join(","));
  await page.screenshot({ path: "/tmp/diff-open.png" });

  const commits = await page.evaluate(async () => {
    const r = await fetch("/api/diff/commits?repo=moss", { cache: "no-store" });
    return (await r.json()).commits.map((c) => c.short + " " + c.subject);
  });
  console.log("OK commits route:", commits.slice(0, 3).join(" | "));

  await browser.close();
  console.log("ALL-LIVE-CHECKS-PASSED");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
