// XMU-814: the landing page in a real browser (Chromium via Playwright).
// Brand v1 look and copy v2, ported from the approved v41 mock.
// Sections: structure (this file's base), hero, sections, waitlist; polish lives in polish.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const SITE = join(import.meta.dir, "..");
const ENDPOINT = "https://formspree.io/f/testform";
const ENDPOINT_B = "https://formspree.io/f/otherform";
const HTML = readFileSync(join(SITE, "index.html"), "utf8");

// The approved copy (copy v2), word for word.
const COPY = {
  title: "xmu · Work with your team and AI agents in one shared terminal",
  h1: "Work with your team and AI agents in one shared terminal.",
  sub: "Bring the agents you already use and invite your team. Everyone jumps into the same session, steers any agent, and builds on each other’s work at the same time.",
  figure: "Three teammates and their agents working in one xmu session",
};

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let base: string;

// Serves the site as Vercel would, with the vercel.json headers (so CSP is enforced).
// `?endpoint=1` swaps the form endpoint for a test one; `?endpoint=2` for a second one;
// `?endpoint=none` for the unset placeholder, as before Formspree was set up.
const VERCEL_HEADERS: Record<string, string> = Object.fromEntries(
  JSON.parse(readFileSync(join(SITE, "vercel.json"), "utf8"))
    .headers.find((h: { source: string }) => h.source === "/(.*)")
    .headers.map((h: { key: string; value: string }) => [h.key, h.value]),
);

function startServer() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      // Vercel Web Analytics is served by Vercel itself; locally it would 404 (a console
      // error), so stand in an empty script, as on a deployment with analytics off.
      if (path === "/_vercel/insights/script.js") {
        return new Response("", { headers: { ...VERCEL_HEADERS, "content-type": "text/javascript" } });
      }
      const file = join(SITE, path);
      if (!file.startsWith(SITE) || path.includes("..") || path.startsWith("/tests") || !existsSync(file)) {
        return new Response("not found", { status: 404 });
      }
      if (path === "/index.html" && url.searchParams.has("endpoint")) {
        const to = { "2": ENDPOINT_B, none: "REPLACE_ME" }[url.searchParams.get("endpoint")!] ?? ENDPOINT;
        const html = readFileSync(file, "utf8").replace(/(<form[^>]*\saction=)"[^"]*"/, `$1"${to}"`);
        return new Response(html, { headers: { ...VERCEL_HEADERS, "content-type": "text/html; charset=utf-8" } });
      }
      return new Response(Bun.file(file), { headers: VERCEL_HEADERS });
    },
  });
}

beforeAll(async () => {
  server = startServer();
  base = `http://localhost:${server.port}`;
  browser = await chromium.launch({ args: ["--font-render-hinting=full"] }); // hinted glyphs, as on CI: monospace text draws whole pixels wide there
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

async function open(
  opts: {
    width?: number;
    height?: number;
    scheme?: "dark" | "light";
    endpoint?: boolean | 2 | "none";
    reducedMotion?: "reduce" | "no-preference";
    init?: () => void; // runs in the page before any of its scripts, on every load
  } = {},
) {
  const context = await browser.newContext({
    viewport: { width: opts.width ?? 1280, height: opts.height ?? 800 },
    colorScheme: opts.scheme ?? "dark",
    reducedMotion: opts.reducedMotion ?? "no-preference",
  });
  // The page as shipped posts to the real xmu Formspree form. No test may send it a sign-up,
  // so every request to formspree.io is stopped here unless a test routes it to a stub.
  const realForm: string[] = [];
  await context.route("https://formspree.io/**", (route) => (realForm.push(route.request().url()), route.abort()));
  const page = await context.newPage();
  page.setDefaultTimeout(2000); // fail fast on a missing element, inside bun's 5s test timeout
  const errors: string[] = [];
  const offsite: string[] = [];
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) =>
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
    ),
  );
  if (opts.init) await page.addInitScript(opts.init);
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("request", (r) => {
    if (!r.url().startsWith(base) && !r.url().startsWith(ENDPOINT) && !r.url().startsWith(ENDPOINT_B)) offsite.push(r.url());
  });
  await page.goto(`${base}/${opts.endpoint ? `?endpoint=${opts.endpoint === true ? 1 : opts.endpoint}` : ""}`);
  return { page, errors, offsite, realForm, close: () => context.close() };
}

// Waits for every running animation to finish, however slow the machine.
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)).then(() => undefined));
const text = (page: Page, sel: string) => page.locator(sel).first().innerText();
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

type Box = { left: number; right: number; top: number; bottom: number };
const box = (page: Page, sel: string): Promise<Box> => page.locator(sel).first().evaluate((el) => el.getBoundingClientRect().toJSON());


// Composites a translucent CSS colour over an opaque one ("rgb(...)").
function over(top: string, under: string): string {
  const t = top.match(/[\d.]+/g)!.map(Number);
  if (!top.startsWith("rgba") || t[3] === undefined || t[3] >= 1) return top;
  const u = under.match(/[\d.]+/g)!.map(Number);
  return `rgb(${[0, 1, 2].map((i) => t[i] * t[3] + u[i] * (1 - t[3])).join(", ")})`;
}

