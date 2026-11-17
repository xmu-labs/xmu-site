// XMU-817: centred hero, "How it works" in 4 steps, and the stack strip, from the approved
// mock (v5.1). Same harness as polish.test.ts: serve the site
// with the vercel.json headers (CSP enforced) and drive real Chromium.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { allowedFormOrigins, deployedFile, findPlaceholders } from "../tools/launch-check";

const SITE = join(import.meta.dir, "..");
const HTML = readFileSync(join(SITE, "index.html"), "utf8");
const HEADERS: Record<string, string> = Object.fromEntries(
  JSON.parse(readFileSync(join(SITE, "vercel.json"), "utf8"))
    .headers.find((h: { source: string }) => h.source === "/(.*)")
    .headers.map((h: { key: string; value: string }) => [h.key, h.value]),
);

const SUB =
  "Bring the agents you already use and invite your team. Everyone jumps into the same session, steers any agent, and builds on each other’s work at the same time.";

// The approved step copy, word for word.
const STEPS = [
  { tag: "Step 1", name: "Terminal", h3: "Create a shared terminal.", p: "Run xmu in your repo. You get one terminal your whole team can join." },
  { tag: "Step 2", name: "Team", h3: "Invite your teammates and their agents.", p: "Type invite and pick your teammates. The invite shows up in their own terminal, and each joins with the agent they already use: Claude, Codex, Cursor or any CLI agent." },
  { tag: "Step 3", name: "Together", h3: "Start working together.", p: "Everyone types in the same session. Steer any agent, yours or a teammate’s, and build on each other’s work." },
  { tag: "Step 4", name: "Ship", h3: "Ship together.", p: "Test, review and merge from the same place. The whole story stays in one history." },
];

