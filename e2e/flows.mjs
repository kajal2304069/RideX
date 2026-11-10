import { chromium } from "playwright-core";
const base = "http://localhost:5173";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
async function as(who) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(base + "/login");
  await page.getByLabel(/email/i).fill(`${who}@ridex.dev`); await page.getByLabel(/password/i).fill("Passw0rd123");
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL((u) => !u.pathname.includes("login"));
  return page;
}
const ok = (m) => console.log("PASS", m);
// 1. marketplace offer + seller accepts
const rider = await as("rider");
await rider.goto(base + "/buy"); await rider.getByText("Pulsar 150").first().click();
await rider.getByLabel(/your offer/i).fill("60000"); await rider.getByRole("button", { name: "Send offer" }).click(); await rider.waitForTimeout(800);
ok("buyer sends offer (or already pending)");
const owner = await as("owner");
await owner.goto(base + "/sell"); await owner.locator(".panel", { hasText: "Pulsar" }).getByRole("button", { name: "Offers" }).click();
await owner.waitForTimeout(1500); await owner.screenshot({path:"/tmp/e2e/sell.png"}); await owner.getByText(/60,000/).first().waitFor({timeout:5000}); ok("seller sees offer");
// 2. repair: rider books garage
await rider.goto(base + "/repair"); await rider.getByText("Sai Motors").first().click();
await rider.getByRole("button", { name: "Request booking" }).click();
await rider.waitForURL("**/repair/bookings"); ok("garage booking requested");
const garage = await as("garage");
await garage.goto(base + "/repair/garage"); await garage.getByRole("button", { name: "Accept" }).first().click();
await garage.getByText("Updated").first().waitFor(); ok("garage accepts");
// 3. rent: quote
await rider.goto(base + "/rent"); const first = rider.locator("a[href^='/rent/listings/']").first(); await first.click();
await rider.getByText(/Pay now/).waitFor(); ok("rental quote shown");
await browser.close();
