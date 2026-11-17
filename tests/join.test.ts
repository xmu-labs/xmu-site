// XMU-829: the hero window opens with the invite and the team joining, as in the approved mock.
// Each test was written failing first. Same harness as polish.test.ts:
// serve the site with the vercel.json headers (CSP enforced) and drive real Chromium.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";

const SITE = join(import.meta.dir, "..");
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "no-preference", ...opts });
  // The page posts to the real waitlist form: never let a test sign up for real.
  await context.route("https://formspree.io/**", (route) => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(2000);
  await page.goto(`${base}/`);
  return { page, close: () => context.close() };
}

// Freezes the hero window at `ms` after the page loads: every clock-driven animation in it, paused there.
const at = (page: Page, ms: number) =>
  page.evaluate((t) => {
    for (const a of document.querySelector("#top figure")!.getAnimations({ subtree: true })) {
      if (!(a.timeline instanceof DocumentTimeline)) continue;
      a.pause();
      a.currentTime = t;
    }
  }, ms);

// How visible an element is: its own opacity times its ancestors', 0 when hidden or not rendered.
const seen = (page: Page, sel: string) =>
  page.$eval(sel, (el) => {
    if (!el.getClientRects().length || getComputedStyle(el).visibility === "hidden") return 0;
    let o = 1;
    for (let n: Element | null = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
    return Math.round(o * 100) / 100;
  });

// The bar count a visitor can read: the one step that is showing.
const count = async (page: Page) => {
  const steps = await page.$$eval("#top .cnt .step", (els) =>
    els.map((el) => ({ text: el.querySelector(".wide")!.textContent, vis: getComputedStyle(el).visibility !== "hidden" && el.getClientRects().length > 0 ? parseFloat(getComputedStyle(el).opacity) : 0 })),
  );
  return steps.filter((s) => s.vis > 0.5).map((s) => s.text);
};

describe("hero join", () => {
  // XMU-833: the approved copy is now the video's: refunds-hotfix, and the card names who it waits for
  test("the invite card reads the approved copy", async () => {
    const { page, close } = await open();
    const lines = await page.$$eval("#top .invite p", (ps) => ps.map((p) => p.textContent!.replace(/\s+/g, " ").trim()));
    expect(lines).toEqual(["Invite your team", "xmu.sh/s/refunds-hotfix Link copied", "A M Waiting for ana and mia M Waiting for mia"]);
    expect(await page.$$eval("#top .invite .iv-link span", (s) => s.map((x) => x.textContent))).toEqual(["xmu.sh/s/refunds-hotfix", "Link copied"]);
    await close();
  });

  test("the chat opens with who started and who joined, in order", async () => {
    const { page, close } = await open();
    const rows = await page.$$eval("#top .chat li.sys", (ls) => ls.map((l) => l.textContent!.replace(/\s+/g, " ").trim()));
    // XMU-833: ben also logs the invite, and his ask follows before anyone joins
    expect(rows).toEqual(["ben started the session 17:04", "ben invited ana and mia 17:04", "ana joined with Codex 17:05", "mia joined with Cursor 17:05"]);
    expect(await page.$$eval("#top .chat li", (ls) => ls.slice(0, 5).map((l) => l.classList.contains("sys")))).toEqual([true, true, false, true, true]);
    await close();
  });

  test("at 0.5s only ben is in: one person, the invite card waits, ana and mia aren't there yet", async () => {
    const { page, close } = await open();
    await at(page, 500);
    expect(await count(page)).toEqual(["1 person · 1 agent"]);
    expect(await seen(page, "#top .invite")).toBe(1);
    for (const sel of ["#top .pane.ana", "#top .pane.mia", "#top .who.ana", "#top .who.mia"]) expect([sel, await seen(page, sel)]).toEqual([sel, 0]);
    expect(await seen(page, "#top .pane.ben")).toBe(1);
    await close();
  });

  test("at 1.4s ana is in with Codex: two people, mia not yet", async () => {
    const { page, close } = await open();
    await at(page, 1400);
    expect(await count(page)).toEqual(["2 people · 2 agents"]);
    expect(await seen(page, "#top .pane.ana")).toBe(1);
    expect(await seen(page, "#top .who.ana")).toBe(1);
    expect(await seen(page, "#top .pane.mia")).toBe(0);
    expect(await seen(page, "#top .chat li.sys.ana")).toBe(1);
    expect(await seen(page, "#top .chat li.sys.mia")).toBe(0);
    await close();
  });

  test("at 2.2s everyone is in: three people, the invite card is gone", async () => {
    const { page, close } = await open();
    await at(page, 2200);
    expect(await count(page)).toEqual(["3 people · 3 agents"]);
    expect(await seen(page, "#top .invite")).toBe(0);
    for (const sel of ["#top .pane.ana", "#top .pane.mia", "#top .who.mia", "#top .chat li.sys.mia"]) expect([sel, await seen(page, sel)]).toEqual([sel, 1]);
    await close();
  });

  test("reduced motion shows the end state: no invite card, every pane, three people", async () => {
    const { page, close } = await open({ reducedMotion: "reduce" });
    expect(await seen(page, "#top .invite")).toBe(0);
    expect(await count(page)).toEqual(["3 people · 3 agents"]);
    for (const sel of ["#top .pane.ana", "#top .pane.mia", "#top .who.ana", "#top .who.mia", "#top .chat li.sys.mia"]) expect([sel, await seen(page, sel)]).toEqual([sel, 1]);
    await close();
  });

  test("print shows the end state too, with motion on", async () => {
    const { page, close } = await open();
    await page.emulateMedia({ media: "print" });
    expect(await seen(page, "#top .invite")).toBe(0);
    expect(await count(page)).toEqual(["3 people · 3 agents"]);
    for (const sel of ["#top .pane.ana", "#top .pane.mia"]) expect([sel, await seen(page, sel)]).toEqual([sel, 1]);
    await close();
  });

  for (const width of [1440, 1199, 1024]) {
    test(`${width} wide: the invite card stays inside the panes`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 } });
      for (const ms of [200, 600, 1200]) {
        await at(page, ms);
        const [card, panes] = await Promise.all(["#top .invite", "#top .panes"].map((s) => page.$eval(s, (el) => el.getBoundingClientRect().toJSON())));
        // the panes clip it while it slides, so what shows of it must sit inside them
        const clip = await page.$eval("#top .panes", (el) => getComputedStyle(el).overflow);
        expect(clip).toBe("hidden");
        expect(card.left).toBeGreaterThanOrEqual(panes.left - 1);
        expect(card.right).toBeLessThanOrEqual(panes.right + 1);
        expect(card.top).toBeGreaterThanOrEqual(panes.top - 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await close();
    });
  }

  for (const width of [760, 375, 320]) {
    test(`${width} wide: no invite card, the avatars and the chat carry the joins, nothing scrolls sideways`, async () => {
      const { page, close } = await open({ viewport: { width, height: 800 } });
      await at(page, 500);
      expect(await seen(page, "#top .invite")).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await at(page, 2200);
      // XMU-833: the phone bar has no count text any more; the three avatars carry who is in
      for (const sel of ["#top .who.ben", "#top .who.ana", "#top .who.mia", "#top .chat li.sys.mia"]) expect([sel, await seen(page, sel)]).toEqual([sel, 1]);
      await close();
    });
  }

  test("the invite card's waiting dots stop", async () => {
    const { page, close } = await open();
    const ends = await page.$$eval("#top .invite .iv-dots i", (dots) => dots.flatMap((d) => d.getAnimations().map((a) => Number(a.effect!.getComputedTiming().endTime))));
    expect(ends.length).toBe(6); // XMU-833: three for "Waiting for ana and mia", three for "Waiting for mia"
    for (const e of ends) expect(Number.isFinite(e)).toBe(true);
    await close();
  });
});

