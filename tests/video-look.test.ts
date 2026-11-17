// XMU-833: the hero window and the How it works screens take the demo video's product look
// (the approved mock). Session refunds-hotfix, each pane in its agent's own CLI
// with an agent chip, and xmu's own bar at the bottom. Each test was written failing first.
// Same harness as join.test.ts: serve the site with the vercel.json headers (CSP enforced), real Chromium.
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

async function open(opts: BrowserContextOptions & { light?: boolean } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "no-preference", ...opts });
  // The page posts to the real waitlist form: never let a test sign up for real.
  await context.route("https://formspree.io/**", (route) => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(2000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (opts.light) await page.addInitScript(() => localStorage.setItem("xmu-theme", "light"));
  await page.goto(`${base}/`);
  await page.evaluate(() => document.fonts.ready);
  return { page, errors, close: () => context.close() };
}

// Freezes the hero window at `ms` on its clock: every clock-driven animation in it, paused there.
const at = (page: Page, ms: number) =>
  page.evaluate((t) => {
    for (const a of document.querySelector("#top figure")!.getAnimations({ subtree: true })) {
      if (!(a.timeline instanceof DocumentTimeline)) continue;
      a.pause();
      a.currentTime = t;
    }
  }, ms);

const frame = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))));

// `at`, right after a resize: hero.js puts the window back on its own clock a frame or more after the resize lands
// (later on a busy CI runner), undoing a freeze made before it. Freeze, then check over a few frames that it held.
async function atAfterResize(page: Page, ms: number) {
  const held = () =>
    page.evaluate((t) => document.querySelector("#top figure")!.getAnimations({ subtree: true })
      .every((a) => !(a.timeline instanceof DocumentTimeline) || Math.abs(Number(a.currentTime) - t) < 1), ms);
  for (let tries = 0; tries < 20; tries++) {
    await at(page, ms);
    let still = true;
    for (let f = 0; f < 3 && still; f++) {
      await frame(page);
      still = await held();
    }
    if (still) return;
  }
  throw new Error(`the window never held still at ${ms}ms`);
}

// How visible an element is: its own opacity times its ancestors', 0 when hidden or not rendered.
const seen = (page: Page, sel: string) =>
  page.$eval(sel, (el) => {
    if (!el.getClientRects().length) return 0;
    for (let n: Element | null = el; n; n = n.parentElement) if (getComputedStyle(n).visibility === "hidden") return 0;
    let o = 1;
    for (let n: Element | null = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
    return Math.round(o * 100) / 100;
  });

// The text a visitor can read inside `sel`: every rendered text node whose element shows at more than half opacity.
const readable = (page: Page, sel: string) =>
  page.$eval(sel, (root) => {
    const vis = (el: Element) => {
      if (!el.getClientRects().length) return false;
      let o = 1;
      for (let n: Element | null = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.visibility === "hidden" || cs.display === "none") return false;
        o *= parseFloat(cs.opacity);
      }
      return o > 0.5;
    };
    const out: string[] = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.parentElement && vis(n.parentElement)) out.push(n.textContent!);
    return out.join("").replace(/\s+/g, " ").trim();
  });

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const rect = (page: Page, sel: string): Promise<Box> => page.$eval(sel, (el) => el.getBoundingClientRect().toJSON());

describe("hero window: the video's product", () => {
  test("session refunds-hotfix in the bar and the invite link; the old session is gone", async () => {
    const { page, close } = await open();
    expect(await readable(page, "#top .tm-title")).toBe("xmu · refunds-hotfix");
    expect(await page.$$eval("#top .invite .iv-link span", (s) => s.map((x) => x.textContent))).toEqual(["xmu.sh/s/refunds-hotfix", "Link copied"]);
    expect(await page.$eval("#top", (el) => el.innerHTML)).not.toContain("checkout-v2");
    await close();
  });

  test("each pane opens with its person and an agent chip: ben in Claude, ana in Codex, mia (lead) in Cursor", async () => {
    const { page, close } = await open({ reducedMotion: "reduce" });
    for (const [who, agent, logo] of [["ben", "Claude", "lg-claude"], ["ana", "Codex", "lg-codex"], ["mia", "Cursor", "lg-cursor"]]) {
      expect(await readable(page, `#top .pane.${who} .ph .pt`)).toContain(`${who}`);
      expect(await readable(page, `#top .pane.${who} .ph .tag`)).toBe(agent);
      expect(await page.locator(`#top .pane.${who} .ph .tag svg.${logo}`).count()).toBe(1);
    }
    expect(await readable(page, "#top .pane.mia .ph .role")).toBe("lead");
    await close();
  });

  // QA round 2 (XMU-860): the narrow-phone rule that hid "help" made the bar read "xmu › invite · chat", two of three commands
  for (const width of [360, 320])
    test(`${width} wide: every xmu bar still reads invite · chat · help, on one line`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const bars = await page.$$eval(".xb", (els) =>
        els.filter((el) => !el.closest(".hx.pick")).map((el) => ({ text: (el as HTMLElement).innerText.replace(/\s+/g, " ").trim(), lines: el.querySelector(".xb-l")!.getClientRects().length })));
      expect(bars.length).toBeGreaterThanOrEqual(4);
      for (const b of bars) expect([b.text, b.lines]).toEqual(["xmu › invite · chat · help", 1]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await close();
    }, 60000);

  test("xmu's own bar runs along the bottom of the window: invite · chat · help, and nothing else", async () => {
    const { page, close } = await open({ reducedMotion: "reduce" });
    expect(await readable(page, "#top .xb .xb-p")).toBe("xmu ›");
    expect(await readable(page, "#top .xb .xb-l")).toBe("invite · chat · help");
    // XMU-860: no "shared" status label; the people count in the window bar already says who is in
    expect((await page.innerText("#top .xb")).replace(/\s+/g, " ").trim()).toBe("xmu › invite · chat · help");
    const [bar, fig, work] = await Promise.all(["#top .xb", "#top figure.tm", "#top .work"].map((s) => rect(page, s)));
    expect(Math.abs(fig.bottom - bar.bottom)).toBeLessThan(2);
    expect(bar.top).toBeGreaterThanOrEqual(work.bottom - 1);
    expect(await page.$eval("#top .xb", (el) => el.getAttribute("aria-hidden") === "true" || !!el.closest("[aria-hidden=true]"))).toBe(true);
    await close();
  });

  test("copy says Claude, never Claude Code, and no pane opens on a CLI welcome banner", async () => {
    expect(HTML).not.toMatch(/Claude Code/);
    const { page, close } = await open({ reducedMotion: "reduce" });
    for (const who of ["ben", "ana", "mia"]) {
      const t = await page.$eval(`#top .pane.${who}`, (el) => el.textContent!);
      expect([who, /welcome|tips for getting started|OpenAI Codex|Cursor Agent|\/help for help/i.test(t)]).toEqual([who, false]);
    }
    await close();
  });

  test("Claude's ✻ uses Claude's orange; nothing else in the window does", async () => {
    const { page, close } = await open({ reducedMotion: "reduce" });
    expect(await page.$eval("#top .pane.ben .cl-s .g-star", (el) => getComputedStyle(el).color)).toBe("rgb(217, 119, 87)");
    const others = await page.$$eval("#top figure *", (els) =>
      els.filter((el) => !el.matches(".g-star, .lg-claude, .lg-claude *") && getComputedStyle(el).color === "rgb(217, 119, 87)").map((el) => el.className),
    );
    expect(others).toEqual([]);
    await close();
  });
});

