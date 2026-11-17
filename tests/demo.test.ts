// XMU-830: "See demo" in the hero opens the scripted demo video in the #demo section. The player is the
// browser's own (keyboard and screen readers work), it never autoplays, and when the video ends the real
// "Join the waitlist" button and "Watch again" show over its last frame. Each test was written failing first.
// Same harness as polish.test.ts: serve the site with the vercel.json headers (CSP enforced), drive real Chromium.
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
  browser = await chromium.launch();
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
  page.setDefaultTimeout(4000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/`);
  return { page, errors, close: () => context.close() };
}

const video = (page: Page) => page.locator("#demo video");
const overlay = (page: Page) => page.locator("#demo .demo-end");
// Plays the last moment of the video so it really ends (no faked "ended" event).
const playToEnd = (page: Page) =>
  video(page).evaluate(async (v: HTMLVideoElement) => {
    await v.play();
    v.currentTime = Math.max(0, v.duration - 0.3);
    await new Promise((r) => v.addEventListener("ended", r, { once: true }));
  });

describe("See demo in the hero", () => {
  test("sits right after Join the waitlist and points at the demo", async () => {
    const { page, close } = await open();
    const links = await page
      .locator(".hero .actions a")
      .evaluateAll((els) => els.map((e) => [e.textContent!.replace("→", "").trim(), e.getAttribute("href"), e.className]));
    expect(links).toEqual([
      ["Join the waitlist", "#waitlist", "btn lg"],
      ["See demo", "#demo", "btn lg ghost"],
    ]);
    await close();
  });

  test("pressing it brings the player into view and starts the video", async () => {
    const { page, errors, close } = await open({ reducedMotion: "reduce" });
    await page.getByRole("link", { name: "See demo" }).click();
    await page.waitForFunction(() => !document.querySelector<HTMLVideoElement>("#demo video")!.paused);
    const [v, nav] = await Promise.all([video(page).boundingBox(), page.locator(".nav").boundingBox()]);
    expect(v!.y).toBeGreaterThanOrEqual(nav!.y + nav!.height);
    expect(v!.y + v!.height).toBeLessThanOrEqual(800);
    expect(errors).toEqual([]);
    await close();
  });
});

describe("the demo player", () => {
  test("is shown, never autoplays, and shows a poster", async () => {
    const { page, close } = await open();
    expect(await page.locator("#demo").isVisible()).toBe(true);
    const v = await video(page).evaluate((v: HTMLVideoElement) => ({
      controls: v.controls,
      autoplay: v.autoplay,
      muted: v.muted,
      playsInline: v.playsInline,
      preload: v.preload,
      poster: new URL(v.poster).pathname,
      label: v.getAttribute("aria-label"),
      paused: v.paused,
      sources: [...v.querySelectorAll("source")].map((s) => [s.getAttribute("src"), s.getAttribute("type")]),
    }));
    expect(v).toEqual({
      controls: false, // until it plays, the page's own play button stands in for the browser's controls
      autoplay: false,
      muted: true,
      playsInline: true,
      preload: "none",
      poster: "/assets/demo-poster.webp",
      label: "xmu demo: a team and their agents fix a production bug in one shared terminal",
      paused: true,
      sources: [
        ["assets/demo.webm", "video/webm"],
        ["assets/demo.mp4", "video/mp4"],
      ],
    });
    for (const f of ["assets/demo.webm", "assets/demo.mp4", "assets/demo-poster.webp"]) expect([f, existsSync(join(SITE, f))]).toEqual([f, true]);
    await close();
  });

  test("before it plays, one play button sits centred on the poster and says how long the video is", async () => {
    const { page, close } = await open();
    const play = page.locator("#demo .demo-play");
    // the name starts with the visible label, so "click Watch the demo" works for voice users (WCAG 2.5.3)
    expect(await play.getAttribute("aria-label")).toBe("Watch the demo, 52 seconds");
    const [b, v] = await Promise.all([play.boundingBox(), video(page).boundingBox()]);
    expect(Math.abs(b!.x + b!.width / 2 - (v!.x + v!.width / 2))).toBeLessThan(2);
    expect(Math.abs(b!.y + b!.height / 2 - (v!.y + v!.height / 2))).toBeLessThan(2);
    expect(b!.height).toBeGreaterThanOrEqual(44);
    await close();
  });

  test("pressing play starts the video, hands over to the browser's controls, and keeps focus on the player", async () => {
    const { page, close } = await open();
    await page.locator("#demo .demo-play").click();
    await page.waitForFunction(() => !document.querySelector<HTMLVideoElement>("#demo video")!.paused);
    expect(await video(page).evaluate((v: HTMLVideoElement) => v.controls)).toBe(true);
    expect(await page.locator("#demo .demo-play").isVisible()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.matches("#demo video"))).toBe(true);
    await close();
  });

  test("before it plays, a click anywhere on the poster starts it too", async () => {
    const { page, close } = await open({ reducedMotion: "reduce" });
    await video(page).scrollIntoViewIfNeeded();
    const v = (await video(page).boundingBox())!;
    await page.mouse.click(v.x + 80, v.y + 80);
    await page.waitForFunction(() => !document.querySelector<HTMLVideoElement>("#demo video")!.paused, null, { timeout: 2000 });
    expect(await page.locator("#demo .demo-play").isVisible()).toBe(false);
    await close();
  });

  test("the whole video is also there as text, for anyone who can't watch it", async () => {
    const { page, close } = await open();
    const summary = page.locator("#demo details summary");
    expect(await summary.innerText()).toBe("Read the demo as text");
    // it keeps its disclosure triangle, so it reads as something to open
    expect(await summary.evaluate((el) => getComputedStyle(el).display)).toBe("list-item");
    await summary.click();
    const steps = await page.locator("#demo details ol li").allInnerTexts();
    expect(steps.length).toBe(9);
    expect(steps[0]).toContain("Refunds are failing in prod");
    expect(steps[8]).toContain("refunds work again");
    // XMU-860: the video has no story clock, so neither does its text
    expect(steps[0].startsWith("Refunds are failing in prod.")).toBe(true);
    expect(steps.filter((s) => /friday|\b\d{1,2}:\d{2}\s?(am|pm)\b/i.test(s))).toEqual([]);
    // XMU-860: no private/shared status in the story either
    expect(steps[1]).toBe("ben types invite in xmu and picks ana and mia from his team.");
    await close();
  });

  test("before the video ends the overlay is hidden", async () => {
    const { page, close } = await open();
    expect(await overlay(page).getAttribute("hidden")).not.toBeNull();
    expect(await overlay(page).isVisible()).toBe(false);
    await close();
  });

  test("when it ends: the real Join the waitlist button and Watch again over the last frame", async () => {
    const { page, errors, close } = await open();
    await playToEnd(page);
    await expect(overlay(page).isVisible()).resolves.toBe(true);
    const join = overlay(page).locator("a");
    expect([await join.getAttribute("href"), await join.getAttribute("class"), (await join.textContent())!.replace("→", "").trim()]).toEqual(["#waitlist", "btn lg", "Join the waitlist"]);
    expect(await overlay(page).getByRole("button", { name: "Watch again" }).isVisible()).toBe(true);
    // the overlay covers the video exactly, so the buttons sit over the last frame
    const [o, v] = await Promise.all([overlay(page).boundingBox(), video(page).boundingBox()]);
    expect([Math.round(o!.x), Math.round(o!.y), Math.round(o!.width), Math.round(o!.height)]).toEqual([Math.round(v!.x), Math.round(v!.y), Math.round(v!.width), Math.round(v!.height)]);
    expect(errors).toEqual([]);
    await close();
  });

  test("Watch again hides the overlay and plays from the start", async () => {
    const { page, close } = await open();
    await playToEnd(page);
    await overlay(page).getByRole("button", { name: "Watch again" }).click();
    await page.waitForFunction(() => !document.querySelector<HTMLVideoElement>("#demo video")!.paused);
    expect(await video(page).evaluate((v: HTMLVideoElement) => v.currentTime < 2)).toBe(true);
    expect(await overlay(page).getAttribute("hidden")).not.toBeNull();
    // focus goes back to the player, not lost on the hidden button
    expect(await page.evaluate(() => document.activeElement?.matches("#demo video"))).toBe(true);
    await close();
  });

  test("playing again from the browser's controls also hides the overlay", async () => {
    const { page, close } = await open();
    await playToEnd(page);
    await video(page).evaluate((v: HTMLVideoElement) => v.play());
    await page.waitForFunction(() => document.querySelector("#demo .demo-end")!.hasAttribute("hidden"));
    await close();
  });

  test("with reduced motion the overlay appears without moving", async () => {
    const { page, close } = await open({ reducedMotion: "reduce" });
    await playToEnd(page);
    const t = await overlay(page).evaluate((el) => [getComputedStyle(el).transitionDuration, getComputedStyle(el.querySelector(".demo-end-in")!).transform]);
    expect(t).toEqual(["0s", "none"]);
    await close();
  });

  test("while the overlay shows, the browser's controls step aside and focus moves to the waitlist button", async () => {
    const { page, close } = await open();
    await page.locator("#demo .demo-play").click();
    await playToEnd(page);
    await expect(overlay(page).isVisible()).resolves.toBe(true);
    // the controls would sit dimmed under the overlay, still taking Tab presses and blocking nothing visible
    expect(await video(page).evaluate((v: HTMLVideoElement) => v.controls)).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.matches("#demo .demo-end a"))).toBe(true);
    await overlay(page).getByRole("button", { name: "Watch again" }).click();
    await page.waitForFunction(() => !document.querySelector<HTMLVideoElement>("#demo video")!.paused);
    expect(await video(page).evaluate((v: HTMLVideoElement) => v.controls)).toBe(true);
    await close();
  });

  test("ending in fullscreen leaves fullscreen, so the overlay and its buttons can show", async () => {
    const { page, close } = await open();
    await page.locator("#demo .demo-play").click(); // focus on the player
    // a real click, so the page may go fullscreen like the player's own fullscreen button
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.id = "fs";
      b.textContent = "fs";
      b.onclick = () => document.querySelector<HTMLVideoElement>("#demo video")!.requestFullscreen();
      b.onmousedown = (e) => e.preventDefault(); // like the player's own button, it leaves focus on the video
      document.body.prepend(b);
    });
    await page.click("#fs");
    await page.waitForFunction(() => document.fullscreenElement?.matches("#demo video"), null, { timeout: 2000 });
    await playToEnd(page);
    await page.waitForFunction(() => document.fullscreenElement === null, null, { timeout: 2000 });
    expect(await overlay(page).isVisible()).toBe(true);
    // focus still lands on the waitlist button once fullscreen has let go of the page
    await page.waitForFunction(() => document.activeElement?.matches("#demo .demo-end a"), null, { timeout: 2000 });
    await close();
  });

  test("when it ends the page stays where the viewer scrolled", async () => {
    const { page, close } = await open();
    await page.locator("#demo .demo-play").click();
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
    const y = await page.evaluate(() => scrollY);
    await playToEnd(page);
    await expect(overlay(page).isVisible()).resolves.toBe(true);
    expect(await page.evaluate(() => scrollY)).toBe(y);
    await close();
  });

  test("when the overlay goes away with focus on it, focus goes back to the player", async () => {
    const { page, close } = await open();
    await page.locator("#demo .demo-play").click();
    await playToEnd(page);
    expect(await page.evaluate(() => document.activeElement?.matches("#demo .demo-end a"))).toBe(true);
    await video(page).evaluate((v: HTMLVideoElement) => { v.currentTime = 10; }); // a media key or the media hub seeks back
    await page.waitForFunction(() => document.querySelector("#demo .demo-end")!.hasAttribute("hidden"), null, { timeout: 2000 });
    expect(await page.evaluate(() => document.activeElement?.matches("#demo video"))).toBe(true);
    await close();
  });

  test("the finished overlay is a group named for screen readers", async () => {
    const { page, close } = await open();
    expect([await overlay(page).getAttribute("role"), await overlay(page).getAttribute("aria-label")]).toEqual(["group", "Demo finished"]);
    await close();
  });

  test("seeking back from the end hides the overlay", async () => {
    const { page, close } = await open();
    await playToEnd(page);
    await video(page).evaluate((v: HTMLVideoElement) => { v.currentTime = 10; });
    await page.waitForFunction(() => document.querySelector("#demo .demo-end")!.hasAttribute("hidden"), null, { timeout: 2000 });
    expect(await video(page).evaluate((v: HTMLVideoElement) => v.controls)).toBe(true);
    await close();
  });

  test("pausing before a slow video starts logs no error", async () => {
    const { page, errors, close } = await open();
    await page.route("**/assets/demo.webm", async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
    await page.getByRole("link", { name: "See demo" }).click();
    await video(page).evaluate((v: HTMLVideoElement) => v.pause());
    await page.waitForTimeout(300);
    expect(errors).toEqual([]);
    await close();
  });

  test("a modifier click on See demo (new tab) leaves this page's video alone", async () => {
    const { page, close } = await open();
    await page.getByRole("link", { name: "See demo" }).click({ modifiers: ["Shift"] });
    await page.waitForTimeout(200);
    expect(await video(page).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    await close();
  });

  test("in the light theme the overlay's button keeps its blue on hover", async () => {
    const { page, close } = await open({ colorScheme: "light" });
    const hover = await overlay(page).locator("a").evaluate((el) => getComputedStyle(el).getPropertyValue("--primary-hover").trim());
    expect(hover).toBe("#3A7DBA");
    await close();
  });

  test("on paper: no play button or shadow, and the text version prints open", async () => {
    const { page, close } = await open();
    await page.emulateMedia({ media: "print" });
    expect(await page.locator("#demo .demo-play").isVisible()).toBe(false);
    expect(await page.locator("#demo .demo-frame").evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
    expect(await page.locator("#demo details ol").isVisible()).toBe(true);
    await close();
  });

  test("on paper after the video ended, the overlay and its buttons don't print", async () => {
    const { page, close } = await open();
    await playToEnd(page);
    await page.emulateMedia({ media: "print" });
    expect(await overlay(page).isVisible()).toBe(false);
    await close();
  });

  test("without JavaScript the browser's own player works, with no play button or overlay", async () => {
    const { page, close } = await open({ javaScriptEnabled: false });
    expect(await video(page).evaluate((v: HTMLVideoElement) => v.controls)).toBe(true);
    expect(await page.locator("#demo .demo-play").isVisible()).toBe(false);
    expect(await overlay(page).isVisible()).toBe(false);
    await close();
  });

  test("on a phone the player fits the screen with no sideways scroll", async () => {
    const { page, close } = await open({ viewport: { width: 375, height: 812 } });
    const v = await video(page).boundingBox();
    expect(v!.x).toBeGreaterThanOrEqual(16);
    expect(v!.x + v!.width).toBeLessThanOrEqual(375 - 16);
    expect(Math.round((v!.width / v!.height) * 100) / 100).toBe(1.78);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
    await close();
  });
});