const rect = (page: Page, sel: string) => page.$eval(sel, (el) => el.getBoundingClientRect().toJSON());
const overlap = (a: DOMRect, b: DOMRect) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

describe("hero join, QA round 1", () => {
  // checked after the card's 0.15s entrance, so a card that fades in can't hide behind its fill
  test("reduced motion and print never show the invite card, even after it would have faded in", async () => {
    for (const media of ["reduce", "print"] as const) {
      const { page, close } = await open(media === "reduce" ? { reducedMotion: "reduce" } : {});
      if (media === "print") await page.emulateMedia({ media: "print" });
      await page.waitForTimeout(600);
      expect([media, await seen(page, "#top .invite")]).toEqual([media, 0]);
      await close();
    }
  });

  for (const width of [1199, 1100, 1024, 900, 761]) {
    test(`${width} wide: the invite card never covers ben's pane`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 } });
      for (const ms of [300, 800]) {
        await at(page, ms);
        expect([ms, overlap(await rect(page, "#top .invite"), await rect(page, "#top .pane.ben"))]).toEqual([ms, 0]);
      }
      await close();
    });
  }

  test("at 0.5s the chat only says ben started the session", async () => {
    const { page, close } = await open();
    await at(page, 500);
    expect(await seen(page, "#top .chat li.sys.ben")).toBe(1);
    for (const sel of ["#top .chat li.sys.ana", "#top .chat li.sys.mia"]) expect([sel, await seen(page, sel)]).toEqual([sel, 0]);
    await close();
  });

  // the panes that join cover the card: they need a solid fill, in forced colours too
  for (const forcedColors of ["none", "active"] as const) {
    test(`ana's and mia's panes have a solid background (forced colours ${forcedColors})`, async () => {
      const { page, close } = await open({ forcedColors });
      for (const sel of ["#top .pane.ana", "#top .pane.mia"]) {
        const bg = await page.$eval(sel, (el) => getComputedStyle(el).backgroundColor);
        expect([sel, /^rgba\(.*,\s*0\)$|transparent/.test(bg)]).toEqual([sel, false]);
      }
      await close();
    });
  }

  test("only one count is readable at any moment: the old one fades out before the new one fades in", async () => {
    const { page, close } = await open();
    const both: number[] = [];
    for (let ms = 860; ms <= 2100; ms += 10) {
      await at(page, ms);
      const ops = await page.$$eval("#top .cnt .step", (els) => els.map((el) => (getComputedStyle(el).visibility === "hidden" ? 0 : parseFloat(getComputedStyle(el).opacity))));
      if (ops.filter((o) => o >= 0.1).length > 1) both.push(ms);
    }
    expect(both).toEqual([]);
    await close();
  });

  test("forced colours: the chat-row dots and the invite dots use the text colour, and 'Link copied' keeps an edge", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      const { page, close } = await open({ forcedColors: "active", colorScheme });
      await at(page, 500);
      const text = await page.$eval("#top .chat li.sys p", (el) => getComputedStyle(el).color);
      for (const sel of ["#top .chat .sys-dot", "#top .invite .iv-dots i"]) {
        const bgs = await page.$$eval(sel, (els) => els.map((el) => getComputedStyle(el).backgroundColor));
        for (const bg of bgs) expect([colorScheme, sel, bg]).toEqual([colorScheme, sel, text]);
      }
      expect(await page.$eval("#top .iv-copied", (el) => getComputedStyle(el).borderTopStyle)).toBe("solid");
      await close();
    }
  });
});