describe("hero window: waiting is not half empty", () => {
  test("at 0.6s ben's Claude is reading the logs after he ran xmu", async () => {
    const { page, close } = await open();
    await at(page, 600);
    const ben = await readable(page, "#top .pane.ben");
    for (const line of ["~/shop $ xmu", "> refunds are failing in prod. find out why", "Bash(tail -n 200 logs/prod.log)", "RefundLimitError", "312 errors since 16:52.", "Reading logs…", "? for shortcuts"])
      expect([line, ben.includes(line)]).toEqual([line, true]);
    expect(ben).not.toContain("Found it");
    await close();
  });

  test("at 0.6s the invite card sits in ana's seat and waits for ana and mia, with dashed A and M", async () => {
    const { page, close } = await open();
    await at(page, 3000);
    const ana = await rect(page, "#top .pane.ana"); // where her pane rests once she is in
    await at(page, 600);
    expect(await readable(page, "#top .invite .iv-h")).toBe("Invite your team");
    expect(await readable(page, "#top .invite .iv-link")).toBe("xmu.sh/s/refunds-hotfix Link copied");
    expect(await readable(page, "#top .invite .iv-wait")).toBe("A M Waiting for ana and mia");
    const card = await rect(page, "#top .invite .iv-card");
    expect(Math.abs((card.top + card.bottom) / 2 - (ana.top + ana.bottom) / 2)).toBeLessThan(4);
    const dashed = await page.$$eval("#top .invite .w1 .iv-who .av", (els) => els.map((el) => [el.textContent, getComputedStyle(el).borderTopStyle]));
    expect(dashed).toEqual([["A", "dashed"], ["M", "dashed"]]);
    await close();
  });

  test("at 0.6s the chat already says ben started, ben invited ana and mia, and his ask", async () => {
    const { page, close } = await open();
    await at(page, 600);
    expect(await readable(page, "#top .chat")).toBe(
      "Team chat ben started the session 17:04 ben invited ana and mia 17:04 B ben 17:04 Refunds are failing in prod since deploy 1.8.3. Can you both jump in?",
    );
    await close();
  });

  test("once ana is in, the card waits for mia only, in mia's seat", async () => {
    const { page, close } = await open();
    await at(page, 1300);
    expect(await readable(page, "#top .invite .iv-wait")).toBe("M Waiting for mia");
    expect(await page.$$eval("#top .invite .w2 .iv-who .av", (els) => els.map((el) => el.textContent))).toEqual(["M"]);
    await close();
  });

  test("ana's pane opens on her Codex chip and an empty Codex prompt as she joins", async () => {
    const { page, close } = await open();
    await at(page, 1300);
    expect(await readable(page, "#top .pane.ana")).toBe("A ana Codex › Ask Codex to do anything");
    await close();
  });

  test("mia's pane opens on her Cursor chip and an empty Cursor prompt as she joins", async () => {
    const { page, close } = await open();
    await at(page, 2100);
    expect(await readable(page, "#top .pane.mia")).toBe("M mia lead Cursor → Add a follow-up");
    await close();
  });

  test("the work starts at 2.2s: nothing before, ben's log gives way then", async () => {
    const { page, close } = await open();
    const first = await page.$$eval("#top figure [class]", (els) =>
      Math.min(...els.filter((el) => [...el.classList].some((c) => /^s\d+$/.test(c))).map((el) => parseFloat(getComputedStyle(el).getPropertyValue("--d")))),
    );
    expect(first).toBe(2.2);
    await at(page, 2150);
    expect(await readable(page, "#top .pane.ben")).toContain("Reading logs…");
    await at(page, 2600);
    const ben = await readable(page, "#top .pane.ben");
    expect(ben).not.toContain("Reading logs…");
    expect(ben).toContain("312 RefundLimitErrors since deploy 1.8.3");
    await close();
  });
});

describe("hero window: settled", () => {
  for (const [what, opts, wait] of [["reduced motion", { reducedMotion: "reduce" }, 0], ["with motion, after the join", { viewport: { width: 1920, height: 1080 } }, 6000]] as const) {
    test(`${what}: Claude found limit.ts:40 and ana is steering ben's Claude`, async () => {
      const { page, close } = await open(opts as BrowserContextOptions);
      if (wait) await page.waitForTimeout(wait);
      const ben = await readable(page, "#top .pane.ben");
      for (const line of [
        "ana is typing",
        "312 RefundLimitErrors since deploy 1.8.3",
        "Found it. limit.ts:40 compares cents to dollars.",
        "Update(src/refunds/limit.ts)",
        "if (amountCents > toCents(total))",
        "Editing limit.ts… (12s · esc to interrupt)",
        "ana> also fix partial refunds. same check in partial.ts",
      ]) expect([line, ben.includes(line)]).toEqual([line, true]);
      // XMU-860: "enter to send" is a tip for the typer only; everyone watches this shared screen. Only ben's own "? for shortcuts" hint is in the markup, and it has gone by now
      expect(await page.$$eval("#top .pane.ben .cl-hint", (els) => els.map((el) => el.textContent))).toEqual(["? for shortcuts"]);
      for (const gone of ["Reading logs…", "? for shortcuts", "17:03:51", "enter to send"]) expect([gone, ben.includes(gone)]).toEqual([gone, false]);
      expect(await readable(page, "#top .pane.ana")).toBe(
        "A ana Codex › what calls checkLimit? • full.ts:22 calls checkLimit. partial.ts:17 repeats the check › write a test for refunds in cents • Working (8s · esc to interrupt) › Ask Codex to do anything",
      );
      expect(await readable(page, "#top .pane.mia")).toBe(
        "M mia lead Cursor follow ben’s pane and flag risks Read src/refunds/limit.ts Grep checkLimit 2 matches Watching limit.ts… → Add a follow-up",
      );
      const chat = await readable(page, "#top .chat");
      expect(chat).toContain("ben’s Claude agent 17:07 Found it. limit.ts:40 compares cents to dollars, so every refund over $1 is rejected.");
      expect(chat).toMatch(/ana 17:08 @ben partial refunds use the same check\. I’m adding them to Claude’s fix\.$/);
      expect(await page.$eval("#top .pane.ben .steer", (el) => getComputedStyle(el).borderTopColor)).toBe("rgb(126, 200, 243)");
      await close();
    }, 15000);
  }

  // QA round 1: the steer prints into ben's prompt box in one step, as a terminal draws it, so it is the last beat to
  // start rather than the last to finish fading in (ana's "typing" pill rises over the next 240ms)
  test("with motion, the steer into ben's Claude is the last beat, and everything has landed by 5.5s", async () => {
    const { page, close } = await open();
    const timing = await page.evaluate(() =>
      document.querySelector("#top figure")!.getAnimations({ subtree: true })
        .filter((a) => (a as CSSAnimation).animationName !== "blink" && (a as CSSAnimation).animationName !== "wd")
        .map((a) => ({ start: Number(a.effect!.getTiming().delay), end: Number(a.effect!.getComputedTiming().endTime) })),
    );
    expect(Math.max(...timing.map((t) => t.end))).toBeLessThanOrEqual(5500);
    const steer = await page.$eval("#top .pane.ben .steer", (el) => Number(el.getAnimations()[0].effect!.getTiming().delay));
    expect(steer).toBe(Math.max(...timing.map((t) => t.start)));
    await close();
  });
});

