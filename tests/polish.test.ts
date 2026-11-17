// XMU-814 polish: break-ui and accessibility checks on the brand v1 page. Each test was
// written failing first. Same harness idea as page.test.ts: serve the site with the vercel.json
// headers (CSP enforced) and drive real Chromium.
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark", ...opts });
  // The page posts to the real waitlist form: never let a test sign up for real.
  await context.route("https://formspree.io/**", (route) => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(2000);
  await page.goto(`${base}/`);
  return { page, close: () => context.close() };
}

// Shows step 2 of the waitlist card without a network, so its options can be measured.
const showStep2 = (page: Page) =>
  page.evaluate(() => {
    document.querySelector<HTMLElement>(".step2")!.hidden = false;
  });

// WCAG contrast ratio of two CSS rgb() colours.
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = c.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("design-review", () => {
  test("hover styles only apply on devices that can hover (no stuck hover after a tap)", async () => {
    const { page, close } = await open();
    const ungated = await page.evaluate(() => {
      const out: string[] = [];
      const walk = (rules: CSSRuleList, hoverMedia: boolean) => {
        for (const rule of rules) {
          if (rule instanceof CSSMediaRule) walk(rule.cssRules, hoverMedia || /\(hover:\s*hover\)/.test(rule.conditionText));
          else if (rule instanceof CSSStyleRule && rule.selectorText.includes(":hover") && !hoverMedia) out.push(rule.selectorText);
        }
      };
      for (const sheet of document.styleSheets) walk(sheet.cssRules, false);
      return out;
    });
    expect(ungated).toEqual([]);
    await close();
  });

  test("headings wrap long words without automatic hyphens", async () => {
    const { page, close } = await open();
    const seen = await page.locator("h1, h2").evaluateAll((hs) => [...new Set(hs.map((h) => getComputedStyle(h).hyphens))]);
    expect(seen).toEqual(["manual"]);
    await close();
  });
});