// QA round 1, finding 1: on a laptop most of the window starts below the fold, so the team
// joins once the window is on screen. Until then it holds at "waiting for teammates".
describe("hero join plays when the window is in view", () => {
  const counted = async (page: Page) => (await count(page)).join();

  test("1366x768: the window waits for teammates until it scrolls into view, then everyone joins", async () => {
    const { page, close } = await open({ viewport: { width: 1366, height: 768 } });
    await page.waitForTimeout(2500);
    expect(await counted(page)).toBe("1 person · 1 agent");
    expect(await seen(page, "#top .invite")).toBe(1);
    expect(await seen(page, "#top .chat li.sys.ben")).toBe(1);
    expect(await seen(page, "#top .pane.ana")).toBe(0);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(2600);
    expect(await counted(page)).toBe("3 people · 3 agents");
    for (const sel of ["#top .pane.ana", "#top .pane.mia"]) expect([sel, await seen(page, sel)]).toEqual([sel, 1]);
    expect(await seen(page, "#top .invite")).toBe(0);
    await close();
  }, 15000);

  // Codex on 7221a58: play() on a finished animation rewinds it, so the card and ben's chat row
  // would blink out and play again the moment the window scrolled into view.
  test("1366x768: what is already up while waiting stays up when the window scrolls into view", async () => {
    const { page, close } = await open({ viewport: { width: 1366, height: 768 } });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const vis = (el: Element) => { let o = 1; for (let n: Element | null = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
      const w = window as unknown as { low: Record<string, number> };
      w.low = { card: 1, ben: 1 };
      const t0 = performance.now();
      const tick = () => {
        w.low.card = Math.min(w.low.card, vis(document.querySelector("#top .invite")!));
        w.low.ben = Math.min(w.low.ben, vis(document.querySelector("#top .chat li.sys.ben")!));
        if (performance.now() - t0 < 700) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(800);
    const low = await page.evaluate(() => (window as unknown as { low: Record<string, number> }).low);
    expect(low.card).toBeGreaterThan(0.99);
    expect(low.ben).toBeGreaterThan(0.99);
    await close();
  });

  test("1920x1080: the window is on screen at load, so it plays straight away", async () => {
    const { page, close } = await open({ viewport: { width: 1920, height: 1080 } });
    await page.waitForTimeout(2500);
    expect(await counted(page)).toBe("3 people · 3 agents");
    await close();
  });

  // XMU-833: the phone window now has ben's whole Claude pane (the mock's 322px) with the chat under it, so on a
  // 390x844 screen 72% of the pane shows at load, under the 85% the join waits for: a short scroll plays it
  test("390x844 phone: the join waits until ben's pane is on screen, then plays", async () => {
    const { page, close } = await open({ viewport: { width: 390, height: 844 } });
    await page.waitForTimeout(1500);
    expect(await seen(page, "#top .who.mia")).toBe(0);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(2600);
    // no count on a phone; mia's avatar and chat line show she is in
    expect(await seen(page, "#top .who.mia")).toBe(1);
    expect(await seen(page, "#top .chat li.sys.mia")).toBe(1);
    await close();
  });

  test("without JavaScript it plays on load, as before", async () => {
    const { page, close } = await open({ viewport: { width: 1366, height: 768 }, javaScriptEnabled: false });
    await page.waitForTimeout(2500);
    expect(await counted(page)).toBe("3 people · 3 agents");
    await close();
  });

  test("reduced motion: the end state shows wherever the window is", async () => {
    const { page, close } = await open({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });
    await page.waitForTimeout(300);
    expect(await counted(page)).toBe("3 people · 3 agents");
    expect(await seen(page, "#top .pane.ana")).toBe(1);
    await close();
  });
});


describe("hero join: the invite card waits in ana's seat", () => {
  // The pick on 2026-10-23 ("In view + card up"): the card is centred on ana's row, so it sits
  // higher on a laptop, then moves down to mia's row as ana arrives. Measured on the card's text,
  // so the test doesn't care how the card is built.
  const card = (page: Page) =>
    page.$$eval("#top .invite p", (ps) => {
      const rs = ps.map((p) => p.getBoundingClientRect());
      const left = Math.min(...rs.map((r) => r.left)), right = Math.max(...rs.map((r) => r.right));
      const top = Math.min(...rs.map((r) => r.top)), bottom = Math.max(...rs.map((r) => r.bottom));
      return { left, right, top, bottom } as DOMRect;
    });
  const mid = (r: DOMRect) => (r.top + r.bottom) / 2;

  for (const width of [1920, 1440, 1200]) {
    test(`${width} wide: centred on ana's row while waiting, then on mia's row once ana is in`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 } });
      await at(page, 3000);
      const [ana, mia] = await Promise.all([rect(page, "#top .pane.ana"), rect(page, "#top .pane.mia")]);
      await at(page, 500);
      expect(Math.abs(mid(await card(page)) - mid(ana))).toBeLessThan(4);
      await at(page, 1300);
      const moved = await card(page);
      expect(Math.abs(mid(moved) - mid(mia))).toBeLessThan(4);
      expect(overlap(moved, ana)).toBe(0);
      await close();
    });
  }
});