// The mock's own check: nothing pokes out of its pane, the chat, the bars or the card.
const spills = (page: Page, boxes = "#top :is(.pane, .chat, .tm-bar, .xb, .invite)") =>
  page.evaluate((boxes) => {
    const out: string[] = [];
    const shows = (el: Element, stop: Element) => {
      for (let n: Element | null = el; n && n !== stop.parentElement; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.05) return false;
      }
      return el.getClientRects().length > 0;
    };
    for (const box of document.querySelectorAll(boxes)) {
      if (!shows(box, box)) continue;
      const r = box.getBoundingClientRect();
      for (const el of box.querySelectorAll("p, li, div, span, b")) {
        if (!shows(el, box)) continue;
        const e = el.getBoundingClientRect();
        if (e.width === 0) continue;
        // a line that fades out at the pane's edge (under 375px) is clipped on purpose
        const faded = (n: Element) => !!n.closest("p") && getComputedStyle(n.closest("p")!).maskImage !== "none";
        if (e.bottom > r.bottom + 0.5 || (!faded(el) && (e.right > r.right + 0.5 || (el.matches("p, li, .cl-in, .cu-in") && el.scrollWidth > el.clientWidth + 1))))
          out.push(`${box.className}: <${el.tagName.toLowerCase()} class="${el.className}"> "${el.textContent!.trim().slice(0, 40)}" by ${Math.round(Math.max(e.right - r.right, e.bottom - r.bottom))}px`);
      }
    }
    return [...new Set(out)];
  }, boxes);

describe("hero window: fit at every width", () => {
  for (const width of [1920, 1440, 1280, 1200, 1199, 1024, 1023, 768, 761, 760, 390, 375, 360, 340, 320]) {
    test(`${width}: nothing pokes out of a pane, the chat, a bar or the card, waiting or settled`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 } });
      for (const ms of [600, 1300, 8000]) {
        await at(page, ms);
        expect([ms, await spills(page)]).toEqual([ms, []]);
      }
      await close();
    });
  }

  for (const width of [1920, 1440, 1024, 768, 390]) {
    test(`${width}: every text in the window is 12px or larger, avatar initials aside`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const small = await page.$$eval("#top figure *", (els) =>
        els.filter((el) => el.getClientRects().length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()))
          .filter((el) => !el.matches(".pp, .av, .av *") && parseFloat(getComputedStyle(el).fontSize) < 12)
          .map((el) => `${el.className} ${getComputedStyle(el).fontSize}`),
      );
      expect(small).toEqual([]);
      await close();
    });
  }

  for (const width of [1440, 1024, 768, 390, 320]) {
    test(`${width}: the window is the same height waiting and settled`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 } });
      await at(page, 600);
      const waiting = (await rect(page, "#top figure.tm")).height;
      await at(page, 8000);
      expect((await rect(page, "#top figure.tm")).height).toBe(waiting);
      await close();
    });
  }

  for (const width of [375, 360, 340, 320]) {
    test(`${width}: the window bar and the xmu bar keep 6px to spare, nothing scrolls sideways`, async () => {
      const { page, close } = await open({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const room = await page.evaluate(() => {
        const r = (el: Element) => el.getBoundingClientRect();
        const last = (sel: string) => Math.max(...[...document.querySelectorAll(sel)].filter((el) => el.getClientRects().length).map((el) => r(el).right));
        const bar = r(document.querySelector("#top .tm-bar")!), xb = r(document.querySelector("#top .xb")!);
        const title = r(document.querySelector("#top .tm-title")!), here = r(document.querySelector("#top .here")!);
        return {
          bar: Math.round(bar.right - 12 - last("#top .tm-bar .here > *")) >= 0 && Math.round(here.left - title.right) >= 6,
          xb: Math.round(xb.right - 12 - last("#top .xb > *")) >= 0,
        };
      });
      expect({ width, ...room }).toEqual({ width, bar: true, xb: true });
      await close();
    });
  }
});

