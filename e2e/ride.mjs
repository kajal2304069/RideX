import { chromium } from "playwright-core";
const base = "http://localhost:5173";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
async function as(who) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage(); page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto(base + "/login");
  await page.getByLabel(/email/i).fill(`${who}@ridex.dev`); await page.getByLabel(/password/i).fill("Passw0rd123");
  await page.getByRole("button", { name: /sign in|log in/i }).click(); await page.waitForURL((u) => !u.pathname.includes("login"));
  return page;
}
const driver = await as("driver"); await driver.goto(base + "/drive"); await driver.waitForTimeout(1500);
console.log("driver page:", (await driver.locator("main").innerText()).replace(/\n+/g, " | ").slice(0, 300));
const rider = await as("rider"); await rider.goto(base + "/ride"); await rider.waitForTimeout(1500);
const map = rider.getByRole("region", { name: "Map" }); const b = await map.boundingBox();
await map.click({ position: { x: b.width * 0.4, y: b.height * 0.5 } }); await map.click({ position: { x: b.width * 0.6, y: b.height * 0.4 } });
await rider.waitForTimeout(2500);
await rider.screenshot({ path: "/tmp/e2e/ride-plan.png" });
const btn = rider.getByRole("button", { name: /request|book/i }).last(); console.log("button:", await btn.innerText(), await btn.isEnabled());
await btn.click(); await rider.waitForTimeout(2500); await rider.screenshot({ path: "/tmp/e2e/ride-active.png" });
await driver.waitForTimeout(3000); await driver.screenshot({ path: "/tmp/e2e/driver-offer.png" });
await browser.close();
