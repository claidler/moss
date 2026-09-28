// Browser e2e for the Goal feature: drives the real Moss UI in headless
// Chromium against the real server + FakeGateway.
// Run: node --test goals-e2e.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { chromium } = require(
  fs.existsSync(path.join(__dirname, "node_modules/playwright-core"))
    ? "playwright-core"
    : "/home/claidler/.local/node/lib/node_modules/openclaw/node_modules/playwright-core"
);
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

test("goal round-trip in the UI: toggle, send, live pill, pause, clear", async () => {
  const page = await openApp();
  try {
    // Fresh chat, then switch composer into Goal mode.
    await page.click("#newChat");
    await page.click("#goalToggle");
    await page.waitForFunction(
      () => document.getElementById("goalToggle").getAttribute("aria-pressed") === "true"
    );
    assert.equal(
      await page.getAttribute("#input", "placeholder"),
      "Describe the goal",
      "composer switches to goal placeholder"
    );

    // Send an objective; the pill must appear live from the stream delta.
    await page.fill("#input", "Organise the garage");
    await page.click("#send");
    await page.waitForSelector("#goalPill:not([hidden])", { timeout: 10000 });
    await page.waitForFunction(
      () => /Pursuing goal/.test(document.getElementById("goalPill").textContent)
    );
    const pillText = await page.textContent("#goalPill");
    assert.match(pillText, /Organise the garage/);
    assert.match(pillText, /\d[\d.,]*[km]? tok/i, "pill shows token usage");

    // Goal mode is one-shot: the toggle disarmed when the message went out.
    assert.equal(
      await page.getAttribute("#goalToggle", "aria-pressed"),
      "false"
    );
    // The user bubble shows the clean objective, not "/goal ...".
    const bubble = await page.textContent(".msg.user .md");
    assert.equal(bubble.trim(), "Organise the garage");

    // Pause from the pill -> server -> gateway -> pill repaints.
    await page.click(".goal-btn.goal-pause");
    await page.waitForFunction(
      () => /Goal paused/.test(document.getElementById("goalPill").textContent),
      null,
      { timeout: 10000 }
    );
    assert.ok(
      h.gw.rpcLog.some((r) => r.method === "sessions.goal.update" && r.params.action === "pause"),
      "pause reached the gateway"
    );

    // Clear -> pill disappears entirely.
    await page.click(".goal-btn.goal-clear");
    await page.waitForFunction(
      () => document.getElementById("goalPill").hidden,
      null,
      { timeout: 10000 }
    );
  } finally {
    await page.close();
  }
});

test("goal pill survives a reload (warm cache path)", async () => {
  const page = await openApp();
  try {
    await page.click("#newChat");
    await page.click("#goalToggle");
    await page.fill("#input", "Deep clean the kitchen");
    await page.click("#send");
    await page.waitForSelector("#goalPill:not([hidden])", { timeout: 10000 });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#bots", { timeout: 10000 });
    await page.waitForFunction(
      () => {
        const pill = document.getElementById("goalPill");
        return !pill.hidden && /Pursuing goal/.test(pill.textContent)
          && /Deep clean the kitchen/.test(pill.textContent);
      },
      null,
      { timeout: 10000 }
    );
  } finally {
    await page.close();
  }
});

test("goal mode does not leak across chats", async () => {
  const page = await openApp();
  try {
    // Chat A: a plain (non-goal) message so it has a title to click later.
    await page.click("#newChat");
    await page.fill("#input", "Plan the route");
    await page.click("#send");
    await page.waitForFunction(
      () => /Plan the route/.test(document.querySelector(".msg.user") ? document.querySelector(".msg.user").textContent : ""),
      null,
      { timeout: 10000 }
    );
    const chatARow = page.locator(".bot-row", { hasText: "Plan the route" }).first();
    await chatARow.waitFor({ timeout: 10000 });

    // Chat B: fresh chat with goal mode switched on.
    await page.click("#newChat");
    await page.click("#goalToggle");
    await page.waitForFunction(
      () => document.getElementById("goalToggle").getAttribute("aria-pressed") === "true"
    );

    // Back to chat A: goal mode must read as off there.
    await chatARow.click();
    await page.waitForFunction(
      () => document.getElementById("goalToggle").getAttribute("aria-pressed") === "false",
      null,
      { timeout: 5000 }
    );
    // Return to chat B (the empty chat re-selected by +): the mode belongs
    // to that chat, so it is still armed there — but a send from chat A
    // would never have carried it.
    await page.click("#newChat");
    assert.equal(
      await page.getAttribute("#goalToggle", "aria-pressed"),
      "true",
      "goal mode stays with the chat it was enabled in"
    );
  } finally {
    await page.close();
  }
});
