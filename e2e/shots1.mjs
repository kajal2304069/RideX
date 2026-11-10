import { launch, base, stub, login, SIZES } from "./lib.mjs";
const b = await launch();
for (const [n, [w, h]] of Object.entries(SIZES)) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, geolocation: { latitude: 12.9716, longitude: 77.5946 }, permissions: ["geolocation"] });
  await stub(ctx);
  const anon = await ctx.newPage(); anon.on("pageerror", (e) => console.log("PAGEERR", e.message));
  await anon.goto(base + "/"); await anon.waitForTimeout(1200);
  await anon.screenshot({ path: `A-${n}-landing.png` });
  await anon.goto(base + "/login"); await anon.waitForTimeout(600); await anon.screenshot({ path: `A-${n}-login.png` });
  const page = await login(ctx, "rider");
  for (const p of ["/home", "/ride"]) { await page.goto(base + p); await page.waitForTimeout(3500); await page.screenshot({ path: `A-${n}${p.replace(/\//g, "-")}.png` });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) console.log("OVERFLOW", n, p); }
  await ctx.close();
}
await b.close();