// WCAG contrast ratio of two CSS rgb() colours.
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const scale = c.startsWith("color(srgb") ? 1 : 255;
    const [r, g, bl] = c.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((v) => {
      const s = v / scale;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Storage that throws on every access, as in some private modes.
const blockStorage = () => {
  Object.defineProperty(window, "localStorage", {
    get() {
      throw new DOMException("blocked", "SecurityError");
    },
  });
};
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const shown = (page: Page, sel: string) => page.locator(sel).first().isVisible();

describe("structure", () => {
  let page: Page;
  let close: () => Promise<void>;
  let errors: string[];
  let offsite: string[];
  beforeAll(async () => ({ page, close, errors, offsite } = await open()));
  afterAll(() => close());

  test("document basics: language, title, description, viewport, color schemes", async () => {
    expect(await page.getAttribute("html", "lang")).toBe("en");
    expect(await page.title()).toBe(COPY.title);
    expect(await page.getAttribute('meta[name="description"]', "content")).toBe(COPY.sub);
    expect(await page.getAttribute('meta[name="viewport"]', "content")).toContain("width=device-width");
    expect(await page.getAttribute('meta[name="viewport"]', "content")).toContain("viewport-fit=cover");
    expect(await page.getAttribute('meta[name="color-scheme"]', "content")).toBe("dark light");
    expect(await page.getAttribute('meta[property="og:title"]', "content")).toBe(COPY.title);
    expect(await page.getAttribute('meta[property="og:description"]', "content")).toBe(COPY.sub);
  });

  test("share preview: canonical xmu.sh URL, a 1200x630 image and a large card", async () => {
    expect(await page.getAttribute('link[rel="canonical"]', "href")).toBe("https://xmu.sh/");
    expect(await page.getAttribute('meta[property="og:url"]', "content")).toBe("https://xmu.sh/");
    expect(await page.getAttribute('meta[property="og:image"]', "content")).toBe("https://xmu.sh/assets/og.png");
    expect(await page.getAttribute('meta[property="og:image:width"]', "content")).toBe("1200");
    expect(await page.getAttribute('meta[property="og:image:height"]', "content")).toBe("630");
    expect(await page.getAttribute('meta[property="og:image:alt"]', "content")).toMatch(/^xmu: /);
    expect(await page.getAttribute('meta[name="twitter:card"]', "content")).toBe("summary_large_image");
  });

  test("the share image is a 1200x630 PNG that Vercel deploys", () => {
    const png = readFileSync(join(SITE, "assets/og.png"));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(png.length).toBeLessThan(1_000_000); // link previews drop big images
    expect(readFileSync(join(SITE, ".vercelignore"), "utf8")).not.toMatch(/og\.png|^assets\/?$/m);
  });

  test("favicon and home-screen icon are the brand mark, as PNG files that exist", async () => {
    const icon = page.locator('link[rel="icon"]');
    expect(await icon.getAttribute("href")).toBe("assets/brand/favicon-32.png");
    expect(await icon.getAttribute("type")).toBe("image/png");
    expect(await page.getAttribute('link[rel="apple-touch-icon"]', "href")).toBe("assets/brand/apple-touch-icon.png");
    for (const f of ["assets/brand/favicon-32.png", "assets/brand/apple-touch-icon.png"]) expect(existsSync(join(SITE, f))).toBe(true);
    expect(existsSync(join(SITE, "assets/favicon.svg"))).toBe(false);
  });

  test("page skeleton: skip link, header, main with the sections in order, footer", async () => {
    expect(await page.getAttribute("a.skip", "href")).toBe("#main");
    expect(await page.locator("header.nav").count()).toBe(1);
    const ids = await page.$$eval("main#main section[id]", (els) => els.map((e) => e.id));
    expect(ids).toEqual(["top", "pain", "demo", "drive", "context", "how", "stack", "waitlist"]);
    expect(squash(await text(page, "footer.foot"))).toBe("© 2026 xmu labs");
  });

  test("header: the brand goes home, one waitlist button, one theme button", async () => {
    const brand = page.locator(".nav a.brand");
    expect(await brand.getAttribute("href")).toBe("#top");
    expect(await brand.getAttribute("aria-label")).toBe("xmu home");
    const cta = page.locator(".nav a.btn.sm");
    expect(await cta.count()).toBe(1);
    expect(squash(await cta.innerText())).toBe("Join the waitlist →");
    expect(await cta.getAttribute("href")).toBe("#waitlist");
    expect(await page.locator(".nav .arr").getAttribute("aria-hidden")).toBe("true");
    expect(await page.locator(".nav button.theme").count()).toBe(1);
  });

  test("no inline styles or inline scripts in the HTML (strict CSP)", () => {
    expect(HTML).not.toMatch(/\sstyle\s*=/i);
    expect(HTML).not.toMatch(/<style[\s>]/i);
    for (const tag of HTML.match(/<script\b[^>]*>/gi) ?? []) expect(tag).toMatch(/\ssrc=/i);
  });

  test("Vercel Web Analytics loads from this site, deferred, with no inline set-up", async () => {
    const tag = page.locator('head script[src="/_vercel/insights/script.js"]');
    expect(await tag.count()).toBe(1);
    expect(await tag.getAttribute("defer")).not.toBeNull();
  });

  test("fonts are self-hosted, load, and ship with their licence", async () => {
    const loaded = await page.evaluate(() =>
      Promise.all(['600 16px Sora', "16px Inter", "14px Geist", '14px "Geist Mono"'].map((f) => document.fonts.load(f).then((faces) => faces.length))),
    );
    expect(loaded).toEqual([1, 1, 1, 1]);
    for (const family of ["sora", "inter", "geist", "geist-mono"]) {
      expect(existsSync(join(SITE, `assets/fonts/${family}-latin-wght-normal.woff2`))).toBe(true);
      expect(readFileSync(join(SITE, `assets/fonts/OFL-${family}.txt`), "utf8")).toContain("SIL Open Font License, Version 1.1");
    }
    for (const old of ["cabinet-grotesk-700", "general-sans-400", "general-sans-500", "jetbrains-mono-400"]) {
      expect(existsSync(join(SITE, `assets/fonts/${old}.woff2`))).toBe(false);
    }
  });

  test("every in-page link points at an element that exists", async () => {
    const hrefs = await page.$$eval('a[href^="#"]', (as) => as.map((a) => a.getAttribute("href")!));
    for (const h of hrefs) expect(await page.locator(h).count()).toBe(1);
  });

  test("inspiration sites are never named on the page (they are not xmu's brand)", async () => {
    const words = [
      await page.evaluate(() => document.body.textContent!),
      await page.title(),
      ...(await page.$$eval("meta[content]", (ms) => ms.map((m) => m.getAttribute("content")!))),
    ].join("\n");
    expect(words).not.toMatch(/space\s?aix|memorable|mem0|\blinear\b|grok/i);
  });

  test("no script errors, CSP violations or third-party requests on load", async () => {
    expect(errors).toEqual([]);
    expect(offsite).toEqual([]);
  });
});

describe("theme", () => {
  test("dark by default; the button switches and the choice is remembered", async () => {
    const { page, close, errors } = await open({ scheme: "light" }); // the system setting does not decide
    expect(await theme(page)).toBe("dark");
    expect(await page.getAttribute(".nav .theme", "aria-label")).toBe("Switch to light theme");
    await page.click(".nav .theme");
    expect(await theme(page)).toBe("light");
    expect(await page.getAttribute(".nav .theme", "aria-label")).toBe("Switch to dark theme");
    await page.reload();
    expect(await theme(page)).toBe("light");
    expect(errors).toEqual([]);
    await close();
  });

  test("a saved light theme applies before first paint", async () => {
    const head = HTML.slice(0, HTML.indexOf("</head>"));
    const first = head.match(/<script\b[^>]*>/i)![0];
    expect(first).toMatch(/\ssrc="theme\.js"/);
    expect(first).not.toMatch(/\s(defer|async)\b|type="module"/);
    expect(head.indexOf('src="theme.js"')).toBeLessThan(head.indexOf('href="styles.css"'));
    const { page, close } = await open({
      init: () => {
        localStorage.setItem("xmu-theme", "light");
        document.addEventListener("DOMContentLoaded", () => ((window as any).seen = document.documentElement.dataset.theme), { capture: true });
      },
    });
    expect(await page.evaluate(() => (window as any).seen)).toBe("light");
    await close();
  });

  test("theme still works with storage blocked", async () => {
    const { page, close, errors } = await open({ init: blockStorage });
    expect(await theme(page)).toBe("dark");
    await page.click(".nav .theme");
    expect(await theme(page)).toBe("light");
    expect(errors).toEqual([]);
    await close();
  });

  // As in the approved mock, the same crisp mark sits on both grounds.
  test("the logo mark is the same image in both themes", async () => {
    const { page, close } = await open();
    const marks = () => page.locator(".brand img.mk").evaluateAll((imgs) =>
      imgs.filter((i) => i.getClientRects().length > 0).map((i) => (i as HTMLImageElement).getAttribute("src")));
    expect(await marks()).toEqual(["assets/brand/mark-dark.webp", "assets/brand/mark-dark.webp"]);
    await page.click(".nav .theme");
    expect(await marks()).toEqual(["assets/brand/mark-dark.webp", "assets/brand/mark-dark.webp"]);
    expect(await page.locator(".brand img.mk").count()).toBe(2);
    await close();
  });

  test("theme-color follows the theme", async () => {
    const { page, close } = await open();
    expect(await page.getAttribute('meta[name="theme-color"]', "content")).toBe("#050A12");
    await page.click(".nav .theme");
    expect(await page.getAttribute('meta[name="theme-color"]', "content")).toBe("#F7FAFF");
    await close();
  });

  test("the theme button shows a sun in dark and a moon in light", async () => {
    const { page, close } = await open();
    expect([await shown(page, ".theme .i-sun"), await shown(page, ".theme .i-moon")]).toEqual([true, false]);
    await page.click(".nav .theme");
    expect([await shown(page, ".theme .i-sun"), await shown(page, ".theme .i-moon")]).toEqual([false, true]);
    await close();
  });

  test("page colours follow the theme", async () => {
    const { page, close } = await open();
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(await bg()).toBe("rgb(5, 10, 18)");
    await page.click(".nav .theme");
    expect(await bg()).toBe("rgb(247, 250, 255)");
    await close();
  });
});

// The window's timing, in document order (XMU-833: the video's story). The work starts at 2.2s,
// once everyone has joined (was 2.6s); typing keeps the mock's 22ms per character. The CSP forbids
// inline styles, so each value lives in a step class in styles.css.
const STEPS = [
  // ben's pane: ana's "typing" pill, the log giving way to the fix, his prompt giving way to ana's steer
  { d: "4.70s" }, { d: "2.20s" }, { d: "2.20s" }, { d: "2.20s" }, { d: "2.50s" }, { d: "2.80s" }, { d: "2.95s" }, { d: "3.10s" }, { d: "3.30s" },
  { d: "4.70s" }, { d: "4.70s" }, { d: "4.70s" },
  // ana's Codex: her first prompt types into the empty one, an answer, a second prompt, working
  { d: "2.50s" }, { n: "22", d: "2.50s", t: "0.48s" }, { d: "3.10s" }, { d: "3.40s" }, { n: "33", d: "3.40s", t: "0.73s" }, { d: "4.25s" }, { d: "4.25s" },
  // mia's Cursor: her empty box gives way to her ask, then her agent reads, greps and watches
  { d: "2.80s" }, { d: "2.80s" }, { d: "3.30s" }, { d: "3.70s" }, { d: "4.10s" }, { d: "2.80s" },
  // chat: ben's Claude, then ana
  { d: "2.65s" }, { d: "4.40s" },
];

describe("hero", () => {
  let page: Page;
  let close: () => Promise<void>;
  beforeAll(async () => ({ page, close } = await open({ width: 1440, height: 900 })));
  afterAll(() => close());

  test("hero copy is the approved copy, word for word", async () => {
    expect(await page.locator("h1").count()).toBe(1);
    expect(await text(page, "#top h1")).toBe(COPY.h1);
    expect(squash(await text(page, "#top .sub"))).toBe(COPY.sub);
    expect(await text(page, "#top .actions-note small")).toBe("Early access for small teams.");
  });

  test("hero has one primary waitlist button", async () => {
    const primary = page.locator("#top .actions a.btn:not(.ghost)");
    expect(await primary.count()).toBe(1);
    expect(await primary.evaluate((el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim())).toBe("Join the waitlist");
    expect(await primary.locator(".arr").getAttribute("aria-hidden")).toBe("true");
    expect(await primary.getAttribute("href")).toBe("#waitlist");
  });

  test("the window is one image with the approved label, insides hidden, nothing focusable", async () => {
    const fig = page.locator("#top figure.tm");
    expect(await fig.count()).toBe(1);
    expect(await fig.getAttribute("role")).toBe("img");
    expect(await fig.getAttribute("aria-label")).toBe(COPY.figure);
    const kids = await fig.evaluate((el) => [...el.children].map((c) => c.getAttribute("aria-hidden")));
    expect(kids.length).toBeGreaterThan(0);
    expect(kids.every((h) => h === "true")).toBe(true);
    expect(await page.locator("#top figure :is(a, button, input, select, textarea, [tabindex], [contenteditable])").count()).toBe(0);
    expect(await page.locator("#top figure :is(h1, h2, h3, h4, h5, h6, nav)").count()).toBe(0);
  });

  test("the window's timing matches the mock, one step class per moment, no inline styles", async () => {
    expect(await page.locator("#top [style]").count()).toBe(0);
    const seen = await page.$$eval("#top figure [class]", (els) =>
      els
        .filter((el) => [...el.classList].some((c) => /^s\d+$/.test(c)))
        .map((el) => {
          const cs = getComputedStyle(el);
          const v = (p: string) => cs.getPropertyValue(p).trim();
          return { cls: [...el.classList].find((c) => /^s\d+$/.test(c)), n: v("--n"), d: v("--d"), t: v("--t") };
        }),
    );
    expect(seen.map((s) => s.cls)).toEqual(STEPS.map((_, i) => `s${i + 1}`));
    expect(seen.map(({ n, d, t }) => ({ ...(n && { n }), d, ...(t && { t }) }))).toEqual(STEPS);
  });

  test("with motion, everything has landed by 5.5s and the last chat message lands after 4.4s", async () => {
    const ends = await page.evaluate(() =>
      document
        .querySelector("#top figure")!
        .getAnimations({ subtree: true })
        .filter((a) => !["blink", "wd"].includes((a as CSSAnimation).animationName)) // the caret blink and working dots idle on after landing
        .map((a) => Number(a.effect!.getComputedTiming().endTime)),
    );
    expect(ends.length).toBeGreaterThan(19);
    expect(Math.max(...ends)).toBeLessThanOrEqual(5500);
    const last = await page.evaluate(() =>
      Number(document.querySelector("#top .chat li:last-child")!.getAnimations()[0].effect!.getComputedTiming().endTime),
    );
    expect(last).toBeGreaterThan(4400);
  });

  test("desktop 1440x900: three panes and the chat are visible, the window starts above y=600", async () => {
    for (const sel of [".pane.ben", ".pane.ana", ".pane.mia", ".chat"]) expect([sel, await shown(page, `#top ${sel}`)]).toEqual([sel, true]);
    const [ben, ana, mia, chat, fig] = await Promise.all([".pane.ben", ".pane.ana", ".pane.mia", ".chat", "figure.tm"].map((s) => box(page, `#top ${s}`)));
    expect(fig.top).toBeLessThan(600); // XMU-817 centres the copy above it, two buttons and a note
    expect(ben.right).toBeLessThanOrEqual(ana.left + 1); // ben | ana over mia
    expect(ana.bottom).toBeLessThanOrEqual(mia.top + 1);
    expect(Math.abs(ana.left - mia.left)).toBeLessThan(1);
    expect(chat.left).toBeGreaterThanOrEqual(ana.right - 1);
  });

  test('desktop: the window marks the session "active" next to the count', async () => {
    expect(await shown(page, "#top .here .live")).toBe(true);
    expect(await text(page, "#top .here .live")).toBe("active");
    expect(await text(page, "#top .cnt .c3 .wide")).toBe("3 people · 3 agents");
  });

  test("the window stays dark in the light theme", async () => {
    const bg = () => page.locator("#top figure.tm").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await bg()).toBe("rgb(7, 16, 28)");
    await page.click(".nav .theme");
    expect(await bg()).toBe("rgb(7, 16, 28)");
    await page.click(".nav .theme");
  });
});

describe("hero at other widths", () => {
  test("1024: ben on top, ana and mia below side by side, chat beside the panes", async () => {
    const { page, close } = await open({ width: 1024, height: 768 });
    const [ben, ana, mia, chat, panes] = await Promise.all([".pane.ben", ".pane.ana", ".pane.mia", ".chat", ".panes"].map((s) => box(page, `#top ${s}`)));
    expect(ben.bottom).toBeLessThanOrEqual(ana.top + 1);
    expect(Math.abs(ana.top - mia.top)).toBeLessThan(1);
    expect(ana.right).toBeLessThanOrEqual(mia.left + 1);
    expect(chat.left).toBeGreaterThanOrEqual(panes.right - 1);
    await close();
  });

  test("768: the chat moves under the panes", async () => {
    const { page, close } = await open({ width: 768, height: 1024 });
    const [chat, panes] = await Promise.all([".chat", ".panes"].map((s) => box(page, `#top ${s}`)));
    expect(chat.top).toBeGreaterThanOrEqual(panes.bottom - 1);
    await close();
  });

  // XMU-833: the phone bar shows the session name and the avatars; the count text is gone
  test("phone 320 to 340: the avatars fit inside the window bar, not cut at its edge", async () => {
    for (const width of [320, 330, 340]) {
      const { page, close } = await open({ width, height: 700 });
      const [mia, bar] = await Promise.all(["#top .who.mia", "#top .tm-bar"].map((s) => box(page, s)));
      expect([width, mia.right <= bar.right - 6]).toEqual([width, true]);
      await close();
    }
  });

  // CI's Chromium draws text a few pixels wider than a dev machine: keep room to spare, not 2px
  test("phone 320 to 375: room to spare beside the session name and in the header", async () => {
    for (const width of [320, 330, 340, 345, 350, 360, 361, 375]) {
      const { page, close } = await open({ width, height: 700 });
      const [title, ben, logo, theme] = await Promise.all(["#top .tm-title", "#top .who.ben", ".nav .brand", ".nav .theme"].map((s) => box(page, s)));
      // a failure prints the width and the pixels to spare in both places (CI draws text up to ~10px wider than a dev machine)
      const spare = (px: number) => (Math.round(px) >= 6 ? "ok" : Math.round(px));
      expect({ width, title: spare(ben.left - title.right), header: spare(theme.left - logo.right) }).toEqual({ width, title: "ok", header: "ok" });
      await close();
    }
  });

  // XMU-833: the phone shows ben's pane, the chat under it and xmu's bar; "3 people, 3 agents, active" is gone
  test("phone 375: only ben's pane, the chat and xmu's bar, no count text, and Tab skips the window", async () => {
    const { page, close } = await open({ width: 375, height: 812 });
    expect(await shown(page, "#top .pane.ben")).toBe(true);
    expect([await shown(page, "#top .pane.ana"), await shown(page, "#top .pane.mia")]).toEqual([false, false]);
    expect([await shown(page, "#top .chat"), await shown(page, "#top .xb")]).toEqual([true, true]);
    expect(await shown(page, "#top .cnt")).toBe(false);
    await page.locator("#top .actions a.btn:not(.ghost)").focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("figure"))).toBe(false);
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    await close();
  });

  test("reduced motion: every line and message is fully shown at load, no caret", async () => {
    const { page, close } = await open({ width: 1440, height: 900, reducedMotion: "reduce" });
    const state = await page.evaluate(() => ({
      clipped: [...document.querySelectorAll("#top .ln")].filter((el) => getComputedStyle(el).clipPath !== "none").length,
      // everything that arrives: lines (.up), states shown at once (.show), the panes and avatars that join, the count, chat rows
      faded: [...document.querySelectorAll("#top :is(.up, .show, .pane.j1, .pane.j2, .who.j1, .who.j2, .cnt .c3, .chat li)")]
        .filter((el) => getComputedStyle(el).opacity !== "1").map((el) => el.className),
      carets: [...document.querySelectorAll("#top .tw")].filter((el) => getComputedStyle(el, "::after").display !== "none").length,
      moving: document.querySelector("#top figure")!.getAnimations({ subtree: true }).length,
    }));
    expect(state).toEqual({ clipped: 0, faded: [], carets: 0, moving: 0 });
    await close();
  });
});