describe("a11y", () => {
  for (const width of [1440, 375]) {
    test(`every link, button and option is at least 44px tall (${width}px)`, async () => {
      const { page, close } = await open({ viewport: { width, height: 800 } });
      await showStep2(page);
      const short = await page.evaluate(() =>
        [...document.querySelectorAll("a, button, .opts label")]
          .filter((el) => !el.closest(".proof") && el.getClientRects().length > 0) // the inline "Source" link sits in a sentence
          .map((el) => [el.className || el.tagName, el.getBoundingClientRect().height] as const)
          .filter(([, h]) => h < 44),
      );
      expect(short).toEqual([]);
      await close();
    });
  }

  // Mock v41: 20px between the last question and Skip/Send until a message needs the room.
  test("step 2 keeps a 20px gap above Skip and Send until a message shows", async () => {
    const { page, close } = await open({ viewport: { width: 375, height: 812 } });
    await showStep2(page);
    const gap = () => page.evaluate(() => {
      const sets = document.querySelectorAll(".step2 fieldset");
      return Math.round(document.querySelector(".step2 .row.end")!.getBoundingClientRect().top - sets[sets.length - 1].getBoundingClientRect().bottom);
    });
    expect(await gap()).toBe(20);
    await page.evaluate(() => { document.querySelector("#answers-msg")!.textContent = "That didn’t go through. Try again."; });
    expect(await gap()).toBeGreaterThanOrEqual(40);
    await close();
  });

  for (const width of [320, 360, 375, 414]) {
    test(`the English button and link labels keep to one line (${width}px)`, async () => {
      const { page, close } = await open({ viewport: { width, height: 800 } });
      await showStep2(page);
      const lines = await page.locator("button, a").evaluateAll((els) =>
        els.filter((el) => el.getClientRects().length > 0).flatMap((el) => {
          const text = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent!.trim());
          if (!text) return []; // logo and icon-only controls have no text to wrap
          const range = document.createRange();
          range.selectNodeContents(text);
          return [[el.textContent!.trim(), new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size]];
        }),
      );
      for (const [label, n] of lines) expect([label, n]).toEqual([label, 1]);
      await close();
    });
  }

  // WCAG 2.2.2: anything that blinks or moves on its own must stop within about 5 seconds.
  test("nothing on the page moves forever: the caret and the working dots stop", async () => {
    const { page, close } = await open({ viewport: { width: 1440, height: 900 } });
    await page.waitForTimeout(300);
    const ends = await page.evaluate(() =>
      // Time-based animations only: the How it works rows (XMU-817) follow the scroll, not the clock.
      document.getAnimations().filter((a) => a.timeline instanceof DocumentTimeline).map((a) => Number(a.effect!.getComputedTiming().endTime)),
    );
    expect(ends.length).toBeGreaterThan(0);
    expect(ends.filter((t) => !Number.isFinite(t))).toEqual([]);
    expect(Math.max(...ends)).toBeLessThanOrEqual(9000);
    await close();
  });

  // XMU-833: the panes show each CLI's own progress line now, so the window's only dots are the
  // invite card's (the per-row "working dots" and their start-with-the-row test went with the old panes).
  // At rest they match reduced motion and print: full brightness.
  test("the invite card's dots don't jump in brightness when they start or stop, and rest at full brightness", async () => {
    const { page, close } = await open({ viewport: { width: 1440, height: 900 } });
    expect(await page.locator(".iv-dots i").count()).toBeGreaterThan(0);
    const jumps = await page.evaluate(() => [...document.querySelectorAll(".iv-dots i")].flatMap((dot, i) => dot.getAnimations().flatMap((a) => {
      const { delay } = a.effect!.getTiming();
      const end = Number(a.effect!.getComputedTiming().endTime);
      a.pause();
      const at = (t: number) => { a.currentTime = t; return parseFloat(getComputedStyle(dot).opacity); };
      const start = Math.abs(at(Number(delay) - 1) - at(Number(delay) + 1));
      const stop = Math.abs(at(end - 1) - at(end + 1));
      const rest = at(end + 1);
      return start > 0.05 || stop > 0.05 || rest < 0.99 ? [`dot ${i}: start ${start.toFixed(2)}, stop ${stop.toFixed(2)}, rest ${rest}`] : [];
    })));
    expect(jumps).toEqual([]);
    await close();
  });

  test("on a phone every button label sits in the middle of its button (375px)", async () => {
    const { page, close } = await open({ viewport: { width: 375, height: 812 } });
    const gaps = await page.locator(".btn").evaluateAll((btns) =>
      btns.filter((b) => b.getClientRects().length > 0).map((b) => {
        const range = document.createRange();
        range.selectNodeContents(b);
        const t = range.getBoundingClientRect();
        const r = b.getBoundingClientRect();
        return { label: b.textContent!.trim(), top: t.top - r.top, bottom: r.bottom - t.bottom };
      }),
    );
    expect(gaps.length).toBeGreaterThan(0);
    // within 1px: Inter's glyph box sits half a pixel high in its line, which no one can see
    for (const g of gaps) expect([g.label, Math.abs(g.top - g.bottom) <= 1]).toEqual([g.label, true]);
    await close();
  });

  test("the focus ring on an option goes round the whole pill", async () => {
    const { page, close } = await open();
    await showStep2(page);
    await page.locator(".step2 .done").evaluate((el) => (el as HTMLElement).focus());
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const input = document.activeElement as HTMLInputElement;
      const label = input.closest("label")!;
      const l = getComputedStyle(label);
      return { input: input.value, inputOutline: getComputedStyle(input).outlineStyle, style: l.outlineStyle, width: l.outlineWidth, offset: l.outlineOffset };
    });
    expect(ring).toEqual({ input: "2-5", inputOutline: "none", style: "solid", width: "2px", offset: "2px" });
    await close();
  });

  for (const theme of ["dark", "light"]) {
    test(`form control borders have at least 3:1 contrast against the card and their fill (${theme})`, async () => {
      const { page, close } = await open();
      if (theme === "light") await page.click(".nav .theme");
      await showStep2(page);
      const pairs = await page.evaluate(() => {
        const card = getComputedStyle(document.querySelector(".card")!).backgroundColor;
        return ["#email", ".opts label"].map((sel) => {
          const cs = getComputedStyle(document.querySelector(sel)!);
          return { sel, border: cs.borderTopColor, fill: cs.backgroundColor, card };
        });
      });
      for (const p of pairs) {
        expect([p.sel, contrast(p.border, p.card) >= 3, contrast(p.border, p.fill) >= 3]).toEqual([p.sel, true, true]);
      }
      await close();
    });
  }
});