describe("hero window on a phone", () => {
  test("390: ben's pane only, the chat under it, xmu's bar at the bottom; no count text", async () => {
    const { page, close } = await open({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    expect(await seen(page, "#top .pane.ben")).toBe(1);
    for (const sel of ["#top .pane.ana", "#top .pane.mia", "#top .invite", "#top .cnt", "#top .live"]) expect([sel, await seen(page, sel)]).toEqual([sel, 0]);
    const [ben, chat, xb] = await Promise.all(["#top .pane.ben", "#top .chat", "#top .xb"].map((s) => rect(page, s)));
    expect(chat.top).toBeGreaterThanOrEqual(ben.bottom - 1);
    expect(xb.top).toBeGreaterThanOrEqual(chat.bottom - 1);
    expect(HTML).not.toContain("3 people, 3 agents, active");
    expect(await page.locator("#top .cnt .narrow").count()).toBe(0);
    // who is in shows as the avatars, each with its agent
    for (const who of ["ben", "ana", "mia"]) expect([who, await seen(page, `#top .who.${who} .pa`)]).toEqual([who, 1]);
    await close();
  });

  test("390: the chat keeps a fixed height, newest at the bottom, older lines fade under the top edge", async () => {
    const { page, close } = await open({ viewport: { width: 390, height: 844 } });
    await at(page, 600);
    const early = await rect(page, "#top .chat");
    await at(page, 8000);
    const late = await rect(page, "#top .chat");
    expect(late.height).toBe(early.height);
    const last = await rect(page, "#top .chat li:last-child");
    expect(last.bottom).toBeLessThanOrEqual(late.bottom);
    expect(last.bottom).toBeGreaterThan(late.bottom - 24);
    expect(await page.$eval("#top .chat .feed", (el) => getComputedStyle(el).maskImage)).toContain("linear-gradient");
    await close();
  });

  test("390, waiting: ben's pane reads the logs and the chat shows ben's ask", async () => {
    const { page, close } = await open({ viewport: { width: 390, height: 844 } });
    await at(page, 600);
    expect(await readable(page, "#top .pane.ben")).toContain("17:03:51 500 RefundLimitError");
    expect(await readable(page, "#top .chat")).toContain("Refunds are failing in prod since deploy 1.8.3. Can you both jump in?");
    await close();
  });
});

describe("hero window at tablet widths and in the light theme", () => {
  for (const width of [1199, 1024]) {
    test(`${width}: ben on top, ana and mia side by side below, the chat beside the panes`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const [ben, ana, mia, chat, panes] = await Promise.all([".pane.ben", ".pane.ana", ".pane.mia", ".chat", ".panes"].map((s) => rect(page, `#top ${s}`)));
      expect(ben.bottom).toBeLessThanOrEqual(ana.top + 1);
      expect(Math.abs(ana.top - mia.top)).toBeLessThan(1);
      expect(chat.left).toBeGreaterThanOrEqual(panes.right - 1);
      await close();
    });
  }

  test("900: the card waits in ana's seat, then moves to mia's seat as ana joins", async () => {
    const { page, close } = await open({ viewport: { width: 900, height: 900 } });
    await at(page, 3000);
    const [ana, mia] = await Promise.all([rect(page, "#top .pane.ana"), rect(page, "#top .pane.mia")]);
    const card = () => rect(page, "#top .invite .iv-card");
    const mid = (r: Box) => (r.left + r.right) / 2;
    await at(page, 600);
    expect(Math.abs(mid(await card()) - mid(ana))).toBeLessThan(4);
    await at(page, 1400);
    expect(Math.abs(mid(await card()) - mid(mia))).toBeLessThan(4);
    await close();
  });

  test("light theme: the window stays dark", async () => {
    const { page, close } = await open({ light: true, reducedMotion: "reduce" });
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    for (const sel of ["#top figure.tm", "#top .tm-bar", "#top .xb"]) {
      const bg = await page.$eval(sel, (el) => getComputedStyle(el).backgroundColor);
      expect([sel, bg]).toEqual([sel, sel === "#top figure.tm" ? "rgb(7, 16, 28)" : "rgb(15, 26, 43)"]);
    }
    await close();
  });
});

// How it works: the cards stay as they are; the four screens take the hero's look and story.
describe("how it works: four screens in the hero's look", () => {
  const row = (n: number) => `#how .hw-row:nth-child(${n})`;
  const SCREENS = "#how :is(.hw-shot.hx, .hx.own, .pane, .chat, .tm-bar, .xb, .pop, .own-body)";
  // a bar's items sit side by side with no space between them in the markup: read them as separate words
  const words = async (page: Page, sel: string) => (await page.innerText(sel)).replace(/\s+/g, " ").trim();

  test("the old checkout-v2 story is gone from the whole page", () => {
    expect(HTML).not.toContain("checkout-v2");
    expect(HTML).not.toContain("hw-tty");
  });

  // QA round 1: in Windows high contrast the ticks were filled with Canvas, so every box looked empty, and mia's focus row vanished
  for (const colorScheme of ["dark", "light"] as const)
  test(`forced colours, ${colorScheme}: ana's and mia's boxes read ticked, sam's empty, and mia's focus row keeps an edge`, async () => {
    const { page, close } = await open({ forcedColors: "active", colorScheme, reducedMotion: "reduce" });
    const pk = `${row(1)} .hw-shot .pk`;
    const look = await page.$$eval(`${pk} .pk-r`, (els) =>
      els.map((el) => {
        const box = getComputedStyle(el.querySelector(".box")!), tick = el.querySelector(".box svg");
        return { bg: box.backgroundColor, edge: box.borderTopColor, tick: tick ? getComputedStyle(tick).stroke : null, outline: getComputedStyle(el).outlineStyle };
      }),
    );
    const [ana, mia, sam] = look;
    // QA round 2: the brand-blue rule came later in the file and won, so the ticked boxes kept a brand colour here.
    // A ticked box is a solid block of the system text colour with the tick in the system background colour.
    const [text, canvas] = await page.$eval("body", (el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]);
    for (const ticked of [ana, mia]) expect([ticked.bg, ticked.edge, ticked.tick]).toEqual([text, text, canvas]);
    expect(sam.edge).toBe(text);
    expect(sam.bg).not.toBe(text);
    expect([ana.outline, mia.outline, sam.outline]).toEqual(["none", "solid", "none"]);
    await close();
  });

  // QA round 2: nothing held the empty box's edge or the focus row's edge; at --t-faint the empty box fell under 3:1
  test("step 1's list: sam's empty box has a --t-dim edge and mia's focus row an inset --t-line edge", async () => {
    const { page, close } = await open({ reducedMotion: "reduce" });
    const pk = `${row(1)} .hw-shot .pk`;
    expect(await page.$eval(`${pk} .pk-r.off .box`, (el) => getComputedStyle(el).borderTopColor)).toBe("rgb(140, 154, 178)");
    expect(await page.$eval(`${pk} .pk-r.focus`, (el) => getComputedStyle(el).boxShadow)).toBe("rgb(26, 47, 77) 0px 0px 0px 1px inset");
    await close();
  });

  // XMU-860: a reviewer could not tell what "private" meant, and "enter to send" is a tip for the typer only
  test("no private/shared status label and no enter-to-send tip anywhere, and their styles are gone", () => {
    const CSS = readFileSync(join(SITE, "styles.css"), "utf8");
    for (const gone of ["xb-st", "xb-r", "enter to send"]) expect([gone, HTML.includes(gone)]).toEqual([gone, false]);
    for (const gone of [".xb-st", ".xb-r"]) expect([gone, CSS.includes(gone)]).toEqual([gone, false]);
  });

  test("step 1: ben alone, Claude reading the logs, nobody else yet", async () => {
    const { page, close } = await open({ reducedMotion: "reduce" });
    const shot = `${row(1)} .hw-shot`;
    expect(await page.$eval(shot, (el) => el.className)).toContain("hx");
    expect(await words(page, `${shot} .tm-bar`)).toBe("xmu · refunds-hotfix B 1 person · 1 agent");
    // xmu's invite list has focus, so Claude's "? for shortcuts" tip under it is not drawn (QA round 2)
    expect(await words(page, `${shot} .pane.ben`)).toBe(
      "B ben Claude ~/shop $ xmu > refunds are failing in prod. find out why Bash(tail -n 200 logs/prod.log) 312 RefundLimitErrors since deploy 1.8.3 ✻ Reading logs… (9s · esc to interrupt) >",
    );
    expect(await page.locator(`${shot} .pane`).count()).toBe(1);
    await close();
  });

  // XMU-860: the page never showed how an invite is sent. Step 1 ends on ben typing invite with his team list open.
  for (const width of [1920, 1440, 1024, 768, 561, 560, 430, 390, 370, 360, 340, 320]) {
    test(`${width}: step 1 shows the invite action: ben types invite in xmu's bar and picks ana and mia`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const shot = `${row(1)} .hw-shot`;
      expect(await words(page, `${shot} .xb`)).toBe("xmu › invite");
      expect(await page.$eval(`${shot} .xb`, (el) => el.classList.contains("focus"))).toBe(true);
      expect(await page.locator(`${shot} .xb .cur.ben`).count()).toBe(1);
      const pk = `${shot} .pk`;
      expect(await words(page, `${pk} .pop-h`)).toBe("Invite to refunds-hotfix");
      const rows = await page.$$eval(`${pk} .pk-r`, (els) =>
        els.map((el) => [(el as HTMLElement).innerText.replace(/\s+/g, " ").trim(), !!el.querySelector(".box.y"), el.classList.contains("focus")]),
      );
      expect(rows).toEqual([["A ana", true, false], ["M mia lead", true, true], ["S sam", false, false]]);
      expect(await words(page, `${pk} .pop-f`)).toBe("space to select · enter to invite");
      // the footer hint fits on one line
      expect(await page.$eval(`${pk} .pop-f`, (el) => Math.round(el.getBoundingClientRect().height))).toBeLessThanOrEqual(34);
      // the list opens above the bar, inside the window, and nothing scrolls sideways
      const [box, bar, win] = await Promise.all([rect(page, pk), rect(page, `${shot} .xb`), rect(page, shot)]);
      expect(box.bottom).toBeLessThanOrEqual(bar.top);
      expect(box.left).toBeGreaterThanOrEqual(win.left);
      expect(box.right).toBeLessThanOrEqual(win.right);
      expect(box.top).toBeGreaterThanOrEqual(win.top);
      // QA round 1: on phones the list covered ben's name and his Claude chip; it opens below his pane's header, with room
      const head = await rect(page, `${shot} .pane.ben .ph`);
      expect(Math.round(box.top - head.bottom)).toBeGreaterThanOrEqual(6);
      // QA round 2: the list's top edge cut "~/shop $ xmu" in half. It opens over the transcript's first line, and no line
      // of ben's transcript is cut by the list's edge or by the bottom of his pane
      const lines = await page.$$eval(`${shot} .pane.ben .cl .cl-s > *`, (els) =>
        els.filter((el) => el.getClientRects().length).map((el) => { const r = el.getBoundingClientRect(); return { t: (el.textContent ?? "").slice(0, 16), top: r.top, bottom: r.bottom }; }),
      );
      const cl = await rect(page, `${shot} .pane.ben .cl`);
      expect(box.top).toBeLessThanOrEqual(lines[0].top + 0.5);
      // and its left edge sits left of where the lines start, so no sliver of their first letters shows beside it
      expect(box.left).toBeLessThanOrEqual(cl.left - 1);
      for (const l of lines) {
        expect([l.t, l.bottom <= box.top + 0.5 || l.top >= box.top - 0.5]).toEqual([l.t, true]);
        expect([l.t, l.bottom <= cl.bottom + 0.5]).toEqual([l.t, true]);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await close();
    });
  }

  test("step 2: the invite lands in ana's and mia's own terminals, each picking their agent", async () => {
    const { page, close } = await open({ reducedMotion: "reduce" });
    const shot = `${row(2)} .hw-shot`;
    for (const [who, pick] of [["ana", "Codex"], ["mia", "Cursor"]]) {
      const own = `${shot} .hx.own.${who}`;
      expect(await words(page, `${own} .tm-bar`)).toBe(`xmu · ${who}’s laptop ${who[0].toUpperCase()}`);
      expect(await words(page, `${own} .nt-h`)).toBe("B ben invited you to refunds-hotfix");
      expect(await page.$$eval(`${own} .nt-r`, (els) => els.map((el) => (el as HTMLElement).innerText.replace(/\s+/g, " ").trim()))).toEqual(
        ["Claude", "Codex", "Cursor", "Gemini CLI", ">_ Any CLI agent…"].map((name) => (name === pick ? `› ${name}` : name)),
      );
      expect(await words(page, `${own} .nt-r.sel`)).toBe(`› ${pick}`);
      // the Gemini CLI logo is a nominative mark like the others: hidden from screen readers, never focusable
      expect(await page.$eval(`${own} .nt-r:nth-child(4) svg`, (el) => [el.getAttribute("class"), el.getAttribute("aria-hidden"), el.getAttribute("focusable")])).toEqual(["mlogo lg-gemini", "true", "false"]);
      expect(await words(page, `${own} .glyph-cli`)).toBe(">_");
      expect(await words(page, `${own} .pop-f`)).toBe("↑↓ to choose · enter to join");
    }
    const [ana, mia] = await Promise.all([rect(page, `${shot} .hx.own.ana`), rect(page, `${shot} .hx.own.mia`)]);
    expect(mia.left).toBeGreaterThan(ana.right);
    expect(Math.abs(mia.top - ana.top)).toBeLessThan(1);
    await close();
  });

  test("step 3: ben's Claude beside ana's Codex, with mia's Cursor stacked under ana", async () => {
    const { page, close } = await open({ reducedMotion: "reduce" });
    const shot = `${row(3)} .hw-shot`;
    expect(await words(page, `${shot} .tm-bar`)).toBe("xmu · refunds-hotfix B A M 3 people · 3 agents");
    expect(await words(page, `${shot} .pane.ben .ph`)).toBe("B ben Claude A ana is typing");
    expect(await words(page, `${shot} .pane.ben .steer`)).toBe("A ana > also fix partial refunds. same check in partial.ts");
    expect(await words(page, `${shot} .pane.ana`)).toBe(
      "A ana Codex › write a test for refunds in cents • Edited limit.test.ts (+24 -0) • Running npm test › Ask Codex to do anything",
    );
    expect(await words(page, `${shot} .pane.mia`)).toBe(
      "M mia lead Cursor follow ben’s pane and flag risks Read src/refunds/limit.ts Grep checkLimit 2 matches Watching limit.ts… → Add a follow-up",
    );
    const [ben, ana, mia] = await Promise.all(["ben", "ana", "mia"].map((w) => rect(page, `${shot} .pane.${w}`)));
    expect(ana.left).toBeGreaterThanOrEqual(ben.right - 1);
    expect(mia.top).toBeGreaterThanOrEqual(ana.bottom - 1);
    expect(Math.abs(mia.left - ana.left)).toBeLessThan(1);
    expect(mia.bottom).toBeLessThanOrEqual(ben.bottom + 1);
    expect(await words(page, `${shot} .xb`)).toBe("xmu › invite · chat · help");
    // QA round 1: no tip line of any wording under ana's box
    expect(await page.locator(`${shot} .pane.ben .cl-hint`).count()).toBe(0);
    await close();
  });

  test("step 4: ben's Claude merges #218 and watches deploy 1.8.4, next to the chat history", async () => {
    const { page, close } = await open({ reducedMotion: "reduce" });
    const shot = `${row(4)} .hw-shot`;
    expect(await words(page, `${shot} .pane.ben`)).toBe(
      "B ben Claude > merge it and watch prod Bash(gh pr merge 218 --squash) ✓ #218 merged · Fix refund limit units Bash(tail -f logs/prod.log) ✓ deploy 1.8.4 live at 17:19 ✓ 0 refund errors since 17:19 Prod is clean. Refunds work again.",
    );
    expect(await words(page, `${shot} .chat`)).toBe(
      "ana’s Codex agent 17:11 Wrote limit.test.ts. It fails on main, and 4 of 4 pass on the fix. M mia lead 17:13 Looks right. Ship it. ben merged #218 Fix refund limit units 17:18",
    );
    expect(await words(page, `${shot} .xb`)).toBe("xmu › invite · chat · help");
    const [ben, chat] = await Promise.all([rect(page, `${shot} .pane.ben`), rect(page, `${shot} .chat`)]);
    expect(chat.left).toBeGreaterThanOrEqual(ben.right - 1);
    expect(Math.abs(chat.top - ben.top)).toBeLessThan(1);
    await close();
  });

  test("the screens use the hero window's colours and stay dark in the light theme", async () => {
    for (const light of [false, true]) {
      const { page, close } = await open({ light, reducedMotion: "reduce" });
      const bg = await page.$$eval("#how :is(.hw-shot.hx, .hx.own)", (els) => els.map((el) => getComputedStyle(el).backgroundColor));
      expect(new Set(bg)).toEqual(new Set(["rgb(7, 16, 28)"]));
      const bars = await page.$$eval("#how .tm-bar", (els) => els.map((el) => getComputedStyle(el).backgroundColor));
      expect(new Set(bars)).toEqual(new Set(["rgb(15, 26, 43)"]));
      expect(await page.$eval("#how .g-star", (el) => getComputedStyle(el).color)).toBe("rgb(217, 119, 87)");
      await close();
    }
  });

  for (const width of [560, 390, 320]) {
    test(`${width}: step 2 stacks mia's terminal under ana's; steps 3 and 4 show ben's pane alone`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const [ana, mia] = await Promise.all([rect(page, `${row(2)} .hx.own.ana`), rect(page, `${row(2)} .hx.own.mia`)]);
      expect(mia.top).toBeGreaterThanOrEqual(ana.bottom);
      for (const n of [3, 4]) {
        expect(await seen(page, `${row(n)} .pane.ben`)).toBe(1);
        for (const sel of [".pane.ana", ".pane.mia", ".chat"]) if (await page.locator(`${row(n)} ${sel}`).count()) expect([n, sel, await seen(page, `${row(n)} ${sel}`)]).toEqual([n, sel, 0]);
      }
      await close();
    });
  }

  for (const width of [1440, 1200, 1181, 1180, 1024, 768, 561, 560, 390, 375, 360, 320]) {
    test(`${width}: nothing pokes out of a screen, and no sideways scroll`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await spills(page, SCREENS)).toEqual([]);
      await close();
    });
  }

  for (const width of [1440, 1024, 390]) {
    test(`${width}: every text on the screens is 12px or larger, avatar initials and the >_ glyph aside`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const small = await page.$$eval("#how .hw-shot *", (els) =>
        els.filter((el) => el.getClientRects().length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()))
          .filter((el) => !el.matches(".pp, .av, .av *, .glyph-cli") && parseFloat(getComputedStyle(el).fontSize) < 12)
          .map((el) => `${el.className} ${getComputedStyle(el).fontSize}`),
      );
      expect(small).toEqual([]);
      await close();
    });
  }

  test("the screens hold still: no animation inside them, with motion allowed", async () => {
    const { page, close } = await open();
    expect(await page.$eval("#how", (el) => el.querySelectorAll(".hw-shot").length)).toBe(4);
    const moving = await page.$$eval("#how .hw-shot *", (els) => els.filter((el) => getComputedStyle(el).animationName !== "none").map((el) => el.className));
    expect(moving).toEqual([]);
    await close();
  });
});

