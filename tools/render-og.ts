// Renders assets/og.png (1200x630), the link-preview image, from the live hero (XMU-799;
// brand v1 since XMU-814):
//   bun run og
// Serves this folder with the vercel.json headers (so the CSP applies), opens the page in
// Chromium at 1200x630 in the dark theme with reduced motion (so the window shows its final
// state at once), waits for the fonts and screenshots the viewport. Never a full-page shot:
// that blanks the animated panes. Re-run it whenever the hero copy or look changes.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const SITE = join(import.meta.dir, "..");
const OUT = join(SITE, "assets/og.png");
const headers: Record<string, string> = Object.fromEntries(
  JSON.parse(readFileSync(join(SITE, "vercel.json"), "utf8"))
    .headers.find((h: { source: string }) => h.source === "/(.*)")
    .headers.map((h: { key: string; value: string }) => [h.key, h.value]),
);

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/_vercel/insights/script.js") return new Response("", { headers: { ...headers, "content-type": "text/javascript" } });
    const file = join(SITE, path === "/" ? "index.html" : path);
    if (!file.startsWith(SITE) || path.includes("..") || !existsSync(file)) return new Response("not found", { status: 404 });
    return new Response(Bun.file(file), { headers });
  },
});

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 630 }, reducedMotion: "reduce", deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`http://localhost:${server.port}/`);
  await page.evaluate(() => Promise.all(['600 16px Sora', "16px Inter", "14px Geist", '13px "Geist Mono"'].map((f) => document.fonts.load(f))));
  await page.evaluate(() => document.fonts.ready);
  if (errors.length) throw new Error(`page errors while rendering: ${errors.join("; ")}`);
  await page.screenshot({ path: OUT, fullPage: false });
  console.log(`wrote ${OUT}`);
} finally {
  await browser.close();
  server.stop(true);
}