describe("break-ui", () => {
  for (const width of [1440, 1280, 1024, 768, 375, 320]) {
    test(`no sideways scroll at ${width}px`, async () => {
      const { page, close } = await open({ viewport: { width, height: 800 } });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await close();
    });
  }

  const WORD = "x".repeat(60);
  for (const width of [320, 375, 768, 1440]) {
    test(`a 60-character word in the headings, the hero line, the buttons and an option stays inside the page (${width}px)`, async () => {
      const { page, close } = await open({ viewport: { width, height: 800 } });
      await showStep2(page);
      const sels = ["h1", "#top .sub", "#pain h2", "#drive h2", "#context h2", "#waitlist h2", ".nav .btn", "#top .actions .btn", ".step1 .btn", ".step2 .btn", ".opts label"];
      const out = await page.evaluate(
        ([w, sels]) => {
          for (const sel of sels) {
            const el = document.querySelector(sel)!;
            const texts = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
            texts.sort((a, b) => b.textContent!.length - a.textContent!.length)[0].textContent = w;
          }
          return sels
            .map((sel) => {
              const el = document.querySelector(sel)!;
              const range = document.createRange();
              range.selectNodeContents(el);
              return [sel, Math.ceil(Math.max(el.getBoundingClientRect().right, range.getBoundingClientRect().right))] as const;
            })
            .filter(([, right]) => right > window.innerWidth);
        },
        [WORD, sels] as const,
      );
      expect(out).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await close();
    });
  }

  test("phone notch: the page gutters include the safe-area insets", () => {
    const css = readFileSync(join(SITE, "styles.css"), "utf8");
    const gutter = css.match(/main > section, \.pair \{[^}]*\}/)![0];
    expect(gutter).toContain("env(safe-area-inset-left, 0px)");
    expect(gutter).toContain("env(safe-area-inset-right, 0px)");
    for (const rule of [/\.nav \{[^}]*\}/, /\.foot \{[^}]*\}/]) {
      const r = css.match(rule)![0];
      expect(r).toContain("safe-area-inset-left");
      expect(r).toContain("safe-area-inset-right");
    }
  });
});

describe("Windows high contrast (forced colors)", () => {
  test("buttons and fields keep a visible border", async () => {
    const { page, close } = await open({ forcedColors: "active" });
    await showStep2(page);
    const borders = await page.locator(".btn, #email, .opts label").evaluateAll((els) =>
      els.filter((e) => e.getClientRects().length > 0).map((e) => [e.className || e.id, getComputedStyle(e).borderTopWidth, getComputedStyle(e).borderTopStyle]),
    );
    expect(borders.length).toBeGreaterThan(5);
    for (const [name, w, style] of borders) expect([name, parseFloat(w) >= 1, style]).toEqual([name, true, "solid"]);
    await close();
  });
});

