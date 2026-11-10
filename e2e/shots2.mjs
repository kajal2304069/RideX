import { launch, base, stub, login, SIZES } from "./lib.mjs";
const b = await launch();
const plan = { rider: ["/rent", "/buy", "/repair", "/ride/history", "/payments", "/help"], owner: ["/drive/vehicles", "/drive/earnings", "/sell"], admin: ["/admin"] };
for (const [n, [w, h]] of Object.entries(SIZES)) {
  for (const [who, pages] of Object.entries(plan)) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, geolocation: { latitude: 12.9716, longitude: 77.5946 }, permissions: ["geolocation"] });
    await stub(ctx); const page = await login(ctx, who);
    for (const p of pages) { await page.goto(base + p); await page.waitForTimeout(2200);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) console.log("OVERFLOW", n, who, p);
      await page.screenshot({ path: `C-${n}-${who}${p.replace(/\//g, "-")}.png` }); }
    await ctx.close();
  }
}
await b.close();
