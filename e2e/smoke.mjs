import { chromium } from "playwright-core";
const base = "http://localhost:5173";
const plan = {
  rider: ["/ride", "/ride/history", "/payments", "/notifications", "/rent", "/buy", "/buy/activity", "/repair", "/repair/bookings"],
  driver: ["/drive", "/drive/earnings"],
  owner: ["/drive/vehicles", "/drive/rentals", "/drive/earnings", "/sell", "/rent/bookings"],
  garage: ["/repair/garage"],
  admin: ["/admin"],
};
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
let bad = 0;
for (const [who, paths] of Object.entries(plan)) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, geolocation: { latitude: 12.9716, longitude: 77.5946 }, permissions: ["geolocation"] });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/tile\.openstreetmap|ERR_(NAME|INTERNET|CONNECTION|TUNNEL|PROXY)/.test(m.text())) errs.push("CONSOLE " + m.text().slice(0, 200)); });
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400 && r.status() !== 401) errs.push(`HTTP ${r.status()} ${r.url().replace(base, "")}`); });
  await page.goto(base + "/login");
  await page.getByLabel(/email/i).fill(`${who}@ridex.dev`);
  await page.getByLabel(/password/i).fill("Passw0rd123");
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 10000 }).catch(() => errs.push("LOGIN did not redirect"));
  for (const p of paths) {
    await page.goto(base + p); await page.waitForTimeout(1500);
    const body = (await page.locator("main").innerText().catch(() => "")) || "";
    if (/something went wrong|not found|unexpected/i.test(body.slice(0, 300))) errs.push(`BODY ${p}: ${body.slice(0, 120)}`);
    await page.screenshot({ path: `/tmp/e2e/${who}-${p.replace(/\//g, "_")}.png` });
  }
  console.log(who, errs.length ? "\n  " + [...new Set(errs)].join("\n  ") : "ok"); bad += errs.length;
  await ctx.close();
}
await browser.close(); process.exit(bad ? 1 : 0);