describe("print", () => {
  test("printing leaves out the waitlist card, the theme button and the waitlist buttons", async () => {
    const { page, close } = await open();
    await page.emulateMedia({ media: "print" });
    for (const sel of ["#waitlist .card", ".nav .theme", ".nav .btn", "#top .actions .btn:not(.ghost)", '#top .actions a[href="#demo"]']) {
      expect([sel, await page.locator(sel).isVisible()]).toEqual([sel, false]);
    }
    await close();
  });

  test("printing keeps the product window on one page", async () => {
    const { page, close } = await open();
    await page.emulateMedia({ media: "print" });
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("figure.tm")!).breakInside)).toBe("avoid");
    await close();
  });

  // Paper can't animate: printing early, or from a phone where two panes were hidden, still shows the finished window.
  test("printing shows the finished product window, even right after load on a phone", async () => {
    const { page, close } = await open({ viewport: { width: 390, height: 844 } });
    await page.emulateMedia({ media: "print" });
    await page.setViewportSize({ width: 800, height: 1100 });
    const unfinished = await page.locator(".tm *").evaluateAll((els) =>
      els.filter((el) => el.getClientRects().length > 0).flatMap((el) => {
        const s = getComputedStyle(el);
        return s.animationName === "none" && s.clipPath === "none" && s.opacity === "1" ? [] : [el.className];
      }));
    expect(unfinished).toEqual([]);
    await close();
  });

  // Chrome's default 1cm margins leave 718px on A4 and 740px on Letter, under the phone breakpoint.
  for (const width of [718, 740]) {
    test(`printing at ${width}px shows all three panes and every code line, not the phone window`, async () => {
      const { page, close } = await open({ viewport: { width: 1440, height: 900 } });
      await page.emulateMedia({ media: "print" });
      await page.setViewportSize({ width, height: 1000 });
      // every pane and every line of the finished window (the lines that give way to the work are not part of it)
      const hidden = await page.locator(".tm .pane, .tm .pane .cli p:not(.gone, .gone *)").evaluateAll((els) =>
        els.filter((el) => el.getClientRects().length === 0).map((el) => el.className || el.tagName));
      expect(hidden).toEqual([]);
      await close();
    });
  }

  // QA round 2 (XMU-833): on Letter the window ran 1025px tall, past the page, so it split across two pages and the
  // chat printed empty. Chrome's default 0.4in margins leave 718x1045 on A4 and 740x979 on Letter; the window, finished,
  // fits one page with every pane line and chat message whole inside its box, in portrait and landscape (QA round 3).
  for (const [paper, width, height] of [["A4", 718, 1045], ["Letter", 740, 979], ["Letter landscape", 979, 740], ["A4 landscape", 1045, 718]] as const) {
    test(`printing on ${paper} the whole window fits one page, no line cut by its box`, async () => {
      const { page, close } = await open({ viewport: { width: 1440, height: 900 } });
      await page.emulateMedia({ media: "print" });
      await page.setViewportSize({ width, height });
      const r = await page.evaluate(() => {
        const tm = document.querySelector("figure.tm")!;
        const cut = [...tm.querySelectorAll(".pane .cli > *, .pane .cli p, .feed li")].flatMap((el) => {
          if (!el.getClientRects().length || el.closest(".gone")) return [];
          const box = el.closest(".cli, .feed")!.getBoundingClientRect();
          const q = el.getBoundingClientRect();
          return q.height > 0 && (q.top < box.top - 0.5 || q.bottom > box.bottom + 0.5) ? [el.textContent!.trim().slice(0, 40)] : [];
        });
        return { height: Math.ceil(tm.getBoundingClientRect().height), cut };
      });
      expect(r.cut).toEqual([]);
      expect(r.height).toBeLessThanOrEqual(height - 16);
      await close();
    });
  }

  // Chrome prints without background graphics by default; the window keeps its dark fill so its light text stays readable,
  // and its outer shadow ring is dropped so no sliver of it lands on the page before.
  test("on paper the window keeps its dark fill and drops its shadow", async () => {
    const { page, close } = await open({ viewport: { width: 1440, height: 900 } });
    await page.emulateMedia({ media: "print" });
    const tm = await page.locator("figure.tm").evaluate((el) => { const s = getComputedStyle(el); return [s.printColorAdjust, s.boxShadow]; });
    expect(tm).toEqual(["exact", "none"]);
    await close();
  });

  test("printing from the dark theme puts dark text on white paper", async () => {
    const { page, close } = await open();
    await page.emulateMedia({ media: "print" });
    const [bg, color] = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector("h1")!).color]);
    expect(bg).toBe("rgb(255, 255, 255)");
    expect(contrast(color, bg)).toBeGreaterThanOrEqual(4.5);
    await close();
  });
});
