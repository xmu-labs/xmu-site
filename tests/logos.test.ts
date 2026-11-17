// XMU-814 agent logos inside the hero window: each agent shows its tool's logo (Claude, Codex,
// Cursor) in the window bar, on the pane tags and in the chat. Same harness as polish.test.ts:
// serve the site with the vercel.json headers (CSP enforced), drive Chromium.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";

const SITE = join(import.meta.dir, "..");
const HTML = readFileSync(join(SITE, "index.html"), "utf8");
const HEADERS: Record<string, string> = Object.fromEntries(
  JSON.parse(readFileSync(join(SITE, "vercel.json"), "utf8"))
    .headers.find((h: { source: string }) => h.source === "/(.*)")
    .headers.map((h: { key: string; value: string }) => [h.key, h.value]),
);

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname === "/" ? "/index.html" : new URL(req.url).pathname;
      if (path === "/_vercel/insights/script.js") {
        return new Response("", { headers: { ...HEADERS, "content-type": "text/javascript" } });
      }
      const file = join(SITE, path);
      if (!file.startsWith(SITE) || path.includes("..") || path.startsWith("/tests") || !existsSync(file)) {
        return new Response("not found", { status: 404 });
      }
      return new Response(Bun.file(file), { headers: HEADERS });
    },
  });
  base = `http://localhost:${server.port}`;
  browser = await chromium.launch({ args: ["--font-render-hinting=full"] }); // hinted glyphs, as on CI: monospace text draws whole pixels wide there
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

async function open(opts: BrowserContextOptions = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark", ...opts });
  // The page posts to the real waitlist form: never let a test sign up for real.
  await context.route("https://formspree.io/**", (route) => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(2000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/`);
  return { page, errors, close: () => context.close() };
}

// Contrast of each logo's fill against the first opaque background behind it (WCAG 2.x formula).
function logoContrast(page: Page, sel: string) {
  return page.locator(sel).evaluateAll((els) => {
    const rgb = (s: string): number[] => {
      const m = s.match(/rgba?\(([^)]+)\)/) ?? s.match(/color\(srgb ([^)]+)\)/);
      if (!m) throw new Error(`unparsed colour ${s}`);
      const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      const scale = s.startsWith("color(") ? 255 : 1;
      return [parts[0] * scale, parts[1] * scale, parts[2] * scale, parts[3] ?? 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    return els.map((el) => {
      const fg = rgb(getComputedStyle(el).fill);
      let node: Element | null = el.parentElement;
      let bg = [255, 255, 255, 1];
      while (node) {
        const c = rgb(getComputedStyle(node).backgroundColor);
        if (c[3] > 0.5) { bg = c; break; }
        node = node.parentElement;
      }
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return { cls: el.getAttribute("class"), ratio: (a + 0.05) / (b + 0.05) };
    });
  });
}

describe("logo markup and colour", () => {
  test("inline logos are decorative: aria-hidden, not focusable, no title or metadata", () => {
    const svgs = HTML.match(/<svg\b[^>]*class="mlogo[^"]*"[^>]*>[\s\S]*?<\/svg>/g) ?? [];
    // hero: 3 in the window bar, 3 on the pane tags, 1 in the chat (ben's Claude); stack: 3
    // How it works (XMU-833): step 1 has 2, step 2's two agent pickers 4 each (Gemini CLI too), step 3 has 6, step 4 has 5
    expect(svgs.length).toBe(31);
    for (const svg of svgs) {
      expect(svg).toMatch(/\saria-hidden="true"/);
      expect(svg).toMatch(/\sfocusable="false"/);
      expect(svg).not.toMatch(/<title|<metadata|role="img"|c2pa/);
    }
  });

  test("logo colours: Claude orange, Codex and Cursor in the window's text colour", async () => {
    const { page, close } = await open();
    const fill = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).fill);
    expect(await fill("#top .lg-claude")).toBe("rgb(217, 119, 87)");
    expect(await fill("#top .lg-codex")).toBe("rgb(234, 244, 255)");
    expect(await fill("#top .lg-cursor")).toBe("rgb(234, 244, 255)");
    await close();
  });

  for (const theme of ["dark", "light"] as const) {
    test(`every logo has at least 3:1 contrast against its badge (${theme} theme)`, async () => {
      const { page, close } = await open();
      if (theme === "light") await page.click(".nav .theme");
      const ratios = await logoContrast(page, "#top svg.mlogo");
      expect(ratios.length).toBe(7);
      for (const r of ratios) expect({ ...r, ok: r.ratio >= 3 }).toMatchObject({ ok: true });
      await close();
    });
  }

  // XMU-817: the step screens stay dark; the stack chips follow the theme.
  for (const theme of ["dark", "light"] as const) {
    test(`logos in How it works and the stack strip have at least 3:1 contrast (${theme} theme)`, async () => {
      const { page, close } = await open();
      if (theme === "light") await page.click(".nav .theme");
      const ratios = await logoContrast(page, "#how svg.mlogo, #stack svg.mlogo");
      expect(ratios.length).toBe(24);
      for (const r of ratios) expect({ ...r, ok: r.ratio >= 3 }).toMatchObject({ ok: true });
      await close();
    });
  }

  test("no console errors with the real CSP, and the CSP is unchanged", async () => {
    const { page, errors, close } = await open();
    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
    expect(HEADERS["Content-Security-Policy"]).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self' https://formspree.io; form-action 'self' https://formspree.io; base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
    );
    await close();
  });

  test("DESIGN.md has the agent-logo rule: nominative use, no partnership claim", () => {
    const md = readFileSync(join(SITE, "DESIGN.md"), "utf8");
    expect(md).toMatch(/^## Agent logos$/m);
    const section = md.split(/^## Agent logos$/m)[1].split(/^## /m)[0];
    expect(section).toMatch(/works with/i);
    expect(section).toMatch(/nominative/i);
    expect(section).toMatch(/partner/i);
  });
});