const SECTIONS = {
  pain: "You’re on a team. Working with AI should feel like it.",
  painBody:
    "Today one person shares their screen and drives. Everyone else works with their own agent and pastes the results into the chat. The driver reads it all, sorts out what fits, and pastes it in. The rest of the team watches.",
  proof:
    // The survey asked these two questions of developers who use AI agents, not of all developers.
    "In the 2025 Stack Overflow survey, 69% of developers who use AI agents said the agents made them more productive. Only 17% said agents improved how their team works together. Source",
  drive: "In xmu, everyone drives.",
  driveBody:
    "Your teammates and their agents work in the same session with the same context. Agree on the approach, tell any agent what to do, and watch each result land where everyone can see it.",
  context: "Pick up where your team left off.",
  contextBody:
    "The conversations, decisions and work so far stay in the session, for people and agents. Join late and you’re caught up without anyone explaining it again.",
};

describe("sections", () => {
  let page: Page;
  let close: () => Promise<void>;
  beforeAll(async () => ({ page, close } = await open({ width: 1440, height: 900 })));
  afterAll(() => close());

  test("section copy is word for word", async () => {
    expect(await text(page, "#pain h2")).toBe(SECTIONS.pain);
    expect(squash(await text(page, "#pain > p:not(.proof)"))).toBe(SECTIONS.painBody);
    expect(squash(await text(page, "#pain .proof"))).toBe(SECTIONS.proof);
    expect(await page.locator("#pain .proof b").allInnerTexts()).toEqual(["69%", "17%"]);
    const source = page.locator("#pain .proof a");
    expect(await source.innerText()).toBe("Source");
    expect(await source.getAttribute("href")).toBe("https://survey.stackoverflow.co/2025/ai");
    expect(await text(page, "#drive h2")).toBe(SECTIONS.drive);
    expect(squash(await text(page, "#drive p"))).toBe(SECTIONS.driveBody);
    expect(await text(page, "#context h2")).toBe(SECTIONS.context);
    expect(squash(await text(page, "#context p"))).toBe(SECTIONS.contextBody);
  });

  test("page order: the pain, the two answers, then the waitlist", async () => {
    const heads = await page.locator("main h2").allInnerTexts();
    expect(heads).toEqual([SECTIONS.pain, SECTIONS.drive, SECTIONS.context, "How it works", "Works with your existing stack and any coding agent.", "Get early access to xmu."]);
  });

  test("the survey line sits inside the pain section, after its paragraph", async () => {
    const order = await page.$$eval("#pain > *", (els) => els.map((e) => e.tagName.toLowerCase() + (e.className ? `.${e.className}` : "")));
    expect(order).toEqual(["h2", "p", "p.proof"]);
  });

  test("each section is named by its heading", async () => {
    for (const id of ["top", "pain", "drive", "context"]) {
      const label = await page.getAttribute(`#${id}`, "aria-labelledby");
      expect([id, await page.locator(`#${label} `).evaluate((el) => /^H[12]$/.test(el.tagName))]).toEqual([id, true]);
    }
  });

  test("desktop: the two answers share one row", async () => {
    const [drive, context] = await Promise.all(["#drive", "#context"].map((s) => box(page, s)));
    expect(Math.abs(drive.top - context.top)).toBeLessThan(1);
    expect(drive.right).toBeLessThanOrEqual(context.left);
  });

  test("the demo section shows the video (XMU-830) and has no placeholder marker", async () => {
    const demo = page.locator("#demo");
    expect(await demo.count()).toBe(1);
    expect(await demo.isVisible()).toBe(true);
    expect(await demo.locator("video").count()).toBe(1);
    // No placeholder marker is left anywhere on the page since "Book a call" went (XMU-859).
    expect(await page.locator("[data-placeholder]").count()).toBe(0);
  });
});