// Brand v1 (brand guide, copy v2): every colour on the steps comes from here,
// plus the hero's people colours and the agent logo colours.
const BRAND = ["#050A12", "#0F2B4D", "#2E6EA8", "#7EC8F3", "#EAF4FF", "#0F1A2B", "#0A1322", "#2B3A55", "#A7B4C9", "#4FBF8B", "#FFFFFF",
  "#F7FAFF", "#EEF4FF", "#CBD8E8", "#E3A23B", "#F27AA0", "#D97757",
  // XMU-833: the screens take the hero window's own tokens (--t-bg, --t-line, --t-dim, --t-faint, --t-bad)
  "#07101C", "#1A2F4D", "#8C9AB2", "#4A5C78", "#FF9B9B"];

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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce", ...opts });
  // The page posts to the real waitlist form: never let a test sign up for real.
  await context.route("https://formspree.io/**", (route) => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(2000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  if (opts.light) await page.addInitScript(() => localStorage.setItem("xmu-theme", "light"));
  await page.goto(`${base}/`);
  return { page, errors, close: () => context.close() };
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const box = (page: Page, sel: string): Promise<Box> => page.locator(sel).first().evaluate((el) => el.getBoundingClientRect().toJSON());
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const text = async (page: Page, sel: string) => squash(await page.locator(sel).first().innerText());
const hex = (rgb: string) => {
  const m = rgb.match(/[\d.]+/g)!.map(Number);
  return "#" + m.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
};

describe("hero, centred", () => {
  let page: Page;
  let close: () => Promise<void>;
  beforeAll(async () => ({ page, close } = await open()));
  afterAll(() => close());

  test("the subhead is subhead A, word for word", async () => {
    expect(await text(page, "#top .sub")).toBe(SUB);
  });

  test("title, subhead and buttons are centred on the page", async () => {
    const mid = 1440 / 2;
    for (const sel of ["#top h1", "#top .sub", "#top .actions"]) {
      const b = await box(page, sel);
      expect(Math.abs((b.left + b.right) / 2 - mid)).toBeLessThanOrEqual(2);
      expect(await page.locator(sel).first().evaluate((el) => getComputedStyle(el).textAlign)).toBe("center");
    }
  });

  test("the product window sits below the buttons", async () => {
    const actions = await box(page, "#top .actions-note");
    const win = await box(page, "#top figure.tm");
    expect(win.top).toBeGreaterThan(actions.bottom + 32);
  });

  test("the note under the buttons is the approved line", async () => {
    expect(await text(page, "#top .actions-note")).toBe("Early access for small teams.");
  });

  test('one quieter "See demo" button (XMU-830) follows the waitlist button, and nothing else', async () => {
    const btns = page.locator("#top .actions a");
    expect(await btns.count()).toBe(2);
    expect(await btns.nth(0).getAttribute("href")).toBe("#waitlist");
    expect(await btns.nth(1).innerText()).toBe("See demo");
    expect(await btns.nth(1).getAttribute("class")).toContain("ghost");
  });

  test('"See demo" is an outline button on the same row, right of the waitlist button', async () => {
    const demo = page.locator('#top .actions a[href="#demo"]');
    expect(await demo.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    expect(await demo.evaluate((el) => getComputedStyle(el).boxShadow)).toMatch(/ 0px 0px 0px 1px inset$/); // the 1px outline
    const join = await box(page, '#top .actions a[href="#waitlist"]');
    const see = await box(page, '#top .actions a[href="#demo"]');
    expect(Math.abs(join.top - see.top)).toBeLessThanOrEqual(1);
    expect(see.left).toBeGreaterThan(join.right);
  });

  test('no hidden "Book a call" is left in the hero (XMU-859): every button there shows', async () => {
    const btns = page.locator("#top .actions a");
    expect(await btns.evaluateAll((els) => els.filter((e) => getComputedStyle(e).display === "none").length)).toBe(0);
    expect(await page.locator("#top .actions a[target]").count()).toBe(0);
    expect(HTML).not.toMatch(/book a call/i);
  });

  test("launch-check finds nothing left to supply on the real page", async () => {
    const left = await findPlaceholders(HTML, {
      exists: deployedFile(SITE),
      allowedOrigins: allowedFormOrigins(readFileSync(join(SITE, "vercel.json"), "utf8")),
    });
    expect(left).toEqual([]);
  });
});

describe("how it works", () => {
  let page: Page;
  let errors: string[];
  let close: () => Promise<void>;
  beforeAll(async () => ({ page, errors, close } = await open()));
  afterAll(() => close());

  test("sits after the two answers and before the waitlist, named by its heading", async () => {
    const ids = await page.$$eval("main#main section[id]", (els) => els.map((e) => e.id));
    expect(ids.indexOf("how")).toBe(ids.indexOf("context") + 1);
    expect(ids.indexOf("stack")).toBe(ids.indexOf("how") + 1);
    expect(ids.indexOf("waitlist")).toBe(ids.indexOf("stack") + 1);
    expect(await page.getAttribute("#how", "aria-labelledby")).toBe("how-title");
    expect(await text(page, "#how-title")).toBe("How it works");
  });

  test("four steps in order, copy word for word", async () => {
    const rows = page.locator("#how ol.hw-list > li.hw-row");
    expect(await rows.count()).toBe(4);
    for (const [i, s] of STEPS.entries()) {
      const row = rows.nth(i);
      // the tag shows in capitals; its text stays "Step N" for screen readers
      expect(squash((await row.locator(".hw-tag").textContent())!)).toBe(s.tag);
      expect(await text(page, `#how .hw-row:nth-child(${i + 1}) .hw-name`)).toBe(s.name);
      expect(await text(page, `#how .hw-row:nth-child(${i + 1}) h3`)).toBe(s.h3);
      expect(await text(page, `#how .hw-row:nth-child(${i + 1}) .hw-card > p:last-child`)).toBe(s.p);
      expect(await row.locator(".hw-shot").count()).toBe(1);
    }
  });

  test("each step's screen is decorative: hidden from screen readers, nothing focusable", async () => {
    const shots = page.locator("#how .hw-shot");
    for (let i = 0; i < 4; i++) expect(await shots.nth(i).getAttribute("aria-hidden")).toBe("true");
    expect(await page.locator("#how .hw-shot a, #how .hw-shot button, #how .hw-shot [tabindex]").count()).toBe(0);
  });

  test("each screen shows its own step in xmu, with the hero's cast and story", async () => {
    const shot = (n: number) => text(page, `#how .hw-row:nth-child(${n}) .hw-shot`);
    // XMU-833: the hero's refunds-hotfix story, step by step
    expect(await shot(1)).toContain("refunds-hotfix");
    const team = await shot(2);
    for (const who of ["ben", "ana", "mia", "Claude", "Codex", "Cursor"]) expect(team).toContain(who);
    expect(await shot(3)).toContain("also fix partial refunds");
    expect(await shot(4)).toContain("#218 merged");
    expect(await shot(4)).toContain("deploy 1.8.4 live");
  });

  test("desktop 1440: card and screen share a row, sides alternate, a line joins them", async () => {
    for (let n = 1; n <= 4; n++) {
      const card = await box(page, `#how .hw-row:nth-child(${n}) .hw-card`);
      const shot = await box(page, `#how .hw-row:nth-child(${n}) .hw-shot`);
      expect(Math.abs((card.top + card.bottom) / 2 - (shot.top + shot.bottom) / 2)).toBeLessThanOrEqual(card.height);
      if (n % 2) expect(shot.left).toBeGreaterThan(card.right);
      else expect(shot.right).toBeLessThan(card.left);
      const line = await page.locator(`#how .hw-row:nth-child(${n}) .hw-card`).evaluate((el) => getComputedStyle(el, "::after").width);
      expect(parseFloat(line)).toBeGreaterThan(40);
    }
  });

  test("rows go top to bottom in step order", async () => {
    let last = -1;
    for (let n = 1; n <= 4; n++) {
      const b = await box(page, `#how .hw-row:nth-child(${n}) .hw-card`);
      expect(b.top).toBeGreaterThan(last);
      last = b.top;
    }
  });

  test("no script errors", () => {
    expect(errors).toEqual([]);
  });
});

// Every text, background, border, logo and connector colour in How it works and the stack strip,
// in both themes. Translucent colours count by their RGB part; fully clear ones are skipped.
describe("brand colours only", () => {
  for (const light of [false, true]) {
    test(`How it works and the stack strip (${light ? "light" : "dark"} theme)`, async () => {
      const { page, close } = await open({ light });
      const seen = await page.$$eval("#how, #how *, #stack, #stack *", (els) => {
        const out: string[] = [];
        for (const el of els) {
          for (const pseudo of [null, "::before", "::after"]) {
            const cs = getComputedStyle(el, pseudo);
            if (pseudo && (cs.content === "none" || cs.content === "normal")) continue;
            for (const p of ["color", "backgroundColor", "borderTopColor", ...(el instanceof SVGElement ? (["fill"] as const) : [])] as const) {
              const v = cs[p];
              if (!v || v === "none" || v.startsWith("url")) continue;
              const a = v.match(/[\d.]+/g)!.map(Number);
              if (a.length > 3 && a[3] === 0) continue;
              out.push(v);
            }
            // gradient stops and shadows carry most of the step screens' colour
            for (const v of [cs.backgroundImage, cs.boxShadow]) {
              for (const c of v.match(/rgba?\([^)]*\)/g) ?? []) {
                const a = c.match(/[\d.]+/g)!.map(Number);
                if (a.length > 3 && a[3] === 0) continue;
                out.push(c);
              }
              // any other colour syntax (oklch, color-mix, hsl...) can't be checked against the hex list, so it fails
              for (const c of v.match(/\b(?:oklch|oklab|lch|lab|hsla?|hwb|color-mix|color)\(/g) ?? []) out.push(c);
            }
          }
        }
        return out;
      });
      const off = [...new Set(seen.map((v) => (v.startsWith("rgb") ? hex(v) : v)))].filter((h) => !BRAND.includes(h));
      expect(off).toEqual([]);
      await close();
    });
  }
});

describe("how it works at other widths and themes", () => {
  for (const width of [1024, 768, 375]) {
    test(`${width}: each card sits above its own screen, full width`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 } });
      for (let n = 1; n <= 4; n++) {
        const card = await box(page, `#how .hw-row:nth-child(${n}) .hw-card`);
        const shot = await box(page, `#how .hw-row:nth-child(${n}) .hw-shot`);
        expect(shot.top).toBeGreaterThanOrEqual(card.bottom);
        expect(Math.abs(shot.width - card.width)).toBeLessThanOrEqual(1);
        const dot = await page.locator(`#how .hw-row:nth-child(${n}) .hw-card`).evaluate((el) => getComputedStyle(el, "::before").display);
        expect(dot).toBe("none");
      }
      await close();
    });
  }

  test("phone 375: step 3 shows only ben's pane", async () => {
    const { page, close } = await open({ viewport: { width: 375, height: 800 } });
    expect(await page.locator("#how .hw-row:nth-child(3) .pane.ben").isVisible()).toBe(true);
    expect(await page.locator("#how .hw-row:nth-child(3) .pane.ana").isVisible()).toBe(false);
    expect(await page.locator("#how .hw-row:nth-child(3) .pane.mia").isVisible()).toBe(false);
    await close();
  });

  for (const width of [1440, 1024, 768, 375, 320]) {
    test(`${width}: no sideways scroll and no text spilling out of a screen`, async () => {
      const { page, close } = await open({ viewport: { width, height: 800 } });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      const spill = await page.$$eval("#how .hw-shot, #stack li", (els) =>
        els.filter((el) => (el as HTMLElement).offsetParent && el.scrollWidth > el.clientWidth + 1).map((el) => el.className),
      );
      expect(spill).toEqual([]);
      await close();
    });
  }

  test("light theme: cards follow the theme, the screens stay dark", async () => {
    const { page, close } = await open({ light: true });
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    const card = await page.locator("#how .hw-card").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(hex(card)).toBe("#FFFFFF");
    // XMU-833: the screens take the hero window's dark ground
    const shot = await page.locator("#how .hw-shot.hx").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(hex(shot)).toBe("#07101C");
    await close();
  });

  test("motion allowed: rows rise in on scroll; reduced motion: no animation", async () => {
    const moving = await open({ reducedMotion: "no-preference" });
    const anim = await moving.page.locator("#how .hw-row").first().evaluate((el) => getComputedStyle(el).animationName);
    expect(anim).toBe("hw-rise");
    await moving.close();
    const still = await open({ reducedMotion: "reduce" });
    expect(await still.page.locator("#how .hw-row").first().evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    await still.close();
  });
});