// QA round 1 (fresh F2): ben's pane behaves like a terminal. When Claude's tool finishes, the live log
// collapses to its one-line summary in one step; one prompt box, ever; lines never sit on each other. On a
// phone the transcript is anchored to its bottom: older lines scroll up out of the top, the newest stays in view.
const transcript = (page: Page) =>
  page.evaluate(() => {
    const cl = document.querySelector("#top .pane.ben .cl")!;
    // the content box: on phones the top padding is the fade band, not a gap
    const box = cl.getBoundingClientRect();
    const clip = { top: box.top + parseFloat(getComputedStyle(cl).paddingTop), bottom: box.bottom };
    const fig = document.querySelector("#top figure")!;
    const shows = (el: Element) => {
      if (!el.getClientRects().length) return false;
      let o = 1;
      for (let n: Element | null = el; n && n !== fig.parentElement; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.visibility === "hidden" || cs.display === "none") return false;
        o *= parseFloat(cs.opacity);
      }
      return o > 0.05;
    };
    const lines = [...cl.querySelectorAll("p, .cl-in, .cl-diff")]
      .filter((el) => !el.matches(".cl-diff p") && shows(el))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.height > 0 && r.bottom > clip.top + 0.5 && r.top < clip.bottom - 0.5)
      .map(({ el, r }) => ({ text: el.textContent!.replace(/\s+/g, " ").trim().slice(0, 32), box: el.matches(".cl-in"), top: r.top, bottom: r.bottom }))
      .sort((a, b) => a.top - b.top);
    return { top: clip.top, bottom: clip.bottom, lines };
  });