describe("sections at other widths", () => {
  test("1023 and below: the two answers stack", async () => {
    const { page, close } = await open({ width: 1023, height: 800 });
    const [drive, context] = await Promise.all(["#drive", "#context"].map((s) => box(page, s)));
    expect(context.top).toBeGreaterThanOrEqual(drive.bottom);
    await close();
  });

  test("every section clears the sticky header when jumped to", async () => {
    for (const width of [1440, 375]) {
      const { page, close } = await open({ width, height: 800, reducedMotion: "reduce" });
      for (const id of ["pain", "drive", "context"]) {
        await page.evaluate((h) => (location.hash = h), `#${id}`);
        const nav = await box(page, ".nav");
        const head = await box(page, `#${id} h2`);
        expect([width, id, head.top >= nav.bottom + 8]).toEqual([width, id, true]);
      }
      await close();
    }
  });
});

// The waitlist card (copy v2, form states). Requests to the form service are
// answered by page.route, so nothing leaves the machine.
const WL = {
  joined: "You’re in. We’ll email you when your team can try xmu.",
  already: "You’re already on the list.",
  bad: "Enter a work email, like you@company.com",
  error: "That didn’t go through. Try again.",
  closed: "The waitlist opens soon. Please check back.",
  thanks: "Thanks. That helps us pick the first teams.",
};
const state = (page: Page) => page.getAttribute("#waitlist .card", "data-state");
const msg = (page: Page) => page.locator("#email-msg").innerText();
const focused = (page: Page) => page.evaluate(() => document.activeElement?.matches("#email") ? "#email" : document.activeElement?.className || document.activeElement?.tagName);