describe("stack strip", () => {
  test("heading, six chips with three logos, and the line under them", async () => {
    const { page, close } = await open();
    expect(await text(page, "#stack h2")).toBe("Works with your existing stack and any coding agent.");
    expect(await page.$$eval("#stack .chips li", (els) => els.map((e) => (e as HTMLElement).innerText.trim()))).toEqual([
      "Claude", "Codex", "Cursor", "Gemini CLI", "GitHub Copilot", "Any CLI agent",
    ]);
    expect(await page.locator("#stack .chips svg").count()).toBe(3);
    expect(await text(page, "#stack .chips-sub")).toBe("Your repo, your git, your terminal. Nothing to migrate.");
    await close();
  });
});

// QA round 1 (XMU-817)
describe("QA round 1", () => {
  test("print: step screens and tags keep their colours, rows don't split, no glow", async () => {
    const { page, close } = await open();
    await page.emulateMedia({ media: "print" });
    const got = await page.$$eval("#how .hw-shot, #how .hw-tag", (els) => els.map((el) => getComputedStyle(el).printColorAdjust));
    expect(new Set(got)).toEqual(new Set(["exact"]));
    expect(new Set(await page.$$eval("#how .hw-row", (els) => els.map((el) => getComputedStyle(el).breakInside)))).toEqual(new Set(["avoid"]));
    expect(new Set(await page.$$eval("#how .hw-shot", (els) => els.map((el) => getComputedStyle(el).boxShadow)))).toEqual(new Set(["none"]));
    await close();
  });

  test("forced colours: every logo uses the text colour, and each card keeps its connector", async () => {
    const { page, close } = await open({ forcedColors: "active" });
    const text = await page.evaluate(() => getComputedStyle(document.body).color);
    const fills = await page.$$eval("svg.mlogo", (els) => els.map((el) => getComputedStyle(el).fill));
    expect(new Set(fills)).toEqual(new Set([text]));
    const line = await page.locator("#how .hw-card").first().evaluate((el) => getComputedStyle(el, "::after").backgroundColor);
    expect(line).toBe(text);
    await close();
  });

  test("the share image's alt text describes what the image shows", async () => {
    const { page, close } = await open();
    expect(await page.getAttribute('meta[property="og:image:alt"]', "content")).toBe("xmu: Work with your team and AI agents in one shared terminal.");
    await close();
  });

  test("phone 375: step screens keep their window dots, the hero window keeps its 40px gap", async () => {
    const { page, close } = await open({ viewport: { width: 375, height: 800 } });
    expect(await page.locator("#how .tm-bar .dots").first().isVisible()).toBe(true);
    expect(await page.locator("#top figure.tm").evaluate((el) => getComputedStyle(el).marginTop)).toBe("40px");
    await close();
  });

  test("700 wide: step 3 still shows all three panes and the count", async () => {
    const { page, close } = await open({ viewport: { width: 700, height: 900 } });
    for (const who of ["ben", "ana", "mia"]) expect(await page.locator(`#how .hw-row:nth-child(3) .pane.${who}`).isVisible()).toBe(true);
    expect(await page.locator("#how .hw-row:nth-child(3) .cnt").isVisible()).toBe(true);
    await close();
  });

  test("motion on: each row is fully shown once it has scrolled into view", async () => {
    const { page, close } = await open({ reducedMotion: "no-preference" });
    for (let n = 1; n <= 4; n++) {
      const row = page.locator(`#how .hw-row:nth-child(${n})`);
      await row.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
      await page.waitForTimeout(100);
      expect(await row.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    }
    await close();
  });
});

// QA round 2 (XMU-817)
describe("QA round 2", () => {
  test("print: the How it works heading stays on the same page as step 1", async () => {
    const { page, close } = await open();
    await page.emulateMedia({ media: "print" });
    expect(await page.locator("#how h2").evaluate((el) => getComputedStyle(el).breakAfter)).toBe("avoid");
    await close();
  });

  test("cards keep the mock's 17px between the line and the sentence", async () => {
    const { page, close } = await open();
    for (let n = 1; n <= 4; n++) {
      const h3 = await box(page, `#how .hw-row:nth-child(${n}) .hw-card h3`);
      const p = await box(page, `#how .hw-row:nth-child(${n}) .hw-card > p:last-child`);
      expect(Math.round(p.top - h3.bottom)).toBe(17);
    }
    await close();
  });

  // XMU-833: the screens are CLI panes now; under 561px they drop to ben's pane and 12px text, like the hero on a phone
  for (const [width, cli, panes] of [[761, "12.5px", 3], [700, "12.5px", 3], [561, "12.5px", 3], [560, "12px", 1]] as const) {
    test(`${width} wide: terminal text ${cli}, ${panes} pane(s) in step 3`, async () => {
      const { page, close } = await open({ viewport: { width, height: 900 } });
      expect(new Set(await page.$$eval("#how .hw-shot .cli", (els) => els.map((el) => getComputedStyle(el).fontSize)))).toEqual(new Set([cli]));
      expect(await page.locator("#how .hw-row:nth-child(3) .pane:visible").count()).toBe(panes);
      await close();
    });
  }

  for (const colorScheme of ["light", "dark"] as const) {
    test(`forced colours (${colorScheme}): plain dot on each line, cursors, window dots and the picked agent keep their shape`, async () => {
      const { page, close } = await open({ forcedColors: "active", colorScheme });
      const text = await page.evaluate(() => getComputedStyle(document.body).color);
      for (const pseudo of ["::before", "::after"]) {
        const cs = await page.locator("#how .hw-card").first().evaluate((el, ps) => {
          const c = getComputedStyle(el, ps);
          return { bg: c.backgroundColor, shadow: c.boxShadow, display: c.display };
        }, pseudo);
        expect(cs).toEqual({ bg: text, shadow: "none", display: "block" });
      }
      for (const sel of ["#how .cur", "#how .tm-bar .dots i"]) {
        expect(new Set(await page.$$eval(sel, (els) => els.map((el) => getComputedStyle(el).backgroundColor)))).toEqual(new Set([text]));
      }
      expect(await page.locator("#how .nt-r.sel").first().evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("solid");
      await close();
    });
  }
});

// QA round 3 (XMU-817)
describe("QA round 3", () => {
  test("phone 375: step cards keep the mock's 26px 28px padding", async () => {
    const { page, close } = await open({ viewport: { width: 375, height: 800 } });
    expect(new Set(await page.$$eval("#how .hw-card", (els) => els.map((el) => getComputedStyle(el).padding)))).toEqual(new Set(["26px 28px"]));
    await close();
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`forced colours (${colorScheme}): step tags and avatars keep their shapes, every window keeps its dots`, async () => {
      const { page, close } = await open({ forcedColors: "active", colorScheme });
      const text = await page.evaluate(() => getComputedStyle(document.body).color);
      for (const sel of ["#how .hw-tag", "#how .av:not(.ag)", "#top .who .pp", "#top .av"]) {
        expect(new Set(await page.$$eval(sel, (els) => els.map((el) => getComputedStyle(el).borderTopStyle)))).toEqual(new Set(["solid"]));
      }
      expect(new Set(await page.$$eval("#top .tm-bar .dots i", (els) => els.map((el) => getComputedStyle(el).backgroundColor)))).toEqual(new Set([text]));
      await close();
    });
  }
});