describe("hero window: ben's pane is a terminal (QA round 1)", () => {
  for (const width of [1440, 390]) {
    test(`${width}: every 50ms from 2.0s to 5.2s, one prompt box and no two lines on top of each other`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 } });
      const bad: string[] = [];
      for (let ms = 2000; ms <= 5200; ms += 50) {
        await at(page, ms);
        const { lines } = await transcript(page);
        const boxes = lines.filter((l) => l.box).length;
        if (boxes !== 1) bad.push(`${ms}ms: ${boxes} prompt boxes`);
        for (let i = 1; i < lines.length; i++)
          if (lines[i].top < lines[i - 1].bottom - 0.5) bad.push(`${ms}ms: "${lines[i].text}" over "${lines[i - 1].text}"`);
      }
      expect(bad).toEqual([]);
      await close();
    }, 30000);
  }

  test("2.2s: the log rows give way to the summary in one step, never both on screen", async () => {
    const { page, close } = await open();
    const states: string[] = [];
    for (let ms = 2150; ms <= 2450; ms += 10) {
      await at(page, ms);
      const { lines } = await transcript(page);
      const log = lines.some((l) => /17:03:51|\+197 lines|Reading logs/.test(l.text)), summary = lines.some((l) => l.text.includes("312 RefundLimitErrors"));
      if (log === summary) states.push(`${ms}ms: log ${log}, summary ${summary}`);
    }
    expect(states).toEqual([]);
    await close();
  });

  for (const width of [390, 360, 320]) {
    test(`${width}: the transcript stays anchored to the pane's bottom: no gap opens, the newest line always shows`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 } });
      const bad: string[] = [];
      for (let ms = 600; ms <= 6000; ms += 50) {
        await at(page, ms);
        const { top, bottom, lines } = await transcript(page);
        if (lines[0].top > top + 0.5) bad.push(`${ms}ms: ${Math.round(lines[0].top - top)}px empty above "${lines[0].text}"`);
        for (let i = 1; i < lines.length; i++)
          if (lines[i].top - lines[i - 1].bottom > 21) bad.push(`${ms}ms: ${Math.round(lines[i].top - lines[i - 1].bottom)}px empty above "${lines[i].text}"`);
        const last = lines[lines.length - 1];
        if (last.bottom > bottom + 0.5) bad.push(`${ms}ms: "${last.text}" cut off at the bottom`);
      }
      expect(bad).toEqual([]);
      await close();
    }, 60000);
  }

  test("390, settled: ~/shop $ xmu has scrolled up out of the top, not vanished; the Bash call is the first line, in full", async () => {
    const { page, close } = await open({ viewport: { width: 390, height: 900 } });
    await at(page, 8000);
    const { top, lines } = await transcript(page);
    const cmd = await page.$eval("#top .pane.ben .cl .sh-cmd", (el) => [el.getClientRects().length, el.getBoundingClientRect().top] as const);
    expect([cmd[0], cmd[1] < top]).toEqual([1, true]);
    // XMU-860 removed the "enter to send" line under ana's box, so the transcript is one line shorter and the Bash call now fits.
    // This holds with the suite's hinted fonts (as on CI); with unhinted fonts the line sits a few pixels higher, in the fade band.
    expect(lines[0].text).toBe("Bash(tail -n 200 logs/prod.log)");
    expect(lines[0].top).toBeGreaterThanOrEqual(top - 0.5);
    // ana's steer box is the newest line, with no "enter to send" tip under it
    expect(lines.at(-1)!.text).toContain("ana> also fix partial refunds.");
    expect(lines.at(-1)!.box).toBe(true);
    await close();
  });

  // QA round 1 follow-up: a line scrolling out of the top was cut in half, hard, under the pane header
  for (const width of [390, 360, 320]) {
    test(`${width}: a line scrolling out of the top fades out; while waiting, the first line sits clear of the fade`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 } });
      const fade = () =>
        page.$eval("#top .pane.ben .cl", (el) => {
          const cs = getComputedStyle(el);
          const m = cs.maskImage || cs.getPropertyValue("-webkit-mask-image");
          const band = m.match(/^linear-gradient\((?:to bottom, )?(?:transparent|rgba\(0, 0, 0, 0\)) 0(?:px)?, rgb\(0, 0, 0\) (\d+)px\)$/);
          return { band: band ? Number(band[1]) : 0, top: el.getBoundingClientRect().top, pad: parseFloat(cs.paddingTop) };
        });
      await at(page, 600);
      const waiting = await fade();
      expect(waiting.band).toBeGreaterThanOrEqual(8);
      // at 320 the waiting transcript already fills the pane, so its first line is the one fading out
      const first = await page.$eval("#top .pane.ben .cl .sh-cmd", (el) => el.getBoundingClientRect().top);
      // its line box may start inside the band, but its letters (a few px down) sit where the fade is nearly done
      if (width >= 360) expect(first - waiting.top).toBeGreaterThanOrEqual(waiting.band - 8);
      await at(page, 8000);
      expect((await fade()).band).toBeGreaterThanOrEqual(8);
      await close();
    });
  }
});

// QA round 1 (both reports): the invite card's link and "Link copied" chip wrapped onto two lines at 761–830px and
// 1024–1125px. Waiting (frozen at 600ms), at every width from 320 to 1920: one line each, and the card centred in its seat.
describe("hero window: the invite card at every width (QA round 1)", () => {
  test("320 to 1920, every 5px: the link and the chip keep one line, the card fits its seat, centred", async () => {
    const { page, close } = await open({ viewport: { width: 1920, height: 900 } });
    const bad: string[] = [];
    for (let width = 320; width <= 1920; width += 5) {
      await page.setViewportSize({ width, height: 900 });
      await at(page, 600);
      const r = await page.evaluate(() => {
        const seat = document.querySelector("#top .invite")!;
        if (!seat.getClientRects().length) return null; // phones: no card
        // lines its text takes: one rect per line box
        const lines = (sel: string) => {
          const range = document.createRange();
          range.selectNodeContents(document.querySelector(sel)!);
          return new Set([...range.getClientRects()].filter((q) => q.width > 0.5).map((q) => Math.round(q.top))).size;
        };
        const s = seat.getBoundingClientRect(), c = document.querySelector("#top .iv-card")!.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(seat).paddingLeft);
        return {
          link: lines("#top .iv-link > span:first-child"),
          chip: lines("#top .iv-copied"),
          linkRow: Math.round(document.querySelector("#top .iv-link")!.getBoundingClientRect().height),
          fits: c.left >= s.left + pad - 0.5 && c.right <= s.right - pad + 0.5,
          spare: Math.floor(s.width - 2 * pad - c.width), // CI draws the mono link a few px wider: keep 6px
          off: Math.abs((c.left + c.right) / 2 - (s.left + s.right) / 2),
        };
      });
      if (!r) continue;
      if (r.link !== 1 || r.chip !== 1 || r.linkRow > 28 || !r.fits || r.spare < 6 || r.off > 1) bad.push(`${width}: ${JSON.stringify(r)}`);
    }
    expect(bad).toEqual([]);
    await close();
  }, 120000);
});