// A page whose form posts to the test endpoint. reply decides each answer; hold() keeps the
// next request waiting until release() is called.
async function withForm(reply: (n: number) => "ok" | "abort" | number = () => "ok") {
  const ctx = await open({ endpoint: true });
  const posted: any[] = [];
  let gate: Promise<void> | null = null;
  let release = () => {};
  await ctx.page.route(ENDPOINT, async (route) => {
    posted.push(JSON.parse(route.request().postData() ?? "null"));
    if (gate) await gate;
    const r = reply(posted.length);
    if (r === "abort") return route.abort();
    await route.fulfill({ status: r === "ok" ? 200 : r, contentType: "application/json", body: r === "ok" ? '{"ok":true}' : '{"errors":[{"message":"no"}]}' });
  });
  const hold = () => {
    gate = new Promise<void>((r) => (release = () => ((gate = null), r())));
  };
  return { ...ctx, posted, hold, release: () => release() };
}

async function signUp(page: Page, email = "ana@example.com") {
  await page.fill("#email", email);
  await page.click(".step1 button[type=submit]");
}

describe("waitlist card", () => {
  let page: Page;
  let realForm: string[];
  let close: () => Promise<void>;
  beforeAll(async () => ({ page, realForm, close } = await open()));
  afterAll(() => close());

  test("heading and line are the approved copy", async () => {
    expect(await text(page, "#waitlist h2")).toBe("Get early access to xmu.");
    expect(await text(page, "#waitlist .wl-copy p")).toBe("We’re starting with a few small teams.");
    expect(await page.getAttribute("#waitlist", "aria-labelledby")).toBe(await page.getAttribute("#waitlist h2", "id"));
  });

  test("idle: visible label, required work-email field, live message line, one button", async () => {
    expect(await page.locator('label[for="email"]').innerText()).toBe("Work email");
    expect(await page.locator('label[for="email"]').isVisible()).toBe(true);
    const input = page.locator("#email");
    expect(await input.getAttribute("type")).toBe("email");
    expect(await input.getAttribute("required")).not.toBeNull();
    expect(await input.getAttribute("autocomplete")).toBe("email");
    expect(await input.getAttribute("aria-describedby")).toBeNull(); // only an error describes the field
    expect(await page.getAttribute("#email-msg", "aria-live")).toBe("polite");
    expect(await page.locator(".step1 button[type=submit]").innerText()).toBe("Join the waitlist");
    expect(await text(page, ".step1 .fine")).toBe("We’ll only email you about early access.");
    expect(await state(page)).toBe("idle");
    expect([await shown(page, ".step2"), await shown(page, "#waitlist .thanks")]).toEqual([false, false]);
  });

  test("step 2 asks two optional questions with visible legends, nothing picked", async () => {
    expect(await text(page, ".step2 .fine")).toBe("Two optional questions help us pick the first teams.");
    expect(await page.locator(".step2 legend").allTextContents()).toEqual(["Team size", "Which agents does your team use?"]);
    const opts = (name: string) =>
      page.$$eval(`.step2 input[name="${name}"]`, (els) => els.map((e) => [(e as HTMLInputElement).value, (e as HTMLInputElement).labels![0].textContent!.trim(), (e as HTMLInputElement).checked]));
    expect(await opts("team_size")).toEqual([["2-5", "2 to 5", false], ["6-10", "6 to 10", false], ["11+", "11 or more", false]]);
    expect(await opts("agents")).toEqual([["claude", "Claude", false], ["codex", "Codex", false], ["cursor", "Cursor", false], ["copilot", "Copilot", false], ["other", "Other", false]]);
    expect(await page.locator(".step2 [aria-live=polite]#answers-msg").count()).toBe(1);
    expect(await page.getAttribute(".step2 .done", "tabindex")).toBe("-1");
    expect(await page.getAttribute("#waitlist .thanks", "tabindex")).toBe("-1");
  });

  test("without JavaScript the email posts to the form service, with native email checks", async () => {
    expect(await page.getAttribute(".step1", "method")).toBe("post");
    expect(await page.getAttribute(".step1", "action")).toBeTruthy();
    expect(HTML.indexOf('class="step1"')).toBeLessThan(HTML.indexOf('class="step2"')); // the first form is the one launch-check reads
    expect(HTML).not.toMatch(/<form[^>]*novalidate/i);
  });

  test("honeypot field is invisible and skipped by keyboard and screen readers", async () => {
    const pot = page.locator('#waitlist input[name="_gotcha"]');
    expect(await pot.count()).toBe(1);
    expect(await pot.isVisible()).toBe(false);
    expect(await pot.getAttribute("tabindex")).toBe("-1");
    expect(await pot.getAttribute("id")).not.toMatch(/company|name|org/i);
    expect(await page.locator("#waitlist .pot label").innerText()).not.toMatch(/company|name|org/i);
    expect(await page.locator("#waitlist .pot").getAttribute("aria-hidden")).toBe("true");
  });

  test("before the form service is set up, the card says so instead of faking success", async () => {
    const ctx = await open({ endpoint: "none" });
    try {
      await signUp(ctx.page);
      await ctx.page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") !== "idle");
      expect([await state(ctx.page), await msg(ctx.page)]).toEqual(["closed", WL.closed]);
      expect(await shown(ctx.page, ".step2")).toBe(false);
      expect(ctx.realForm).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  test("the page as shipped posts to the real form, and the tests stop that request", async () => {
    await signUp(page);
    await page.waitForFunction(() => !["idle", "sending"].includes(document.querySelector("#waitlist .card")!.getAttribute("data-state")!));
    expect(await state(page)).toBe("error");
    expect(realForm).toHaveLength(1);
    expect(realForm[0]).toMatch(/^https:\/\/formspree\.io\/f\/[A-Za-z0-9]+$/);
  });
});

describe("waitlist step 1", () => {
  test("a bad email: inline message, field marked and focused, nothing sent", async () => {
    const { page, posted, close } = await withForm();
    for (const raw of ["ana@", ""]) {
      await signUp(page, raw);
      await page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "bad");
      expect(await msg(page)).toBe(WL.bad);
      expect(await page.getAttribute("#email", "aria-invalid")).toBe("true");
      expect(await page.getAttribute("#email", "aria-describedby")).toBe("email-msg");
      expect(await focused(page)).toBe("#email");
    }
    expect(posted).toHaveLength(0);
    await close();
  });

  test('sending: "Joining…", busy at the same width, field kept and readable, one request', async () => {
    const { page, posted, hold, release, close } = await withForm();
    const button = page.locator(".step1 button[type=submit]");
    const width = (await button.boundingBox())!.width;
    hold();
    await signUp(page, "bad");
    await page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "bad");
    await signUp(page, "lea@example.com");
    await page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "sending");
    expect(await button.innerText()).toBe("Joining…");
    expect(await button.getAttribute("aria-disabled")).toBe("true");
    expect((await button.boundingBox())!.width).toBe(width);
    expect(await page.inputValue("#email")).toBe("lea@example.com");
    expect(await page.getAttribute("#email", "aria-invalid")).not.toBe("true");
    expect(await page.getAttribute("#email", "aria-describedby")).toBeNull();
    // Playwright's click() treats aria-disabled as disabled, so press it the way a keyboard user would.
    await button.focus();
    await page.keyboard.press("Enter");
    release();
    await page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "in");
    expect(posted).toEqual([{ email: "lea@example.com" }]);
    await close();
  });

  for (const [name, reply] of [["network error", "abort"], ["server error", 500]] as const) {
    test(`${name}: try-again message, button active, email kept, not marked invalid`, async () => {
      const { page, close } = await withForm(() => reply);
      await signUp(page);
      await page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "error");
      expect(await msg(page)).toBe(WL.error);
      expect(await page.getAttribute(".step1 button[type=submit]", "aria-disabled")).not.toBe("true");
      expect(await page.locator(".step1 button[type=submit]").innerText()).toBe("Join the waitlist");
      expect(await page.inputValue("#email")).toBe("ana@example.com");
      expect(await page.getAttribute("#email", "aria-invalid")).not.toBe("true");
      await close();
    });
  }

  test("an email the form service rejects shows the bad-email message", async () => {
    const ctx = await open({ endpoint: true });
    await ctx.page.route(ENDPOINT, (route) =>
      route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ errors: [{ code: "TYPE_EMAIL", message: "should be an email" }] }) }),
    );
    await signUp(ctx.page);
    await ctx.page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "bad");
    expect(await msg(ctx.page)).toBe(WL.bad);
    expect(await ctx.page.getAttribute("#email", "aria-invalid")).toBe("true");
    await ctx.close();
  });

  test("already on the list: a calm message, no error colour, no step 2, focus stays on the button", async () => {
    const { page, posted, close } = await withForm();
    await signUp(page);
    await page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "in");
    await page.reload();
    await page.fill("#email", "ANA@example.com ");
    await page.focus(".step1 button[type=submit]");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "known");
    expect(await msg(page)).toBe(WL.already);
    const [color, muted] = await page.evaluate(() => [getComputedStyle(document.querySelector("#email-msg")!).color, getComputedStyle(document.querySelector(".fine")!).color]);
    expect(color).toBe(muted);
    expect(await shown(page, ".step2")).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.matches(".step1 button[type=submit]"))).toBe(true);
    expect(posted).toHaveLength(1);
    await close();
  });

  test("joining one form endpoint does not stop the same email joining a different one later", async () => {
    const ctx = await open({ endpoint: true });
    const posted: string[] = [];
    for (const url of [ENDPOINT, ENDPOINT_B]) {
      await ctx.page.route(url, async (route) => {
        posted.push(url);
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      });
    }
    await signUp(ctx.page);
    await ctx.page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "in");
    await ctx.page.goto(`${base}/?endpoint=2`); // same browser storage, new endpoint
    await signUp(ctx.page);
    await ctx.page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "in");
    expect(posted).toEqual([ENDPOINT, ENDPOINT_B]);
    await ctx.close();
  });
});

