import { launch, base, stub, login } from "./lib.mjs";
const b = await launch();
const mk = async (geo) => { const c = await b.newContext({ viewport: { width: 390, height: 844 }, geolocation: geo, permissions: ["geolocation"] }); await stub(c); return c; };
const rctx = await mk({ latitude: 12.9716, longitude: 77.5946 });
const dctx = await mk({ latitude: 12.9780, longitude: 77.6010 });
const rider = await login(rctx, "rider"); const drv = await login(dctx, "driver");
await drv.setViewportSize({ width: 1366, height: 800 });
await rider.goto(base + "/ride"); await rider.waitForTimeout(2500);
if (await rider.getByRole("button", { name: "Cancel ride" }).count()) { await rider.getByRole("button", { name: "Cancel ride" }).click(); await rider.getByRole("button", { name: "Yes, cancel" }).click(); await rider.waitForTimeout(1500); await rider.goto(base + "/ride"); await rider.waitForTimeout(3000); }
const map = rider.locator('[role="region"][aria-label="Map"]').first(); const box = await map.boundingBox();
await map.click({ position: { x: box.width * 0.6, y: box.height * 0.42 } }); await rider.waitForTimeout(2500);
await rider.screenshot({ path: "B-phone-estimate.png" });
await rider.getByRole("button", { name: /^Request/ }).click(); await rider.waitForTimeout(2000);
await rider.screenshot({ path: "B-phone-searching.png" });
// driver online + accept
await drv.goto(base + "/drive"); await drv.waitForTimeout(2500);
const on = drv.getByRole("button", { name: "Go online" }); if (await on.count()) { await on.click(); await drv.waitForTimeout(1500); }
await drv.getByRole("button", { name: "Accept" }).first().click({ timeout: 20000 });
await drv.waitForTimeout(7000);
await drv.screenshot({ path: "D-laptop-driver-trip.png" });
await drv.setViewportSize({ width: 390, height: 844 }); await drv.waitForTimeout(1200); await drv.screenshot({ path: "D-phone-driver-trip.png", fullPage: true }); await drv.setViewportSize({ width: 1366, height: 800 });
console.log("driver sees customer:", /Customer location is live/.test(await drv.locator("body").innerText()));
await rider.waitForTimeout(2500);
await rider.screenshot({ path: "B-phone-approaching.png" });
for (const [n, w, h] of [["tablet", 820, 1180], ["laptop", 1366, 800]]) { await rider.setViewportSize({ width: w, height: h }); await rider.waitForTimeout(1800); await rider.screenshot({ path: `B-${n}-approaching.png` }); }
await rider.setViewportSize({ width: 390, height: 844 });
for (const name of ["I've arrived", "Start trip"]) { await drv.getByRole("button", { name: /Head to pickup/ }).click().catch(() => {}); await drv.waitForTimeout(800); const bt = drv.getByRole("button", { name }); if (await bt.count()) { await bt.click(); await drv.waitForTimeout(1200); } }
await drv.getByRole("button", { name: "Head to pickup" }).click().catch(() => {});
await rider.waitForTimeout(3500); await rider.screenshot({ path: "B-phone-state3.png" });
console.log("rider text:", (await rider.locator("body").innerText()).replace(/\n+/g, " | ").slice(0, 300));
await rider.getByRole("button", { name: "Chat" }).click().catch(() => console.log("no chat button yet")); await rider.waitForTimeout(1200); await rider.screenshot({ path: "B-phone-chat.png" });
await b.close();