// QA round 1 (diff finding 3): body's overflow-wrap: anywhere reached the labels in How it works, so at 561–602px
// "mi/a", "lea/d", "agen/t", "17:1/1" broke mid-word and "ana's/Codex" split. A label never takes two lines: names,
// role and kind tags, timestamps, agent chips. A row of them may wrap between labels, never inside one.
describe("labels in the window and the screens never wrap (QA round 1)", () => {
  const LABELS = ":is(.pt, .tag, .role, .kind, .ts, .chat .nm, .ph .in, .cl-in .flag, .iv-copied, .who, .sys b, .nt-h b)";
  for (const width of [561, 580, 600, 761, 1024, 1100]) {
    test(`${width}: no single-line label wraps, in the hero or the 4 screens`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const wrapped = await page.evaluate((labels) => {
        const out: string[] = [];
        for (const root of document.querySelectorAll("#top figure, #how .hw-shot")) {
          for (const el of root.querySelectorAll(labels)) {
            if (!el.getClientRects().length) continue;
            // each run of text directly in the label (a chip's name, "ana’s Codex", "17:11") stays on one line
            for (const n of el.childNodes) {
              if (n.nodeType !== 3 || !n.textContent!.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(n);
              const tops = new Set([...range.getClientRects()].filter((q) => q.width > 0.5).map((q) => Math.round(q.top)));
              if (tops.size > 1) out.push(`${root.closest("#top") ? "hero" : `step ${[...document.querySelectorAll("#how .hw-row")].indexOf(root.closest(".hw-row")!) + 1}`} .${el.className.replace(/ /g, ".")}: "${n.textContent!.trim()}"`);
            }
          }
        }
        return out;
      }, LABELS);
      expect(wrapped).toEqual([]);
      await close();
    });
  }
});

// QA round 1 (fresh F5): if both files called checkLimit, fixing limit.ts would fix partial refunds too and ana's steer
// would be redundant. Codex finds that partial.ts repeats the check instead, so ana's "also fix partial refunds" is news.
test("story: partial.ts has its own copy of the check, so ana's steer adds something", () => {
  expect(HTML).not.toContain("2 callers");
  expect(HTML).toContain("partial.ts:17 repeats the check");
  expect(HTML).toContain("also fix partial refunds. same check in <span class=\"nw\">partial.ts");
});

// QA round 1 (diff finding 6): the diff's line numbers (2.81:1) and the "›" and "·" in xmu's bar (2.57:1, 2.21:1 on
// step 2's focused bar) were under 4.5:1. Every text in the window and the screens reaches 4.5:1 on what is behind it.
describe("text contrast in the window and the screens (QA round 1)", () => {
  for (const width of [1440, 390]) {
    test(`${width}: every text reaches 4.5:1 against its background`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const low = await page.evaluate(() => {
        type C = { r: number; g: number; b: number; a: number };
        // rgb()/rgba(), or color(srgb r g b / a) with channels from 0 to 1 (what color-mix() computes to)
        const parse = (c: string): C => {
          const m = c.replace("srgb", "").match(/[\d.]+/g)!.map(Number), k = c.startsWith("color(") ? 255 : 1;
          return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m.length > 3 ? m[3] : 1 };
        };
        const over = (top: C, bot: C): C => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
        const lum = (c: C) => { const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
        // the colours behind an element, nearest first, down to the first opaque one; a flat gradient tint counts as a colour
        const behind = (el: Element): C => {
          const layers: C[] = [];
          for (let n: Element | null = el; n; n = n.parentElement) {
            const cs = getComputedStyle(n);
            const tint = cs.backgroundImage.match(/^linear-gradient\((rgba?\([^)]*\)), (rgba?\([^)]*\))\)$/);
            if (tint && tint[1] === tint[2]) layers.push(parse(tint[1]));
            const c = parse(cs.backgroundColor);
            if (c.a > 0) { layers.push(c); if (c.a >= 1) break; }
          }
          return layers.reverse().reduce((bot, top) => over(top, bot), { r: 255, g: 255, b: 255, a: 1 });
        };
        const out: string[] = [];
        for (const root of document.querySelectorAll("#top figure, #how .hw-shot")) {
          const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const el = n.parentElement!;
            if (!n.textContent!.trim() || !el.getClientRects().length) continue;
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.color === "rgba(0, 0, 0, 0)") continue; // gradient text (Codex's shimmer) has no flat colour
            const bg = behind(el), fg = over(parse(cs.color), bg);
            const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
            const ratio = (hi + 0.05) / (lo + 0.05);
            if (ratio < 4.5) out.push(`${el.className || el.tagName} "${n.textContent!.trim().slice(0, 12)}" ${ratio.toFixed(2)}:1`);
          }
        }
        return [...new Set(out)];
      });
      expect(low).toEqual([]);
      await close();
    });
  }
});

// Text a box cuts sideways: a line whose letters run past the edge where the box that clips it cuts (its padding
// box). Lines that fade out at the edge on purpose (a mask) are left out.
const cutText = (page: Page, root: string) =>
  page.evaluate((root) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll(`${root} :is(p, li)`)) {
      if (!el.getClientRects().length || el.closest(".gone") || !el.textContent!.trim()) continue;
      if (getComputedStyle(el).visibility === "hidden") continue;
      let o = 1;
      for (let n: Element | null = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
      if (o < 0.05) continue;
      let clip: Element | null = el.parentElement;
      while (clip && getComputedStyle(clip).overflowX === "visible") clip = clip.parentElement;
      if (!clip || clip === document.documentElement || clip === document.body) continue;
      let masked = false;
      for (let n: Element | null = el; n && n !== clip.parentElement; n = n.parentElement) if (getComputedStyle(n).maskImage !== "none") masked = true;
      if (masked) continue;
      const cs = getComputedStyle(clip);
      const c = clip.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const right = Math.max(...[...range.getClientRects()].filter((q) => q.width > 0).map((q) => q.right));
      const edge = c.right - parseFloat(cs.borderRightWidth);
      if (right > edge + 0.5) out.push(`${clip.className}: "${el.textContent!.trim().slice(0, 40)}" by ${Math.round(right - edge)}px`);
    }
    return [...new Set(out)];
  }, root);