// QA round 2 (XMU-829). While the window waits, CSS can
// drop and recreate its animations (a breakpoint, print, a reduced-motion switch); the release
// must survive that, and nothing may start on its own clock while it waits.
describe("hero join, QA round 2", () => {
  const counted = async (page: Page) => (await count(page)).join();
  const paused = (page: Page) =>
    page.evaluate(() => document.querySelector("#top .tm")!.getAnimations({ subtree: true }).filter((a) => a.playState === "paused").length);
  const errorsOf = (page: Page) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    return errors;
  };
  const scrollIn = (page: Page) => page.evaluate(() => document.querySelector("#top .panes")!.scrollIntoView({ block: "center" }));

  test("a phone rotated while the window waits still plays it through", async () => {
    const { page, close } = await open({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
    const errors = errorsOf(page);
    await page.waitForTimeout(1000);
    await page.setViewportSize({ width: 390, height: 844 });
    await scrollIn(page);
    await page.waitForTimeout(2600);
    expect(errors).toEqual([]);
    // XMU-833: no count on a phone; mia's avatar and chat line show she is in
    expect(await seen(page, "#top .who.mia")).toBe(1);
    expect(await seen(page, "#top .chat li.sys.mia")).toBe(1);
    expect(await paused(page)).toBe(0);
    await close();
  }, 15000);

  for (const [what, flip] of [
    ["print", async (page: Page) => { await page.emulateMedia({ media: "print" }); await page.waitForTimeout(100); await page.emulateMedia({ media: "screen" }); }],
    ["a reduced-motion switch", async (page: Page) => { await page.emulateMedia({ reducedMotion: "reduce" }); await page.waitForTimeout(100); await page.emulateMedia({ reducedMotion: "no-preference" }); }],
    ["narrowing to 700 and back", async (page: Page) => { await page.setViewportSize({ width: 700, height: 768 }); await page.waitForTimeout(100); await page.setViewportSize({ width: 1366, height: 768 }); }],
  ] as const) {
    test(`after ${what} while the window waits, it still plays through once on screen`, async () => {
      const { page, close } = await open({ viewport: { width: 1366, height: 768 } });
      const errors = errorsOf(page);
      await page.waitForTimeout(1000);
      await flip(page);
      await page.waitForTimeout(300);
      expect(await counted(page)).toBe("1 person · 1 agent");
      expect(await seen(page, "#top .pane.ana")).toBe(0);
      await scrollIn(page);
      await page.waitForTimeout(2600);
      expect(errors).toEqual([]);
      expect(await counted(page)).toBe("3 people · 3 agents");
      expect(await paused(page)).toBe(0);
      await close();
    }, 15000);
  }

  test("crossing 1199 while the window waits keeps the card in ana's seat", async () => {
    const { page, close } = await open();
    await page.waitForTimeout(1000);
    const before = await rect(page, "#top .invite");
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.waitForTimeout(200);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(800);
    expect(await seen(page, "#top .invite")).toBe(1);
    expect(Math.round((await rect(page, "#top .invite")).top)).toBe(Math.round(before.top));
    expect(await counted(page)).toBe("1 person · 1 agent");
    await close();
  });

  test("widening from a phone while the window waits doesn't start ana's and mia's panes", async () => {
    const { page, close } = await open({ viewport: { width: 700, height: 500 } });
    await page.waitForTimeout(1000);
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForTimeout(1500);
    expect(await seen(page, "#top .pane.ana")).toBe(0);
    expect(await seen(page, "#top .pane.mia")).toBe(0);
    expect(await counted(page)).toBe("1 person · 1 agent");
    await close();
  });

  test("the hero's 'Join the waitlist' scrolls past the window without starting it", async () => {
    const { page, close } = await open();
    await page.waitForTimeout(1000);
    await page.click("#top a.btn.lg");
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(1500);
    expect(await counted(page)).toBe("1 person · 1 agent");
    expect(await seen(page, "#top .pane.ana")).toBe(0);
    await close();
  }, 10000);

  test("on a load that waits, the card still rises in", async () => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: "dark", reducedMotion: "no-preference" });
    await context.addInitScript(() => {
      const w = window as unknown as { ops: number[] };
      w.ops = [];
      const tick = () => {
        const c = document.querySelector("#top .invite");
        if (c) w.ops.push(parseFloat(getComputedStyle(c).opacity));
        if (w.ops.length < 60) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await page.waitForTimeout(1200);
    const ops = await page.evaluate(() => (window as unknown as { ops: number[] }).ops);
    expect(ops.some((o) => o > 0.05 && o < 0.95)).toBe(true);
    expect(ops.at(-1)).toBe(1);
    await context.close();
  });

  test("a late hero.js doesn't rewind a window that has already played", async () => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: "dark", reducedMotion: "no-preference" });
    await context.route("**/hero.js", async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(2000);
    await page.goto(`${base}/`, { waitUntil: "commit" });
    await page.waitForTimeout(3500);
    expect(await counted(page)).toBe("3 people · 3 agents");
    await context.close();
  }, 10000);

  test("opened in a background tab, the window waits until the tab is shown", async () => {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark", reducedMotion: "no-preference" });
    await context.addInitScript(() => {
      const w = window as unknown as { tabHidden: boolean };
      w.tabHidden = true;
      Object.defineProperty(document, "hidden", { get: () => w.tabHidden });
      Object.defineProperty(document, "visibilityState", { get: () => (w.tabHidden ? "hidden" : "visible") });
    });
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await page.waitForTimeout(2500);
    expect(await counted(page)).toBe("1 person · 1 agent");
    await page.evaluate(() => {
      (window as unknown as { tabHidden: boolean }).tabHidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(2600);
    expect(await counted(page)).toBe("3 people · 3 agents");
    await context.close();
  }, 10000);

  // Codex on 7bd5e7b: a page loaded with reduced motion must not replay the join if motion is switched back on
  test("loaded with reduced motion, switching motion back on keeps the finished window", async () => {
    const { page, close } = await open({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });
    await page.waitForTimeout(500);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForTimeout(300);
    expect(await counted(page)).toBe("3 people · 3 agents");
    expect(await seen(page, "#top .pane.ana")).toBe(1);
    expect(await seen(page, "#top .invite")).toBe(0);
    await close();
  });

  // Codex on f916578: after the join has played, CSS can still recreate animations (the card and
  // the teammates' panes come back above 760px); they must rejoin the window's clock, not replay
  for (const [what, flip] of [
    ["narrowing to a phone and back", async (page: Page) => { await page.setViewportSize({ width: 700, height: 1080 }); await page.waitForTimeout(100); await page.setViewportSize({ width: 1920, height: 1080 }); }],
    ["a reduced-motion switch", async (page: Page) => { await page.emulateMedia({ reducedMotion: "reduce" }); await page.waitForTimeout(100); await page.emulateMedia({ reducedMotion: "no-preference" }); }],
  ] as const) {
    test(`after the join, ${what} doesn't replay it`, async () => {
      const { page, close } = await open({ viewport: { width: 1920, height: 1080 } });
      await page.waitForTimeout(2500);
      await flip(page);
      await page.waitForTimeout(300);
      expect(await counted(page)).toBe("3 people · 3 agents");
      expect(await seen(page, "#top .invite")).toBe(0);
      expect(await seen(page, "#top .pane.ana")).toBe(1);
      await close();
    });
  }

  // Codex on f916578: when the panes are taller than the screen, the release point (85% of the
  // screen) falls between the observer's 5% steps, so a scroll that stops just past it went unseen
  test("panes taller than the screen: stopping just past the release point plays the join", async () => {
    const { page, close } = await open({ viewport: { width: 1440, height: 400 } });
    await page.waitForTimeout(1000);
    const showing = (ratio: number) =>
      page.evaluate((r) => {
        const el = document.querySelector("#top .panes")!;
        const box = el.getBoundingClientRect();
        // put the panes' top where `r` of their height shows above the bottom of the screen
        scrollTo({ top: scrollY + box.top - (innerHeight - box.height * r), behavior: "instant" });
      }, ratio);
    const release = await page.evaluate(() => (0.85 * innerHeight) / document.querySelector("#top .panes")!.getBoundingClientRect().height);
    expect(release).toBeGreaterThan(0.7); // about 0.705, so the steps around it are 0.70 and 0.75
    await showing(release - 0.003);
    await page.waitForTimeout(400);
    expect(await counted(page)).toBe("1 person · 1 agent");
    await showing(release + 0.03); // past it, without crossing the next 5% step
    await page.waitForTimeout(2600);
    expect(await counted(page)).toBe("3 people · 3 agents");
    await close();
  }, 10000);

  test("with longer copy in ana's pane, the card still lands on mia's row", async () => {
    const { page, close } = await open();
    await page.evaluate(() => {
      document.querySelector("#top .pane.ana .cx-s")!.append(" und prüfe bitte auch, dass Teilerstattungen über dem Limit weiterhin abgelehnt werden");
    });
    await at(page, 3000);
    const mia = await rect(page, "#top .pane.mia");
    await at(page, 1300);
    const card = await page.$$eval("#top .invite p", (ps) => {
      const rs = ps.map((p) => p.getBoundingClientRect());
      return { top: Math.min(...rs.map((r) => r.top)), bottom: Math.max(...rs.map((r) => r.bottom)) };
    });
    expect(Math.abs((card.top + card.bottom) / 2 - (mia.top + mia.bottom) / 2)).toBeLessThan(4);
    await close();
  });
});

describe("hero join, QA round 3", () => {
  const counted = async (page: Page) => (await count(page)).join();
  const running = (page: Page) =>
    page.evaluate(() => document.querySelector("#top .tm")!.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length);
  const scrollIn = (page: Page) => page.evaluate(() => document.querySelector("#top .panes")!.scrollIntoView({ block: "center" }));

  test("on screen at 600ms but gone before it settles: the window still waits", async () => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: "dark", reducedMotion: "no-preference" });
    // scroll the window in 500ms after it starts and out again at 650ms, before the 200ms settle ends
    // (timed from its first frame, since the hold stops its own clock at 600ms)
    await context.addInitScript(() => {
      const w = window as unknown as { wentIn?: boolean; wentOut?: boolean; t0?: number };
      const tick = () => {
        const a = document.querySelector("#top .tm")?.getAnimations({ subtree: true })[0];
        if (w.t0 === undefined && a && a.startTime !== null) w.t0 = Number(a.startTime);
        const t = w.t0 === undefined ? -1 : Number(document.timeline.currentTime) - w.t0;
        if (t >= 500 && !w.wentIn) { w.wentIn = true; document.querySelector("#top .panes")!.scrollIntoView({ block: "center", behavior: "instant" }); }
        if (t >= 650 && !w.wentOut) { w.wentOut = true; scrollTo({ top: 0, behavior: "instant" }); }
        if (!w.wentOut) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await page.waitForTimeout(3000);
    expect(await page.evaluate(() => (window as unknown as { wentOut?: boolean }).wentOut)).toBe(true);
    expect(await counted(page)).toBe("1 person · 1 agent");
    expect(await seen(page, "#top .pane.ana")).toBe(0);
    await context.close();
  }, 10000);

  test("a late first frame doesn't make a later resize jump the window ahead", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", reducedMotion: "no-preference", isMobile: true, hasTouch: true });
    // hero.js runs as soon as the stylesheet arrives, but the window's first frame comes later
    await context.route("**/styles.css", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`${base}/`, { waitUntil: "commit" });
    await page.waitForFunction(() => {
      const a = document.querySelector("#top .tm")?.getAnimations({ subtree: true })[0];
      return a && a.startTime !== null && Number(a.currentTime) >= 300;
    }, null, { polling: "raf" });
    // when the window really started: its first frame (writing currentTime later moves startTime)
    const started = await page.evaluate(() => Number(document.querySelector("#top .tm")!.getAnimations({ subtree: true })[0].startTime));
    await page.setViewportSize({ width: 390, height: 804 }); // the URL bar collapsing
    await page.waitForTimeout(100);
    const drift = await page.evaluate((t0) => {
      const real = Number(document.timeline.currentTime) - t0;
      return Math.max(...document.querySelector("#top .tm")!.getAnimations({ subtree: true }).map((a) => Math.abs(Number(a.currentTime) - real)));
    }, started);
    expect(drift).toBeLessThan(100);
    await context.close();
  }, 15000);

  test("while the window waits, nothing in it runs, its carets and dots included", async () => {
    const { page, close } = await open({ viewport: { width: 1366, height: 768 } });
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => document.querySelector("#top .tm")!.getAnimations({ subtree: true }).some((a) => (a.effect as KeyframeEffect).pseudoElement))).toBe(true);
    expect(await running(page)).toBe(0);
    await close();
  });

  test("printing while the window waits keeps the invite card up", async () => {
    const { page, close } = await open({ viewport: { width: 1366, height: 768 } });
    await page.waitForTimeout(1000);
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(150);
    await page.emulateMedia({ media: "screen" });
    await page.waitForTimeout(150);
    expect(await seen(page, "#top .invite")).toBe(1);
    expect(await counted(page)).toBe("1 person · 1 agent");
    await close();
  });

  test("a resize just after the release keeps the window where it is", async () => {
    const { page, close } = await open({ viewport: { width: 1366, height: 768 } });
    await page.waitForTimeout(2500);
    await scrollIn(page);
    await page.waitForFunction(() => !document.querySelector("#top .tm")!.classList.contains("held"));
    await page.waitForTimeout(50); // just into the join: ana arrives 300ms after the release, mia 1.1s after
    await page.setViewportSize({ width: 1365, height: 768 });
    await page.waitForTimeout(100);
    expect(await seen(page, "#top .pane.mia")).toBe(0);
    expect(await counted(page)).toBe("1 person · 1 agent");
    await close();
  }, 10000);

  test("resized to a short screen while waiting: stopping just past the new release point plays the join", async () => {
    const { page, close } = await open({ viewport: { width: 1440, height: 900 } });
    await page.waitForTimeout(1000);
    await page.setViewportSize({ width: 1440, height: 400 });
    await page.waitForTimeout(200);
    const showing = (ratio: number) =>
      page.evaluate((r) => {
        const box = document.querySelector("#top .panes")!.getBoundingClientRect();
        scrollTo({ top: scrollY + box.top - (innerHeight - box.height * r), behavior: "instant" });
      }, ratio);
    const release = await page.evaluate(() => (0.85 * innerHeight) / document.querySelector("#top .panes")!.getBoundingClientRect().height);
    expect(release + 0.03).toBeLessThan(Math.ceil(release * 20) / 20); // the next 5% step is further than that
    await showing(release - 0.003);
    await page.waitForTimeout(400);
    expect(await counted(page)).toBe("1 person · 1 agent");
    await showing(release + 0.03);
    await page.waitForTimeout(2600);
    expect(await counted(page)).toBe("3 people · 3 agents");
    await close();
  }, 10000);

  // QA round 4
  test("a resize before the first frame doesn't cancel the wait", async () => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: "dark", reducedMotion: "no-preference" });
    await context.route("**/styles.css", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await context.addInitScript(() => document.addEventListener("DOMContentLoaded", () => dispatchEvent(new Event("resize"))));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/`, { waitUntil: "commit" });
    await page.waitForTimeout(4500);
    expect(await counted(page)).toBe("1 person · 1 agent");
    expect(await seen(page, "#top .pane.ana")).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  }, 15000);

  test("a first animation cancelled before its first frame: no error, and the window still waits", async () => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: "dark", reducedMotion: "no-preference" });
    await context.addInitScript(() =>
      document.addEventListener("DOMContentLoaded", () => document.querySelector("#top .tm")!.getAnimations({ subtree: true })[0].cancel()),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/`);
    await page.waitForTimeout(2500);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.querySelector("#top .tm")!.classList.contains("held"))).toBe(true);
    expect(await counted(page)).toBe("1 person · 1 agent");
    await context.close();
  }, 10000);

  // QA round 5
  test("print on and off before the first frame: the window still waits", async () => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: "dark", reducedMotion: "no-preference" });
    const page = await context.newPage();
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(50);
    await page.emulateMedia({ media: "screen" });
    await page.waitForTimeout(2500);
    expect(await counted(page)).toBe("1 person · 1 agent");
    expect(await seen(page, "#top .pane.ana")).toBe(0);
    await context.close();
  }, 10000);

  test("animations that start a few frames late still run on the window's clock", async () => {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark", reducedMotion: "no-preference" });
    // a slow CPU can start the window's animations in two batches: hold some back by 250ms
    await context.addInitScript(() =>
      document.addEventListener("DOMContentLoaded", () => {
        for (const a of document.querySelector("#top .tm")!.getAnimations({ subtree: true }).slice(20)) a.currentTime = -250;
      }),
    );
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await page.waitForTimeout(400);
    const spread = await page.evaluate(() => {
      // a finished animation stops its clock at its end, so only the running ones count
      const ts = document.querySelector("#top .tm")!.getAnimations({ subtree: true }).filter((a) => a.playState === "running").map((a) => Number(a.currentTime));
      return Math.max(...ts) - Math.min(...ts);
    });
    expect(spread).toBeLessThan(50);
    await context.close();
  });

  // QA round 6
  test("a hold that comes late, after ana has started to join, lets the join play", async () => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: "dark", reducedMotion: "no-preference" });
    // block the main thread from 550ms to 950ms of the window's clock, so the hold's timer fires past ana's join at 0.9s
    await context.addInitScript(() =>
      document.addEventListener("DOMContentLoaded", () => {
        document.querySelector("#top .tm")!.getAnimations({ subtree: true })[0].ready.then((a) =>
          setTimeout(() => {
            const t = performance.now();
            while (performance.now() - t < 400);
          }, 550 - (Number(document.timeline.currentTime) - Number(a.startTime))), // on the window's clock
        );
      }),
    );
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await page.waitForTimeout(3000);
    expect(await counted(page)).toBe("3 people · 3 agents");
    await context.close();
  }, 10000);

  // QA round 7
  test("a late hold lets the join play even while another script keeps a frame pending", async () => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: "dark", reducedMotion: "no-preference" });
    // a requestAnimationFrame loop keeps a frame pending, so the window's clock stops with the main thread
    // while the join keeps moving on screen
    await context.addInitScript(() => {
      const tick = () => requestAnimationFrame(tick);
      tick();
      document.addEventListener("DOMContentLoaded", () => {
        document.querySelector("#top .tm")!.getAnimations({ subtree: true })[0].ready.then((a) =>
          setTimeout(() => {
            const t = performance.now();
            while (performance.now() - t < 400);
          }, 550 - (Number(document.timeline.currentTime) - Number(a.startTime))), // on the window's clock
        );
      });
    });
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await page.waitForTimeout(3000);
    expect(await counted(page)).toBe("3 people · 3 agents");
    await context.close();
  }, 10000);

  test("a tab shown just before its late hold still holds: the join has not been seen", async () => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: "dark", reducedMotion: "no-preference" });
    // hidden until the end of a stall that runs past ana's join, as when a background tab is shown and its
    // throttled timer fires right after
    await context.addInitScript(() => {
      let hidden = true;
      Object.defineProperty(document, "hidden", { get: () => hidden });
      Object.defineProperty(document, "visibilityState", { get: () => (hidden ? "hidden" : "visible") });
      document.addEventListener("DOMContentLoaded", () => {
        document.querySelector("#top .tm")!.getAnimations({ subtree: true })[0].ready.then((a) =>
          setTimeout(() => {
            const t = performance.now();
            while (performance.now() - t < 400);
            hidden = false;
            document.dispatchEvent(new Event("visibilitychange"));
          }, 550 - (Number(document.timeline.currentTime) - Number(a.startTime))), // on the window's clock
        );
      });
    });
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await page.waitForTimeout(3000);
    expect(await counted(page)).toBe("1 person · 1 agent");
    await context.close();
  }, 10000);

  // QA round 8
  test("switching tabs away and back during a stall doesn't rewind a join the visitor already saw", async () => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: "dark", reducedMotion: "no-preference" });
    // Chrome delivers both visibility events only when the stall ends, right before the late hold
    await context.addInitScript(() => {
      let hidden = false;
      Object.defineProperty(document, "hidden", { get: () => hidden });
      Object.defineProperty(document, "visibilityState", { get: () => (hidden ? "hidden" : "visible") });
      document.addEventListener("DOMContentLoaded", () => {
        document.querySelector("#top .tm")!.getAnimations({ subtree: true })[0].ready.then((a) =>
          setTimeout(() => {
            const t = performance.now();
            while (performance.now() - t < 400);
            hidden = true;
            document.dispatchEvent(new Event("visibilitychange"));
            hidden = false;
            document.dispatchEvent(new Event("visibilitychange"));
          }, 550 - (Number(document.timeline.currentTime) - Number(a.startTime))), // on the window's clock
        );
      });
    });
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await page.waitForTimeout(3000);
    expect(await counted(page)).toBe("3 people · 3 agents");
    await context.close();
  }, 10000);

  // QA round 9
  test("a tab hidden before the join and shown again later still holds", async () => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: "dark", reducedMotion: "no-preference" });
    await context.addInitScript(() => {
      let hidden = false;
      Object.defineProperty(document, "hidden", { get: () => hidden });
      Object.defineProperty(document, "visibilityState", { get: () => (hidden ? "hidden" : "visible") });
      const flip = (to: boolean) => {
        hidden = to;
        document.dispatchEvent(new Event("visibilitychange"));
      };
      document.addEventListener("DOMContentLoaded", () => {
        document.querySelector("#top .tm")!.getAnimations({ subtree: true })[0].ready.then((a) => {
          // on the window's clock, not from when this promise settles: a heavier page settles it later
          const late = Number(document.timeline.currentTime) - Number(a.startTime);
          setTimeout(() => flip(true), 250 - late);
          setTimeout(() => flip(false), 1000 - late);
        });
      });
    });
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await page.waitForTimeout(3000);
    expect(await counted(page)).toBe("1 person · 1 agent");
    expect(await page.locator("#top .tm.held").count()).toBe(1);
    await context.close();
  }, 10000);

  test("in a background tab a late hold still holds: nobody saw the join start", async () => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: "dark", reducedMotion: "no-preference" });
    // a hidden tab throttles timers to about once a second, so the hold's timer fires past ana's join
    await context.addInitScript(() => {
      Object.defineProperty(document, "hidden", { get: () => true });
      Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
      document.addEventListener("DOMContentLoaded", () => {
        document.querySelector("#top .tm")!.getAnimations({ subtree: true })[0].ready.then((a) =>
          setTimeout(() => {
            const t = performance.now();
            while (performance.now() - t < 400);
          }, 550 - (Number(document.timeline.currentTime) - Number(a.startTime))), // on the window's clock
        );
      });
    });
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await page.waitForTimeout(3000);
    expect(await counted(page)).toBe("1 person · 1 agent");
    await context.close();
  }, 10000);
});