describe("waitlist step 2", () => {
  async function joined(reply?: (n: number) => "ok" | "abort" | number) {
    const ctx = await withForm(reply);
    await signUp(ctx.page);
    await ctx.page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "in");
    return ctx;
  }
  const done = (page: Page) => page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "thanks");

  test("success: the email went alone, step 2 shows, focus on the success line", async () => {
    const { page, posted, close } = await joined();
    expect(posted).toEqual([{ email: "ana@example.com" }]);
    expect([await shown(page, ".step1"), await shown(page, ".step2")]).toEqual([false, true]);
    expect(squash(await text(page, ".step2 .done"))).toContain(WL.joined);
    expect(await page.evaluate(() => document.activeElement?.classList.contains("done"))).toBe(true);
    await close();
  });

  test("Skip: thanks, with focus, and nothing more is sent", async () => {
    const { page, posted, close } = await joined();
    await page.click(".step2 button.link");
    await done(page);
    expect(await shown(page, ".step2")).toBe(false);
    expect(squash(await text(page, "#waitlist .thanks"))).toContain(WL.thanks);
    expect(await page.evaluate(() => document.activeElement?.classList.contains("thanks"))).toBe(true);
    expect(posted).toHaveLength(1);
    await close();
  });

  test("Send with answers posts them once, then thanks", async () => {
    const { page, posted, close } = await joined();
    await page.check('.step2 input[name="team_size"][value="6-10"]');
    await page.check('.step2 input[name="agents"][value="cursor"]');
    await page.check('.step2 input[name="agents"][value="claude"]');
    await page.click(".step2 button[type=submit]");
    await done(page);
    expect(posted).toEqual([{ email: "ana@example.com" }, { email: "ana@example.com", step: "answers", team_size: "6-10", agents: ["claude", "cursor"] }]);
    expect(await page.evaluate(() => document.activeElement?.classList.contains("thanks"))).toBe(true);
    await close();
  });

  test("Send with nothing picked: thanks, no request", async () => {
    const { page, posted, close } = await joined();
    await page.click(".step2 button[type=submit]");
    await done(page);
    expect(posted).toHaveLength(1);
    await close();
  });

  test('sending: Send reads "Sending…" at the same width, busy, Skip busy too', async () => {
    const { page, hold, release, close } = await joined();
    const send = page.locator(".step2 button[type=submit]");
    const width = (await send.boundingBox())!.width;
    await page.check('.step2 input[name="team_size"][value="2-5"]');
    hold();
    await send.click();
    await page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "answering");
    expect(await send.innerText()).toBe("Sending…");
    expect(await send.getAttribute("aria-disabled")).toBe("true");
    expect(await page.getAttribute(".step2 button.link", "aria-disabled")).toBe("true");
    expect((await send.boundingBox())!.width).toBe(width);
    release();
    await done(page);
    await close();
  });

  test("send fails: try-again message, picks kept, Send active, Skip still finishes", async () => {
    const { page, posted, close } = await joined((n) => (n === 2 ? "abort" : "ok"));
    await page.check('.step2 input[name="team_size"][value="11+"]');
    await page.check('.step2 input[name="agents"][value="codex"]');
    await page.click(".step2 button[type=submit]");
    await page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "answer-error");
    expect(await page.locator("#answers-msg").innerText()).toBe(WL.error);
    expect(await page.isChecked('.step2 input[value="11+"]')).toBe(true);
    expect(await page.isChecked('.step2 input[value="codex"]')).toBe(true);
    expect(await page.getAttribute(".step2 button[type=submit]", "aria-disabled")).not.toBe("true");
    expect(await page.locator(".step2 button[type=submit]").innerText()).toBe("Send");
    await page.click(".step2 button.link");
    await done(page);
    expect(posted).toHaveLength(2); // the email once, the failed answers once
    await close();
  });

  test("by keyboard, the success line and the thanks line show a focus ring when they take focus", async () => {
    const { page, close } = await withForm();
    const ring = () => page.evaluate(() => { const s = getComputedStyle(document.activeElement!); return `${s.outlineStyle} ${s.outlineWidth}`; });
    await page.focus("#email");
    await page.keyboard.type("ana@example.com");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "in");
    expect([await page.evaluate(() => document.activeElement!.className), await ring()]).toEqual(["done", "solid 2px"]);
    await page.focus(".step2 button.link");
    await page.keyboard.press("Enter");
    await done(page);
    expect([await page.evaluate(() => document.activeElement!.className), await ring()]).toEqual(["thanks", "solid 2px"]);
    await close();
  });

  test("retry after a failed send: Skip and Send stay where they are while it sends", async () => {
    const { page, hold, release, close } = await joined((n) => (n === 2 ? "abort" : "ok"));
    const top = () => page.evaluate(() => Math.round(document.querySelector(".step2 .row.end")!.getBoundingClientRect().top + scrollY));
    await page.check('.step2 input[name="team_size"][value="2-5"]');
    await page.click(".step2 button[type=submit]");
    await page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "answer-error");
    const before = await top();
    hold();
    await page.click(".step2 button[type=submit]");
    await page.waitForFunction(() => document.querySelector("#waitlist .card")!.getAttribute("data-state") === "answering");
    expect(await top()).toBe(before);
    release();
    await done(page);
    await close();
  });
});