// QA round 2 (diff attack): with CI's hinted glyphs ben's tool results wrapped on desktop ("1 removal" alone on a
// second line at 1440 and 1920, the log rows at 1225 to 1247). From 1200 to 1920: each result row keeps one line,
// waiting and settled, and from 1280 up the long "Updated limit.ts with 1 addition and 1 removal" shows.
describe("ben's tool results keep one line on desktop (QA round 2)", () => {
  test("1200 to 1920 every 5px", async () => {
    const { page, close } = await open({ viewport: { width: 1920, height: 900 } });
    const bad: unknown[] = [];
    for (let width = 1200; width <= 1920; width += 5) {
      await page.setViewportSize({ width, height: 900 });
      for (const ms of [600, 8000]) {
        await atAfterResize(page, ms);
        const rows = await page.$$eval("#top .pane.ben .cl-r", (els) => els.flatMap((el) => {
          if (!el.getClientRects().length || getComputedStyle(el).visibility === "hidden") return [];
          const cs = getComputedStyle(el);
          const lines = Math.round((el.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight));
          return lines > 1 ? [el.textContent!.trim().slice(0, 30)] : [];
        }));
        if (rows.length) bad.push([width, ms, rows]);
        if (ms === 8000 && width >= 1280 && !(await readable(page, "#top .pane.ben")).includes("Updated limit.ts with 1 addition and 1 removal")) bad.push([width, "no Updated line"]);
      }
    }
    expect(bad).toEqual([]);
    await close();
  }, 180_000);
});

// QA round 2 (diff attack): at 561 to 564px, step 3 broke mia's "src/refunds/limit.ts" inside the word ("limit.t" then
// "s"). In a terminal line a word wraps whole; a path that can't fit may wrap after a slash, never inside a name.
describe("terminal lines never break inside a word (QA round 2)", () => {
  test("the window and the 4 screens, 320 to 1920 every 5px, and 555 to 610 every 1px", async () => {
    const { page, close } = await open({ viewport: { width: 1920, height: 900 }, reducedMotion: "reduce" });
    const widths = [...Array.from({ length: 321 }, (_, i) => 320 + i * 5), ...Array.from({ length: 56 }, (_, i) => 555 + i)];
    const bad: unknown[] = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      const split = await page.evaluate(() => {
        const out: string[] = [];
        for (const line of document.querySelectorAll("#top .cli p, #how .cli p")) {
          if (!line.getClientRects().length) continue;
          const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            for (const m of n.textContent!.matchAll(/\S{3,}/g)) {
              const range = document.createRange();
              range.setStart(n, m.index!);
              range.setEnd(n, m.index! + m[0].length);
              const tops = new Set([...range.getClientRects()].filter((q) => q.width > 0.5).map((q) => Math.round(q.top)));
              if (tops.size > 1) out.push(m[0]);
            }
          }
        }
        return out;
      });
      if (split.length) bad.push([width, split]);
    }
    expect(bad).toEqual([]);
    await close();
  }, 180_000);
});

// QA round 2: Windows high contrast drops box-shadows, and with them the window's frame: its panes floated loose.
describe("forced colours: the window and the screens keep their frame (QA round 2)", () => {
  test("an outline in the system text colour around the window and each screen", async () => {
    const { page, close } = await open({ viewport: { width: 1440, height: 900 }, forcedColors: "active" });
    const frames = await page.$$eval("#top figure.tm, #how :is(.hw-shot.hx, .hx.own)", (els) =>
      [...new Set(els.map((el) => { const s = getComputedStyle(el); return `${s.outlineStyle} ${s.outlineWidth}`; }))]);
    expect(frames).toEqual(["solid 1px"]);
    await close();
  });
});

// QA round 3: in forced colours with a light system theme, Claude's dots and mia's Cursor hexagons kept their light
// fill on white and all but vanished; step 2's invite pop-up and mia's "lead" tag lost their edges.
describe("forced colours, light and dark: glyphs in the system text colour, edges kept (QA round 3)", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`${colorScheme}: the window's and the screens' dots and hexagons use the text colour; the pop-up and "lead" keep an edge`, async () => {
      const { page, close } = await open({ viewport: { width: 1440, height: 900 }, forcedColors: "active", colorScheme, reducedMotion: "reduce" });
      const r = await page.evaluate(() => {
        const text = getComputedStyle(document.body).color;
        const paint = [...document.querySelectorAll(".g-dot, .g-hex")].map((el) => {
          const s = getComputedStyle(el);
          return el.classList.contains("open") ? s.stroke : s.fill;
        });
        return {
          off: [...new Set(paint.filter((c) => c !== text))],
          edges: [...new Set([...document.querySelectorAll("#how .pop, .role")].map((el) => getComputedStyle(el).borderTopStyle))],
        };
      });
      expect(r).toEqual({ off: [], edges: ["solid"] });
      await close();
    });
  }
});

// QA round 3: under 375px ben's "40 + if (amountCents > toCents(total))" ran 12px past his pane, so its edge fade
// barely showed and the last ")" was lost. From 320 to 374, settled: every diff line ends inside the pane.
describe("phones: ben's diff lines fit his pane (QA round 3)", () => {
  test("320 to 374 every 1px", async () => {
    const { page, close } = await open({ viewport: { width: 374, height: 800 } });
    const bad: unknown[] = [];
    for (let width = 320; width <= 374; width++) {
      await page.setViewportSize({ width, height: 800 });
      await atAfterResize(page, 8000);
      const over = await page.$$eval("#top .pane.ben .cl-diff p", (ps) => ps.flatMap((p) => {
        const pane = p.closest(".cli")!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(p);
        const right = Math.max(...[...range.getClientRects()].filter((q) => q.width > 0).map((q) => q.right));
        return right > pane.right + 0.5 ? [`${p.textContent!.trim().slice(0, 30)} by ${Math.round(right - pane.right)}px`] : [];
      }));
      if (over.length) bad.push([width, over]);
    }
    expect(bad).toEqual([]);
    await close();
  }, 120_000);
});

// QA round 2: as mia's prompt went in, her empty box faded out over it while the text rose, so both read for ~100ms.
// The box gives way in one step, as ana's placeholder does: never both on screen.
describe("mia's empty box gives way to her prompt in one step (QA round 2)", () => {
  test("every 10ms from 2.7s to 3.1s, never her empty box and her prompt at once", async () => {
    const { page, close } = await open({ viewport: { width: 1440, height: 900 } });
    const both: number[] = [];
    for (let ms = 2700; ms <= 3100; ms += 10) {
      await at(page, ms);
      if ((await seen(page, "#top .cu-new .cu-in")) > 0.02 && (await seen(page, "#top .cu-u")) > 0.02) both.push(ms);
    }
    expect(both).toEqual([]);
    await close();
  });
});

// QA round 2: between the widths above, "// dollars" in the hero (1225 to 1255px) and step 3's toCents(total) line
// (577 to 603px) ran past ben's pane. Every 5px from 320 to 1920: nothing pokes out of the window, settled or waiting,
// or out of a screen.
describe("nothing pokes out at any width (QA round 2)", () => {
  test("hero window, 320 to 1920 every 5px, waiting and settled", async () => {
    const { page, close } = await open({ viewport: { width: 1920, height: 900 } });
    const bad: unknown[] = [];
    for (let width = 320; width <= 1920; width += 5) {
      await page.setViewportSize({ width, height: 900 });
      for (const ms of [600, 8000]) {
        await atAfterResize(page, ms);
        const s = [...(await spills(page)), ...(await cutText(page, "#top .tm"))];
        if (s.length) bad.push([width, ms, s]);
      }
    }
    expect(bad).toEqual([]);
    await close();
  }, 180_000);

  test("the 4 screens, 320 to 1920 every 5px", async () => {
    const { page, close } = await open({ viewport: { width: 1920, height: 900 }, reducedMotion: "reduce" });
    const bad: unknown[] = [];
    for (let width = 320; width <= 1920; width += 5) {
      await page.setViewportSize({ width, height: 900 });
      const s = [...(await spills(page, "#how :is(.hw-shot.hx, .hx.own, .pane, .chat, .tm-bar, .xb, .pop, .own-body)")), ...(await cutText(page, "#how"))];
      if (s.length) bad.push([width, s]);
    }
    expect(bad).toEqual([]);
    await close();
  }, 180_000);
});
