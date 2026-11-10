import { chromium } from "playwright-core";
export const base = "http://localhost:5173";
export const launch = () => chromium.launch({ args: ["--no-sandbox"], executablePath: process.env.CHROME ?? undefined });
// The sandbox has no internet, so stand in for map tiles and photos (for these screenshots only).
const tile = (x, y) => {
  const h = (n) => ((Math.sin(n * 12.9898 + x * 78.233 + y * 37.719) * 43758.5453) % 1 + 1) % 1;
  let r = ""; for (let i = 0; i < 7; i++) { const a = h(i) * 256, b = h(i + 9) * 256, c = h(i + 17) * 256, d = h(i + 31) * 256; r += `<path d="M${a} 0 L${b} 256" stroke="#fff" stroke-width="${3 + h(i + 3) * 5}" opacity=".95"/><path d="M0 ${c} L256 ${d}" stroke="#fff" stroke-width="${3 + h(i + 5) * 5}" opacity=".95"/>`; }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e8ebf2"/><rect x="${h(1) * 150}" y="${h(2) * 150}" width="90" height="70" fill="#d5ead9" opacity=".8"/>${r}</svg>`;
};
const photo = (seed) => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a5fd8"/><stop offset="1" stop-color="#1b1a3a"/></linearGradient></defs><rect width="800" height="600" fill="url(#g)"/><circle cx="${200 + seed * 40}" cy="420" r="70" fill="#f5b301" opacity=".5"/><rect x="0" y="470" width="800" height="130" fill="#0d0f2b" opacity=".5"/></svg>`;
export async function stub(ctx) {
  await ctx.route(/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)/, (r) => { const m = r.request().url().match(/(\d+)\/(\d+)\/(\d+)\.png/); r.fulfill({ status: 200, contentType: "image/svg+xml", body: tile(+m[2], +m[3]) }); });
  await ctx.route(/images\.unsplash\.com/, (r) => r.fulfill({ status: 200, contentType: "image/svg+xml", body: photo(r.request().url().length % 5) }));
  await ctx.route(/nominatim\.openstreetmap\.org\/reverse/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ display_name: "MG Road, Bengaluru, Karnataka" }) }));
}
export async function login(ctx, who, size) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERR", who, e.message));
  await page.goto(base + "/login");
  await page.getByLabel(/email/i).fill(`${who}@ridex.dev`); await page.getByLabel(/password/i).fill("Passw0rd123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.includes("login"));
  return page;
}
export const SIZES = { phone: [390, 844], tablet: [820, 1180], laptop: [1366, 800] };
