// XMU-799 — hosting config (Vercel) and the launch check for placeholders (AC2).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allowedFormOrigins, cspAllows, deployedFile, findPlaceholders } from "../tools/launch-check.ts";

const SITE = join(import.meta.dir, "..");

describe("vercel.json", () => {
  const config = JSON.parse(readFileSync(join(SITE, "vercel.json"), "utf8"));
  const headers: Record<string, string> = Object.fromEntries(
    config.headers.find((h: { source: string }) => h.source === "/(.*)").headers.map(
      (h: { key: string; value: string }) => [h.key.toLowerCase(), h.value],
    ),
  );

  test("serves the folder as a static site with clean URLs", () => {
    expect(config.cleanUrls).toBe(true);
    expect(config.buildCommand ?? null).toBeNull();
  });

  test("content security policy allows only this site plus the form service", () => {
    const csp = headers["content-security-policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' https://formspree.io");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  test("basic security headers are set", () => {
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  test("test and tooling files are never served", () => {
    const ignore = readFileSync(join(SITE, ".vercelignore"), "utf8");
    // XMU-1011: Vercel serves the repo root, so the repo files (.github, .gitignore, LICENSE) are dropped too.
    const lines = ignore.split("\n").map((l) => l.trim());
    for (const p of ["tests", "tools", "node_modules", "package.json", "bun.lock", "DESIGN.md", ".github", ".gitignore", "LICENSE"]) {
      expect([p, lines.includes(p)]).toEqual([p, true]);
    }
  });
});

describe("launch check (no placeholder at launch)", () => {
  const OK_FORM = `<div id="waitlist"><form method="post" action="https://formspree.io/f/xyzabc12"></form></div>`;
  const opts = { exists: (_p: string) => true, allowedOrigins: { connect: ["https://formspree.io"], formAction: ["https://formspree.io"] } };
  const check = (html: string, o: Partial<typeof opts> = {}) => findPlaceholders(html, { ...opts, ...o });

  test("finds every element marked as a placeholder", async () => {
    const html = `<img data-placeholder="logo" src="x"><p>ok</p><video data-placeholder="demo video"></video>${OK_FORM}`;
    expect(await check(html)).toEqual(["logo", "demo video"]);
  });

  const markers: Array<[string, string]> = [
    ["single quotes", `<img data-placeholder='logo'>`],
    ["no value", `<img data-placeholder>`],
    ["spaces around =", `<img data-placeholder = "logo">`],
    ["upper case", `<img DATA-PLACEHOLDER="logo">`],
  ];
  test.each(markers)("still finds a placeholder written with %s", async (_name, html) => {
    expect(await check(`${html}${OK_FORM}`)).toHaveLength(1);
  });

  test("ignores anything inside HTML comments", async () => {
    expect(await check(`<!-- <img data-placeholder="old"> -->${OK_FORM}`)).toEqual([]);
    expect(await check(`<!-- ${OK_FORM} --><div id="waitlist"><form method="post" action="REPLACE_ME"></form></div>`)).toContain("waitlist form endpoint");
  });

  const endpoints = [
    `<div id="waitlist"><form method="post" action="REPLACE_ME"></form></div>`,
    `<div id="waitlist"><form method="post" action=""></form></div>`,
    `<div id="waitlist"><form method="post" action = 'http://formspree.io/f/abc'></form></div>`,
    `<div id="waitlist"><form method="post" action="https://REPLACE_ME"></form></div>`,
    `<div id="waitlist"><form method="post" action="https://formspree.io/f/REPLACE_ME"></form></div>`,
    `<div id="waitlist"><form method="post" action="https://formspree.io/f/"></form></div>`,
    `<div id="waitlist"><form method="post" action="https://formspree.com/f/abc123"></form></div>`,
    `<div id="waitlist"><form method="post" action="https://evil.example/f/abc123"></form></div>`,
    `<div id="waitlist"><form method="post"></form></div>`,
    ``,
  ];
  test.each(endpoints)("an unusable form endpoint blocks launch: %p", async (html) => {
    expect(await check(html)).toContain("waitlist form endpoint");
  });

  test("an endpoint the site's CSP would block is not launch-ready", async () => {
    expect(await check(OK_FORM, { allowedOrigins: { connect: ["https://example.com"], formAction: ["https://example.com"] } })).toContain("waitlist form endpoint");
  });

  test("a local file the page needs but that is missing blocks launch", async () => {
    const html = `${OK_FORM}<video poster="assets/p.jpg"><source src="assets/demo.mp4"></video>`;
    expect(await check(html, { exists: (p) => p !== "assets/demo.mp4" })).toEqual(["missing file assets/demo.mp4"]);
  });

  test("query strings, fragments and %-encoding are stripped before checking a file", async () => {
    const seen: string[] = [];
    await check(`${OK_FORM}<source src="assets/demo.mp4?v=2"><img src="assets/my%20logo.svg#x">`, {
      exists: (p) => (seen.push(p), true),
    });
    expect(seen.sort()).toEqual(["assets/demo.mp4", "assets/my logo.svg"]);
  });

  test("srcset and unquoted src are checked too", async () => {
    const html = `${OK_FORM}<img srcset="assets/a.png 1x, assets/b.png 2x" src=assets/c.png>`;
    expect((await check(html, { exists: () => false })).sort()).toEqual([
      "missing file assets/a.png",
      "missing file assets/b.png",
      "missing file assets/c.png",
    ]);
  });

  test("external links, in-page links and the form action are not treated as files", async () => {
    const html = `${OK_FORM}<a href="#demo"></a><a href="https://x.dev"></a><a href="mailto:a@b.co"></a><link href="styles.css">`;
    expect(await check(html, { exists: (p) => p === "styles.css" })).toEqual([]);
  });

  test("an extensionless link counts as found when its .html page exists (clean URLs)", async () => {
    expect(await check(`${OK_FORM}<a href="privacy">`, { exists: (p) => p === "privacy.html" })).toEqual([]);
  });

  test("every local file on a tag is checked, not only the first", async () => {
    const html = `${OK_FORM}<video poster="a.jpg" src="b.mp4"></video>`;
    expect((await check(html, { exists: () => false })).sort()).toEqual(["missing file a.jpg", "missing file b.mp4"]);
  });

  test("data-* look-alike attributes are not mistaken for the real ones", async () => {
    expect(await check(`<div id="waitlist"><form data-action="https://formspree.io/f/abc12345" action="REPLACE_ME"></form></div>`)).toContain(
      "waitlist form endpoint",
    );
    const seen: string[] = [];
    await check(`${OK_FORM}<img data-src="lazy.png" src="x.png">`, { exists: (p) => (seen.push(p), true) });
    expect(seen).toEqual(["x.png"]);
    expect(await check(`${OK_FORM}<p title="data-placeholder">hi</p>`)).toEqual([]);
  });

  test("only the waitlist form's action counts, not another form before it", async () => {
    const html = `<form action="/search"></form><section id="waitlist"><form method="post" action="https://formspree.io/f/abc12345"></form></section>`;
    expect(await check(html, { exists: () => true })).toEqual([]);
  });

  test("a path that climbs above the site root is clamped to the root, as browsers do", async () => {
    const seen: string[] = [];
    await check(`${OK_FORM}<img src="../../secret.png"><img src="/assets/../logo.svg"><img src="%2e%2e/x.png">`, { exists: (p) => (seen.push(p), true) });
    expect(seen).toEqual(["secret.png", "logo.svg", "x.png"]);
  });

  test("attribute values are decoded like a browser before looking up the file", async () => {
    const seen: string[] = [];
    await check(`${OK_FORM}<img src="a&amp;b.png"><img src="c&#38;d.png"><img src="e&#x26;f.png">`, { exists: (p) => (seen.push(p), true) });
    expect(seen).toEqual(["a&b.png", "c&d.png", "e&f.png"]);
    expect(await check(`<div id="waitlist"><form method="post" action="https://formspree.io/f/abc123?x=1&amp;y=2"></form></div>`)).toEqual([]);
  });

  test("backslashes are read as slashes, as browsers do", async () => {
    const seen: string[] = [];
    await check(`${OK_FORM}<img src="assets\\x.png"><img src="..\\y.png">`, { exists: (p) => (seen.push(p), true) });
    expect(seen).toEqual(["assets/x.png", "y.png"]);
  });

  test("a form inside <template> is inert and does not count as the waitlist form", async () => {
    const html = `<div id="waitlist"><template><form action="https://formspree.io/f/abc123"></form></template></div>`;
    expect(await check(html)).toContain("waitlist form endpoint");
  });

  test("<base href> is not a file, and a folder link finds its index.html or clean URL", async () => {
    expect(await check(`${OK_FORM}<base href="/sub/">`, { exists: () => false })).toEqual([]);
    expect(await check(`${OK_FORM}<a href="privacy/">`, { exists: (p) => p === "privacy.html" })).toEqual([]);
    expect(await check(`${OK_FORM}<a href="docs/">`, { exists: (p) => p === "docs/index.html" })).toEqual([]);
    expect(await check(`${OK_FORM}<a href="docs">`, { exists: (p) => p === "docs/index.html" })).toEqual([]);
    for (const home of ["./", "/", ".", "?x=1"]) {
      expect(await check(`${OK_FORM}<a href="${home}">`, { exists: (p) => p === "index.html" })).toEqual([]);
    }
  });

  test("relative files resolve against the first <base href>, as browsers do", async () => {
    const seen: string[] = [];
    await check(`${OK_FORM}<base href="/release/"><base href="/other/"><link href="styles.css"><img src="/logo.svg">`, {
      exists: (p) => (seen.push(p), true),
    });
    expect(seen).toEqual(["release/styles.css", "logo.svg"]);
    // A base on another host makes relative files external, so there's nothing local to check.
    expect(await check(`${OK_FORM}<base href="https://cdn.example/"><img src="x.png">`, { exists: () => false })).toEqual([]);
  });

  test("a <base href> the CSP's base-uri blocks is ignored, as browsers do", async () => {
    const seen: string[] = [];
    const strict = { connect: null, formAction: null, base: ["'self'"] };
    const found = await check(`${OK_FORM}<base href="https://cdn.example/"><img src="x.png">`, {
      exists: (p) => (seen.push(p), false),
      allowedOrigins: [opts.allowedOrigins, strict],
    });
    expect(seen).toEqual(["x.png"]);
    expect(found).toEqual(["missing file x.png"]);
    // A same-site base passes base-uri 'self' and is used.
    const seen2: string[] = [];
    await check(`${OK_FORM}<base href="/release/"><img src="x.png">`, { exists: (p) => (seen2.push(p), true), allowedOrigins: [opts.allowedOrigins, strict] });
    expect(seen2).toEqual(["release/x.png"]);
  });

  test("an external image, video or script the CSP would block blocks launch", async () => {
    const real = allowedFormOrigins(readFileSync(join(SITE, "vercel.json"), "utf8"));
    const html = `${OK_FORM}<video poster="https://cdn.example/p.jpg"><source src="https://cdn.example/demo.mp4"></video>
      <img srcset="https://cdn.example/a.png 2x"><img src="data:image/png;base64,AAAA"><script src="https://cdn.example/x.js"></script>
      <link rel="stylesheet" href="https://cdn.example/s.css"><link rel="icon" href="https://cdn.example/i.svg">
      <a href="https://github.com/xmu-labs"></a><link rel="canonical" href="https://xmu.dev/">`;
    expect((await check(html, { allowedOrigins: real })).sort()).toEqual(
      [
        "blocked by the site's CSP: https://cdn.example/a.png",
        "blocked by the site's CSP: https://cdn.example/demo.mp4",
        "blocked by the site's CSP: https://cdn.example/i.svg",
        "blocked by the site's CSP: https://cdn.example/p.jpg",
        "blocked by the site's CSP: https://cdn.example/s.css",
        "blocked by the site's CSP: https://cdn.example/x.js",
      ].sort(),
    );
    const cdn = allowedFormOrigins(vercelWith("default-src 'self' https://cdn.example; img-src https://cdn.example data:; connect-src https://formspree.io; form-action https://formspree.io"));
    expect(await check(html, { allowedOrigins: cdn })).toEqual([]);
  });

  test("srcset is split into candidates like a browser, so data: URLs with commas stay whole", async () => {
    const seen: string[] = [];
    const html = `${OK_FORM}<img srcset="data:image/svg+xml,%3Csvg%3E,x 1x, assets/logo.png 2x,assets/big.png 3x">`;
    expect(await check(html, { exists: (p) => (seen.push(p), true) })).toEqual([]);
    expect(seen).toEqual(["assets/logo.png", "assets/big.png"]);
  });

  test("a file Vercel won't upload (.vercelignore) counts as missing", async () => {
    const exists = deployedFile(SITE);
    expect(exists("styles.css")).toBe(true);
    expect(exists("README.md")).toBe(false);
    expect(exists("DESIGN.md")).toBe(false);
    expect(exists("tests/page.test.ts")).toBe(false);
    expect(exists("assets/README.md")).toBe(false);
    expect(exists("assets/brand/favicon-32.png")).toBe(true);
    expect(exists("assets")).toBe(false); // a folder isn't a file Vercel can serve
  });

  test("an encoded ../ never reaches files outside the site folder", async () => {
    const seen: string[] = [];
    const found = await check(`${OK_FORM}<img src="%2e%2e%2fCargo.toml"><img src="..%2Fpackage.json"><img src="a%2Fb.png">`, {
      exists: (p) => (seen.push(p), true),
    });
    expect(seen).toEqual(["a/b.png"]);
    expect(found).toEqual(["missing file ../Cargo.toml", "missing file ../package.json"]);
    expect(deployedFile(SITE)("../package.json")).toBe(false);
  });

  test("files Vercel serves itself under /_vercel/ (Web Analytics) are not missing files", async () => {
    const tag = `<script defer src="/_vercel/insights/script.js"></script>`;
    expect(await check(`${OK_FORM}${tag}`, { exists: () => false })).toEqual([]);
    expect(await check(`${OK_FORM}<script src="_vercel/insights/script.js"></script>`, { exists: () => false })).toEqual([]);
    // Only the analytics script itself: a misspelled path under /_vercel/ is a missing file.
    expect(await check(`${OK_FORM}<script src="/_vercel/insights/scirpt.js"></script>`, { exists: () => false })).toEqual([
      "missing file _vercel/insights/scirpt.js",
    ]);
    // Only that exact top-level folder: look-alikes are still checked.
    expect((await check(`${OK_FORM}<script src="/_vercelx/a.js"></script><script src="/assets/_vercel/b.js"></script>`, { exists: () => false })).sort()).toEqual([
      "missing file _vercelx/a.js",
      "missing file assets/_vercel/b.js",
    ]);
  });

  test("rel tokens split on any whitespace, like browsers (tab, newline)", async () => {
    const at = (src: string) => allowedFormOrigins(vercelWith(`default-src 'self'; connect-src ${src}; form-action ${src}`));
    const html = `${OK_FORM}<link rel="preload\tstylesheet" href="https://cdn.example/x.css"><link rel="icon\nfoo" href="missing.png">`;
    expect((await check(html, { allowedOrigins: at("https://formspree.io"), exists: () => false })).sort()).toEqual([
      "blocked by the site's CSP: https://cdn.example/x.css",
      "missing file missing.png",
    ]);
  });

  test("a finished page has none", async () => {
    expect(await check(`${OK_FORM}<img src="logo.svg" alt="xmu">`)).toEqual([]);
  });

  const cspSources: Array<[string, string]> = [
    ["trailing slash", "https://formspree.io/"],
    ["upper case host", "https://FORMSPREE.IO"],
    ["host only", "formspree.io"],
    ["scheme only", "https:"],
  ];
  const vercelWith = (csp: string) =>
    JSON.stringify({ headers: [{ source: "/(.*)", headers: [{ key: "Content-Security-Policy", value: csp }] }] });

  test.each(cspSources)("a CSP source written with %s still allows formspree", (_n, src) => {
    expect(cspAllows(allowedFormOrigins(vercelWith(`Connect-Src 'self' ${src}; form-action ${src}`)), "https://formspree.io")).toBe(true);
  });

  test("a CSP without formspree blocks it; a missing directive or no CSP at all does not", () => {
    expect(cspAllows(allowedFormOrigins(vercelWith("connect-src 'self'; form-action 'self'")), "https://formspree.io")).toBe(false);
    // As in browsers, *.formspree.io covers subdomains only, not formspree.io itself.
    expect(cspAllows(allowedFormOrigins(vercelWith("connect-src https://*.formspree.io; form-action https://*.formspree.io")), "https://formspree.io")).toBe(false);
    expect(cspAllows(allowedFormOrigins(vercelWith("connect-src https://*.formspree.io; form-action https://*.formspree.io")), "https://api.formspree.io")).toBe(true);
    expect(cspAllows(allowedFormOrigins(vercelWith("default-src 'self'; form-action https://formspree.io")), "https://formspree.io")).toBe(false);
    expect(cspAllows(allowedFormOrigins(vercelWith("connect-src https://formspree.io")), "https://formspree.io")).toBe(true);
    expect(cspAllows(allowedFormOrigins(JSON.stringify({})), "https://formspree.io")).toBe(true);
    expect(cspAllows(allowedFormOrigins(JSON.stringify({ headers: [{ source: "/(.*)" }] })), "https://formspree.io")).toBe(true);
  });

  test("a port the CSP source doesn't name is blocked, as browsers do", async () => {
    const plain = allowedFormOrigins(vercelWith("connect-src https://formspree.io; form-action https://formspree.io"));
    expect(cspAllows(plain, "https://formspree.io:8443")).toBe(false);
    expect(cspAllows(plain, "https://formspree.io:443")).toBe(true);
    const ported = allowedFormOrigins(vercelWith("connect-src https://formspree.io:8443; form-action https://formspree.io:*"));
    expect(cspAllows(ported, "https://formspree.io:8443")).toBe(true);
    expect(await check(`<div id="waitlist"><form action="https://formspree.io:8443/f/abc123"></form></div>`)).toContain("waitlist form endpoint");
  });

  test("a repeated directive counts only the first time, as browsers do", () => {
    const csp = vercelWith("connect-src 'none'; connect-src https://formspree.io; form-action https://formspree.io");
    expect(cspAllows(allowedFormOrigins(csp), "https://formspree.io")).toBe(false);
  });

  test("two CSP headers must both allow the form service", () => {
    const two = JSON.stringify({
      headers: [
        { source: "/(.*)", headers: [{ key: "Content-Security-Policy", value: "connect-src https://formspree.io; form-action https://formspree.io" }] },
        { source: "/(.*)", headers: [{ key: "content-security-policy", value: "connect-src 'self'" }] },
      ],
    });
    expect(cspAllows(allowedFormOrigins(two), "https://formspree.io")).toBe(false);
  });

  test("http:// and https://* sources allow an https endpoint, as CSP3 browsers do", () => {
    for (const src of ["http://formspree.io", "https://*"]) {
      expect(cspAllows(allowedFormOrigins(vercelWith(`connect-src ${src}; form-action ${src}`)), "https://formspree.io")).toBe(true);
    }
  });

  test("a CSP source with a path only allows endpoints under that path", async () => {
    const at = (src: string) => allowedFormOrigins(vercelWith(`connect-src ${src}; form-action ${src}`));
    expect(cspAllows(at("https://formspree.io/allowed/"), "https://formspree.io/f/abc123")).toBe(false);
    expect(cspAllows(at("https://formspree.io/f/"), "https://formspree.io/f/abc123")).toBe(true);
    expect(cspAllows(at("https://formspree.io/f/abc123"), "https://formspree.io/f/abc123")).toBe(true);
    expect(cspAllows(at("https://formspree.io/f/abc"), "https://formspree.io/f/abc123")).toBe(false);
    expect(cspAllows(at("https://formspree.io/"), "https://formspree.io/f/abc123")).toBe(true);
    const form = `<div id="waitlist"><form action="https://formspree.io/f/abc123"></form></div>`;
    expect(await check(form, { allowedOrigins: at("https://formspree.io/allowed/") })).toContain("waitlist form endpoint");
  });

  test("an omitted port matches only the endpoint's own default port, even for an http:// source", () => {
    const at = (src: string) => allowedFormOrigins(vercelWith(`connect-src ${src}; form-action ${src}`));
    expect(cspAllows(at("http://formspree.io"), "https://formspree.io:80/f/abc123")).toBe(false);
    expect(cspAllows(at("http://formspree.io"), "https://formspree.io/f/abc123")).toBe(true);
  });

  test("an http source naming port 80 also allows the https upgrade to 443 (CSP3)", () => {
    const at = (src: string) => allowedFormOrigins(vercelWith(`connect-src ${src}; form-action ${src}`));
    expect(cspAllows(at("http://formspree.io:80"), "https://formspree.io/f/abc123")).toBe(true);
    expect(cspAllows(at("http://formspree.io:80"), "https://formspree.io:8443/f/abc123")).toBe(false);
    // Only the http-to-https upgrade: an https source on 80 still means port 80.
    expect(cspAllows(at("https://formspree.io:80"), "https://formspree.io/f/abc123")).toBe(false);
  });

  test("a form endpoint with a user name or password is not usable (fetch rejects it)", async () => {
    for (const action of ["https://user:pass@formspree.io/f/abc123", "https://user@formspree.io/f/abc123", "https://:pass@formspree.io/f/abc123"]) {
      expect(await check(`<div id="waitlist"><form action="${action}"></form></div>`)).toContain("waitlist form endpoint");
    }
  });

  test("CSP paths are case-sensitive; scheme and host are not", () => {
    const at = (src: string) => allowedFormOrigins(vercelWith(`connect-src ${src}; form-action ${src}`));
    expect(cspAllows(at("https://formspree.io/f/ABC123"), "https://formspree.io/f/abc123")).toBe(false);
    expect(cspAllows(at("HTTPS://FormSpree.IO/f/abc123"), "https://formspree.io/f/abc123")).toBe(true);
    expect(cspAllows(at("https://formspree.io/F/"), "https://formspree.io/f/abc123")).toBe(false);
  });

  test("only CSP header blocks whose source matches the page apply to it", () => {
    const blocks = (...b: Array<[string, string]>) =>
      JSON.stringify({ headers: b.map(([source, value]) => ({ source, headers: [{ key: "Content-Security-Policy", value }] })) });
    const ok = "connect-src https://formspree.io; form-action https://formspree.io";
    expect(cspAllows(allowedFormOrigins(blocks(["/(.*)", ok], ["/assets/(.*)", "connect-src 'none'"])), "https://formspree.io/f/a")).toBe(true);
    expect(cspAllows(allowedFormOrigins(blocks(["/(.*)", ok], ["/:path*", "connect-src 'none'"])), "https://formspree.io/f/a")).toBe(false);
    expect(cspAllows(allowedFormOrigins(blocks(["/", ok], ["/index.html", "connect-src 'none'"])), "https://formspree.io/f/a")).toBe(true);
    expect(cspAllows(allowedFormOrigins(blocks(["/(.*)", "connect-src 'none'"])), "https://formspree.io/f/a")).toBe(false);
    // A param with its own pattern, as in the Vercel docs: "/:path(.*)" matches "/" too.
    for (const src of ["/:path(.*)", "/:path((?!uk/).*)", "/:path(.*)?"]) {
      expect(cspAllows(allowedFormOrigins(blocks(["/(.*)", ok], [src, "connect-src 'none'"])), "https://formspree.io/f/a")).toBe(false);
    }
    expect(cspAllows(allowedFormOrigins(blocks(["/(.*)", ok], ["/:lang(en|es)", "connect-src 'none'"])), "https://formspree.io/f/a")).toBe(true);
  });

  test("allowed origins are read from vercel.json connect-src and form-action", async () => {
    expect(cspAllows(allowedFormOrigins(readFileSync(join(SITE, "vercel.json"), "utf8")), "https://formspree.io")).toBe(true);
    expect(cspAllows(allowedFormOrigins(readFileSync(join(SITE, "vercel.json"), "utf8")), "https://evil.example")).toBe(false);
  });

  test("the real page has no placeholder left to fill", async () => {
    const found = await findPlaceholders(readFileSync(join(SITE, "index.html"), "utf8"), {
      exists: deployedFile(SITE),
      allowedOrigins: allowedFormOrigins(readFileSync(join(SITE, "vercel.json"), "utf8")),
    });
    // Logo and favicon are real since XMU-814, the demo video since XMU-830, the waitlist posts
    // to the xmu Formspree form (XMU-849), and the linkless "Book a call" button went in XMU-859.
    expect(found).toEqual([]);
  });

  test("the waitlist posts to a real Formspree form, not a placeholder", () => {
    const action = readFileSync(join(SITE, "index.html"), "utf8").match(/<form class="step1"[^>]*\saction="([^"]*)"/)?.[1];
    expect(action).toMatch(/^https:\/\/formspree\.io\/f\/[A-Za-z0-9]+$/);
    expect(action).not.toMatch(/REPLACE|placeholder|test/i);
  });

  test("the demo placeholders are gone until the real video exists", () => {
    for (const f of ["assets/demo-poster.svg", "assets/demo.vtt"]) expect(existsSync(join(SITE, f))).toBe(false);
  });

  test("the analytics path is matched as sent: an encoded /_vercel%2F... is a missing file", async () => {
    expect(await check(`${OK_FORM}<script src="/_vercel%2Finsights%2Fscript.js"></script>`, { exists: () => false })).toEqual([
      "missing file _vercel/insights/script.js",
    ]);
  });

  test("CSP ports compare as numbers, and a scheme-less source on :80 allows the https upgrade", () => {
    const at = (src: string) => allowedFormOrigins(vercelWith(`connect-src ${src}; form-action ${src}`));
    expect(cspAllows(at("http://formspree.io:080"), "http://formspree.io/f/abc123")).toBe(true);
    expect(cspAllows(at("http://formspree.io:080"), "https://formspree.io/f/abc123")).toBe(true);
    expect(cspAllows(at("https://formspree.io:0443"), "https://formspree.io/f/abc123")).toBe(true);
    expect(cspAllows(at("formspree.io:80"), "https://formspree.io/f/abc123")).toBe(true);
    expect(cspAllows(at("formspree.io:80"), "https://formspree.io:8443/f/abc123")).toBe(false);
    expect(cspAllows(at("https://formspree.io:80"), "https://formspree.io/f/abc123")).toBe(false);
  });

  test("the waitlist form must post (a GET would put the email in the address bar)", async () => {
    const form = (attrs: string) => `<div id="waitlist"><form ${attrs} action="https://formspree.io/f/abc123"></form></div>`;
    expect(await check(form(""))).toEqual(["waitlist form method"]);
    expect(await check(form(`method="get"`))).toEqual(["waitlist form method"]);
    expect(await check(form(`method="dialog"`))).toEqual(["waitlist form method"]);
    expect(await check(form(`METHOD="POST"`))).toEqual([]);
    expect(await check(form(`method=" Post "`))).toEqual([]);
  });

  describe("files the linked stylesheets point at (url(...))", () => {
    const linked = (href = "styles.css") => `${OK_FORM}<link rel="stylesheet" href="${href}">`;
    const css = `/* url(commented.png) */
      @font-face { font-family: X; src: url(assets/fonts/x.woff2) format("woff2"), url('assets/fonts/x.woff') format("woff"); }
      .a { background: url("img/a.png?v=1#frag"); }
      .b { background: url(data:image/png;base64,AAAA); mask: url(#clip); }`;

    test("a missing font or image a stylesheet needs blocks launch; data:, #fragment and comments do not", async () => {
      const seen: string[] = [];
      const found = await check(linked(), {
        exists: (p) => (seen.push(p), p !== "img/a.png" && p !== "assets/fonts/x.woff"),
        readFile: (p) => (p === "styles.css" ? css : null),
      });
      expect(found).toEqual(["missing file assets/fonts/x.woff", "missing file img/a.png"]);
      expect(seen).not.toContain("commented.png");
    });

    test("url()s resolve against the stylesheet's own folder", async () => {
      const seen: string[] = [];
      await check(linked("css/site.css"), {
        exists: (p) => (seen.push(p), true),
        readFile: (p) => (p === "css/site.css" ? `.a { background: url(../img/a.png) } .b { background: url(b.png) }` : null),
      });
      expect(seen).toEqual(["css/site.css", "img/a.png", "css/b.png"]);
    });

    test("off-site url()s must pass the CSP: font-src for @font-face, img-src for the rest", async () => {
      const remote = `@font-face { src: url(https://fonts.example/x.woff2) } .a { background: url(https://img.example/a.png) }`;
      const found = await check(linked(), {
        readFile: () => remote,
        allowedOrigins: { connect: null, formAction: null, font: ["'self'"], img: ["https://fonts.example"] },
      });
      expect(found).toEqual(["blocked by the site's CSP: https://fonts.example/x.woff2", "blocked by the site's CSP: https://img.example/a.png"]);
    });

    test("the real stylesheet's fonts are all in the site folder", async () => {
      const found = await findPlaceholders(`${OK_FORM}<link rel="stylesheet" href="styles.css">`, {
        exists: deployedFile(SITE),
        allowedOrigins: allowedFormOrigins(readFileSync(join(SITE, "vercel.json"), "utf8")),
        readFile: (p) => readFileSync(join(SITE, p), "utf8"),
      });
      expect(found).toEqual([]);
    });
  });

  test("a local file the CSP blocks for its kind blocks launch, like an off-site one", async () => {
    const found = await check(`${OK_FORM}<script type="module" src="waitlist.js"></script><img src="a.png">`, {
      allowedOrigins: { connect: null, formAction: null, script: ["'none'"], img: ["'self'"] },
    });
    expect(found).toEqual(["blocked by the site's CSP: waitlist.js"]);
  });

  test("a preload is checked against the CSP for what it loads (its as=)", async () => {
    const csp = vercelWith("default-src 'self'; img-src 'self' https://img.example; connect-src https://formspree.io; form-action https://formspree.io");
    const found = await check(
      `${OK_FORM}<link rel="preload" as="font" href="https://fonts.example/x.woff2" crossorigin><link rel="preload" as="image" href="https://img.example/a.png"><link rel="preload" as="script" href="https://cdn.example/a.js"><link rel="preload" as="style" href="https://cdn.example/a.css">`,
      { allowedOrigins: allowedFormOrigins(csp) },
    );
    expect(found).toEqual([
      "blocked by the site's CSP: https://fonts.example/x.woff2",
      "blocked by the site's CSP: https://cdn.example/a.js",
      "blocked by the site's CSP: https://cdn.example/a.css",
    ]);
    const fonts = allowedFormOrigins(vercelWith("default-src 'self'; font-src https://fonts.example; connect-src https://formspree.io; form-action https://formspree.io"));
    expect(await check(`${OK_FORM}<link rel="preload" as="font" href="https://fonts.example/x.woff2">`, { allowedOrigins: fonts })).toEqual([]);
  });

  test("clean URLs apply to links only: a fetched file needs its exact name", async () => {
    const exists = (p: string) => p === "logo.html" || p === "privacy.html" || p === "img/index.html";
    expect(await check(`${OK_FORM}<a href="privacy">p</a><img src="logo"><img src="img/">`, { exists })).toEqual([
      "missing file logo",
      "missing file img/",
    ]);
  });

  test("a <base href> inside <template> is inert and ignored", async () => {
    const seen: string[] = [];
    await check(`${OK_FORM}<template><base href="/other/"></template><img src="a.png">`, { exists: (p) => (seen.push(p), true) });
    expect(seen).toEqual(["a.png"]);
  });

  test("anything inside a <template> is inert: no placeholder, no file to check", async () => {
    expect(await check(`${OK_FORM}<template><img src="missing.png" data-placeholder="x"></template>`, { exists: (p) => p !== "missing.png" })).toEqual([]);
  });

  test("an absolute URL on the canonical origin (default https://xmu.sh) is a local, same-origin file", async () => {
    const self = { connect: null, formAction: null, img: ["'self'"] };
    const img = `${OK_FORM}<img src="https://xmu.sh/assets/og.png">`;
    const seen: string[] = [];
    expect(await check(img, { exists: (p) => (seen.push(p), true), allowedOrigins: self })).toEqual([]);
    expect(seen).toEqual(["assets/og.png"]);
    expect(await check(img, { exists: (p) => p !== "assets/og.png", allowedOrigins: self })).toEqual(["missing file assets/og.png"]);
  });

  test("the page's <link rel=canonical> names its origin", async () => {
    const html = `${OK_FORM}<link rel="canonical" href="https://xmu.example/"><img src="https://xmu.example/a.png"><img src="https://xmu.sh/b.png">`;
    const found = await check(html, { exists: (p) => p !== "a.png", allowedOrigins: { connect: null, formAction: null, img: ["'self'"] } });
    expect(found).toEqual(["missing file a.png", "blocked by the site's CSP: https://xmu.sh/b.png"]);
  });

  test("a canonical with a path names only the origin: relative files still resolve from the site root", async () => {
    const seen: string[] = [];
    await check(`${OK_FORM}<link rel="canonical" href="https://xmu.sh/landing/"><img src="assets/a.png">`, { exists: (p) => (seen.push(p), true) });
    expect(seen).toEqual(["landing/index.html", "assets/a.png"]);
  });

  test("a declarative shadow root <template shadowrootmode> is rendered, so its contents are checked", async () => {
    for (const attr of [`shadowrootmode="open"`, `shadowrootmode="CLOSED"`]) {
      const html = `${OK_FORM}<div><template ${attr}><img src="missing.png" data-placeholder="logo"></template></div>`;
      expect([attr, await check(html, { exists: (p) => p !== "missing.png" })]).toEqual([attr, ["logo", "missing file missing.png"]]);
    }
    // Browsers render only open or closed; an unknown value and the retired shadowroot stay inert.
    for (const attr of [`shadowrootmode="bogus"`, `shadowroot="open"`]) {
      const html = `${OK_FORM}<div><template ${attr}><img src="missing.png" data-placeholder="logo"></template></div>`;
      expect([attr, await check(html, { exists: (p) => p !== "missing.png" })]).toEqual([attr, []]);
    }
  });

  describe("stylesheets a stylesheet imports (@import)", () => {
    const linked = `${OK_FORM}<link rel="stylesheet" href="styles.css">`;
    test("a missing import blocks launch, and an imported sheet's url()s are checked", async () => {
      const sheets: Record<string, string> = {
        "styles.css": `@import "css/a.css"; @import url("gone.css"); .x { background: url(s.png) }`,
        "css/a.css": `.y { background: url(y.png) }`,
      };
      const seen: string[] = [];
      const found = await check(linked, { exists: (p) => (seen.push(p), p !== "gone.css" && p !== "css/y.png"), readFile: (p) => sheets[p] ?? null });
      expect(found.sort()).toEqual(["missing file css/y.png", "missing file gone.css"]);
      expect(seen).toContain("s.png");
    });

    test("an import is a stylesheet for the CSP (style-src), not an image", async () => {
      const css = `@import "https://cdn.example/x.css"; @import url(https://cdn.example/y.css);`;
      expect(await check(linked, { readFile: () => css, allowedOrigins: { connect: null, formAction: null, style: null, img: ["'none'"] } })).toEqual([]);
      expect(await check(linked, { readFile: (p) => (p === "styles.css" ? css : null), allowedOrigins: { connect: null, formAction: null, style: ["'self'"], img: null } })).toEqual([
        "blocked by the site's CSP: https://cdn.example/x.css",
        "blocked by the site's CSP: https://cdn.example/y.css",
      ]);
    });

    test("an import with no space before its quote is still found; @imports is another at-rule", async () => {
      const css = `@import"a.css"; @import'b.css'; @imports "c.css"; @importurl(d.css); @import-x url(e.css);`;
      const read: string[] = [];
      await check(linked, { exists: () => true, readFile: (p) => (read.push(p), p === "styles.css" ? css : null) });
      // Only real imports are read as stylesheets; @importurl and @import-x are other at-rules.
      expect(read).toEqual(["styles.css", "a.css", "b.css"]);
    });

    test("an import cycle does not hang", async () => {
      const sheets: Record<string, string> = { "styles.css": `@import "b.css";`, "b.css": `@import url(styles.css); .b { background: url(gone.png) }` };
      expect(await check(linked, { exists: (p) => p !== "gone.png", readFile: (p) => sheets[p] ?? null })).toEqual(["missing file gone.png"]);
    });
  });

  test("a fetched file with an empty or malformed URL blocks launch; empty and #links do not", async () => {
    const found = await check(`${OK_FORM}<img src="http://["><img src=""><video poster=" "></video><a href="">x</a><a href="#">y</a><a href="http://[">z</a>`);
    expect(found).toEqual(['invalid file reference "http://["', 'invalid file reference ""', 'invalid file reference " "']);
  });
});
