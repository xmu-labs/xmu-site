// XMU-799 · AC2 — lists what still blocks launch: elements marked data-placeholder, a
// waitlist form that doesn't post to a real Formspree form the site's CSP allows, local
// files the page (or its stylesheets' url()s) points at that Vercel won't serve, and files
// the CSP would block. Exits 1 while anything is left:
//   bun run launch-check
// Parses with Bun's HTMLRewriter (a real HTML parser), so comments, attribute case, quoting
// and look-alike names such as data-src are handled the way a browser handles them.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORMSPREE_FORM = /^\/f\/[A-Za-z0-9]+$/;
const DEFAULT_PORT: Record<string, number> = { "https:": 443, "http:": 80 };

// One Content-Security-Policy, per kind of request. null or missing = not restricted.
export interface AllowedOrigins {
  connect: string[] | null;
  formAction: string[] | null;
  img?: string[] | null;
  media?: string[] | null;
  style?: string[] | null;
  script?: string[] | null;
  font?: string[] | null;
  base?: string[] | null;
}
type Kind = "img" | "media" | "style" | "script" | "font";

export interface CheckOptions {
  exists: (path: string) => boolean;
  // Every CSP the site sends; a request must pass all of them.
  allowedOrigins: AllowedOrigins | AllowedOrigins[];
  // A linked stylesheet's text, to check its url()s; null (or no readFile) skips it.
  readFile?: (path: string) => string | null;
}

// Does one CSP source expression allow this URL (e.g. "https://formspree.io/f/abc")?
// self is the page's own origin, for 'self'.
function sourceMatches(source: string, origin: URL, self: string): boolean {
  // Scheme and host are case-insensitive; the path is not (CSP path-part matching).
  const s = source.replace(/^[^/]*(\/\/[^/]*)?/, (lead) => lead.toLowerCase());
  if (s === "*") return origin.protocol === "https:" || origin.protocol === "http:";
  if (/^[a-z][a-z0-9+.-]*:$/.test(s)) return origin.protocol === s || (s === "http:" && origin.protocol === "https:");
  if (s === "'self'") return origin.origin === self;
  if (s.startsWith("'")) return false; // 'none', nonces and hashes never name a URL
  const m = s.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.|\*)?([a-z0-9.-]*)(?::(\d+|\*))?(\/.*)?$/);
  if (!m) return false;
  const [, scheme, wildcard, host, port, path] = m;
  // CSP3: an http source also allows the same host over https.
  const schemeOk = scheme ? origin.protocol === `${scheme}:` || (scheme === "http" && origin.protocol === "https:") : origin.protocol === "https:";
  if (!schemeOk) return false;
  // URL drops a scheme's default port, so origin.port is "" for :443 on https.
  const defaultPort = DEFAULT_PORT[origin.protocol];
  const originPort = origin.port ? Number(origin.port) : defaultPort;
  // Ports compare as numbers (":080" is 80). An omitted port matches only the endpoint's own
  // default port, even for an http:// source.
  // CSP3: an http or scheme-less source on :80 also allows the https upgrade to :443.
  const sourcePort = port === undefined || port === "*" ? port : Number(port);
  const upgraded = scheme !== "https" && origin.protocol === "https:" && sourcePort === 80 && originPort === 443;
  if (sourcePort !== undefined ? sourcePort !== "*" && sourcePort !== originPort && !upgraded : originPort !== defaultPort) return false;
  // CSP path-part: "/f/" allows everything under it, "/f/abc" only that exact path.
  if (path && path !== "/" && !(path.endsWith("/") ? origin.pathname.startsWith(path) : origin.pathname === path)) return false;
  if (wildcard === "*") return host === "";
  if (host === "") return false;
  return wildcard ? origin.hostname.endsWith(`.${host}`) : origin.hostname === host;
}

const listAllows = (list: string[] | null | undefined, url: URL, self: string) => list == null || list.some((s) => sourceMatches(s, url, self));

export function cspAllows(allowed: AllowedOrigins | AllowedOrigins[], endpoint: string, self = CANONICAL.origin): boolean {
  const url = new URL(endpoint);
  return [allowed].flat().every((p) => listAllows(p.connect, url, self) && listAllows(p.formAction, url, self));
}

function cspAllowsKind(allowed: AllowedOrigins | AllowedOrigins[], kind: Kind | "base", url: URL, self: string): boolean {
  return [allowed].flat().every((p) => listAllows(p[kind], url, self));
}

// What each deployed CSP lets the form reach: connect-src (the script's fetch, falling back to
// default-src) and form-action (the no-JS post, which has no fallback). Only header blocks whose
// source matches the landing page ("/") apply, as on Vercel.
export function allowedFormOrigins(vercelJson: string): AllowedOrigins[] {
  const headers: Array<{ key: string; value: string }> = (JSON.parse(vercelJson).headers ?? [])
    .filter((h: { source?: string }) => sourceMatchesPage(h.source ?? "/(.*)", "/"))
    .flatMap((h: { headers?: Array<{ key: string; value: string }> }) => h.headers ?? []);
  return headers
    .filter((h) => h.key.toLowerCase() === "content-security-policy")
    .map((h) => {
      const directives = new Map<string, string[]>();
      for (const d of h.value.split(";")) {
        const [name, ...sources] = d.trim().split(/\s+/);
        // Browsers ignore a directive that repeats; the first one wins.
        if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
      }
      // Fetch directives fall back to default-src; form-action and base-uri don't.
      const fetch = (name: string) => directives.get(name) ?? directives.get("default-src") ?? null;
      return {
        connect: fetch("connect-src"),
        formAction: directives.get("form-action") ?? null,
        img: fetch("img-src"),
        media: fetch("media-src"),
        style: fetch("style-src"),
        script: fetch("script-src"),
        font: fetch("font-src"),
        base: directives.get("base-uri") ?? null,
      };
    });
}

// Vercel header sources use path-to-regexp: "(...)" is a regex group, ":name" one segment,
// ":name(...)" a param with its own pattern, and a trailing *, + or ? repeats or makes it optional.
// A pattern this can't read is assumed to apply (fails closed).
function sourceMatchesPage(source: unknown, page: string): boolean {
  if (typeof source !== "string") return true;
  const group = (i: number): number => {
    let depth = 0;
    for (let j = i; j < source.length; j++) {
      if (source[j] === "(") depth++;
      else if (source[j] === ")" && --depth === 0) return j;
    }
    return -1;
  };
  let re = "";
  for (let i = 0; i < source.length; ) {
    let piece: string;
    if (source[i] === "(") {
      const end = group(i);
      if (end < 0) return true;
      piece = `(?:${source.slice(i + 1, end)})`;
      i = end + 1;
    } else if (source[i] === ":") {
      const name = source.slice(i).match(/^:\w+/);
      if (!name) return true;
      i += name[0].length;
      piece = "[^/]+";
      if (source[i] === "(") {
        const end = group(i);
        if (end < 0) return true;
        piece = `(?:${source.slice(i + 1, end)})`;
        i = end + 1;
      }
    } else {
      re += source[i].replace(/[.*+?^${}|[\]\\]/g, "\\$&");
      i++;
      continue;
    }
    const mod = source[i];
    if (mod === "*" || mod === "+" || mod === "?") {
      i++;
      // "/:path*" also matches "/" itself, so the slash before it becomes optional.
      if (re.endsWith("/") && mod !== "+") re = `${re.slice(0, -1)}(?:/${piece}${mod === "*" ? "(?:/" + piece + ")*" : ""})?`;
      else re += mod === "+" ? `${piece}(?:/${piece})*` : `(?:${piece})${mod}`;
    } else {
      re += piece;
    }
  }
  try {
    return new RegExp(`^${re}/?$`).test(page);
  } catch {
    return true;
  }
}

// The few entities that show up in URLs; HTMLRewriter hands back attribute text undecoded.
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? whole;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function usableAction(action: string | null, allowed: AllowedOrigins | AllowedOrigins[], self: string): boolean {
  if (!action || /replace_me/i.test(action)) return false;
  try {
    const url = new URL(action.trim());
    // fetch() throws on a URL carrying a user name or password, so every signup would fail.
    if (url.username || url.password) return false;
    return url.protocol === "https:" && url.hostname === "formspree.io" && FORMSPREE_FORM.test(url.pathname) && cspAllows(allowed, url.href, self);
  } catch {
    return false;
  }
}

// The page as the browser sees it: at the root of its <link rel=canonical>'s origin, else of the
// site's canonical address. A URL on that origin (relative or absolute) is a local file; any other
// origin isn't. Only the origin counts: the checked file is served from the site root.
const CANONICAL = new URL("https://xmu.sh/");

function pageUrl(canonical: string | undefined): URL {
  try {
    const url = new URL((canonical ?? "").trim());
    if (url.protocol === "https:" || url.protocol === "http:") return new URL("/", url);
  } catch {
    // not an absolute URL: fall back to the site's canonical address
  }
  return CANONICAL;
}

function resolve(ref: string, base: URL): URL | null {
  const trimmed = ref.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  try {
    return new URL(trimmed, base);
  } catch {
    return null;
  }
}

// The site-relative path a browser would request for url, or null when it isn't on this site.
// URL resolution does what browsers do: \ becomes /, ../ stops at the root, %2e%2e is a dot-dot.
function localPath(url: URL, page: URL): string | null {
  if (url.origin !== page.origin) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).slice(1);
  } catch {
    path = url.pathname.slice(1);
  }
  // An encoded ../ (%2e%2e%2f) survives URL parsing; Vercel never serves above the site root.
  return path.split("/").includes("..") ? `\0${path}` : path;
}

// HTML srcset candidates: a URL runs to whitespace (a trailing comma ends it), then descriptors
// run to the next comma. So a data: URL keeps its commas, like in browsers.
function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i++;
    let j = i;
    while (j < value.length && !/\s/.test(value[j])) j++;
    let url = value.slice(i, j);
    const endedByComma = url.endsWith(",");
    url = url.replace(/,+$/, "");
    if (url) urls.push(url);
    i = j;
    if (!endedByComma) {
      while (i < value.length && value[i] !== ",") i++;
    }
  }
  return urls;
}

// Vercel serves the Web Analytics script itself, so it is never in the site folder. Only that
// exact path, as sent (an encoded /_vercel%2F... is another path): anything else under /_vercel/
// (a typo) is a missing file. Vercel serves it only once Web Analytics is on, which this check
// can't see, so the ready message reminds you.
const ANALYTICS_SCRIPT = "/_vercel/insights/script.js";
function servedByVercel(url: URL, page: URL): boolean {
  return url.origin === page.origin && url.pathname === ANALYTICS_SCRIPT;
}

// Vercel cleanUrls: "privacy" and "privacy/" are served from privacy.html; "docs" and "docs/" from docs/index.html.
// Only links get that: a fetched file (image, script, font...) needs its exact name.
function served(path: string, exists: (p: string) => boolean, kind: Kind | null): boolean {
  if (kind) return exists(path);
  if (path === "") return exists("index.html");
  if (path.endsWith("/")) return exists(`${path}index.html`) || exists(`${path.slice(0, -1)}.html`);
  return exists(path) || (!/\.[a-z0-9]+$/i.test(path) && (exists(`${path}.html`) || exists(`${path}/index.html`)));
}

export async function findPlaceholders(html: string, { exists, allowedOrigins, readFile }: CheckOptions): Promise<string[]> {
  const found: string[] = [];
  // Each reference with the CSP directive that governs fetching it (null = a link, not fetched).
  const refs: Array<{ ref: string; kind: Kind | null }> = [];
  let action: string | null | undefined;
  let method = "";
  let inTemplate = 0;
  let baseHref: string | undefined;
  let canonical: string | undefined;

  await new HTMLRewriter()
    .on("template", {
      element(el) {
        // A declarative shadow root (<template shadowrootmode="open|closed">) is rendered, so its
        // content is checked like the rest of the page. Other values, and the retired shadowroot, stay inert.
        if (/^(open|closed)$/i.test(el.getAttribute("shadowrootmode") ?? "")) return;
        inTemplate++;
        el.onEndTag(() => {
          inTemplate--;
        });
      },
    })
    .on("*", {
      element(el) {
        if (el.tagName === "base") {
          // <base href> sets the URL base (the first one wins); it isn't a file. One inside a
          // <template> is inert.
          const href = el.getAttribute("href");
          if (href !== null && baseHref === undefined && inTemplate === 0) baseHref = decodeEntities(href);
          return;
        }
        // A <template>'s content is inert: nothing in it is shown or fetched.
        if (inTemplate > 0) return;
        const tag = el.tagName;
        // rel is a set of tokens split on any ASCII whitespace (tabs and newlines too), as in browsers.
        const rel = ` ${(el.getAttribute("rel") ?? "").toLowerCase().split(/[\t\n\f\r ]+/).join(" ")} `;
        if (tag === "link" && rel.includes(" canonical ") && canonical === undefined) canonical = decodeEntities(el.getAttribute("href") ?? "");
        for (const [rawName, raw] of el.attributes) {
          const name = rawName.toLowerCase();
          const value = decodeEntities(raw);
          if (name === "data-placeholder") found.push(value || "unnamed placeholder");
          else if (name === "srcset") refs.push(...srcsetUrls(value).map((ref) => ({ ref, kind: "img" as const })));
          else if (name === "poster") refs.push({ ref: value, kind: "img" });
          else if (name === "src") {
            const kind: Kind | null =
              tag === "script" ? "script" : ["video", "audio", "source", "track"].includes(tag) ? "media" : tag === "img" || tag === "input" ? "img" : null;
            refs.push({ ref: value, kind });
          } else if (name === "href") {
            const as = (el.getAttribute("as") ?? "").trim().toLowerCase();
            const kind: Kind | null =
              tag !== "link"
                ? null
                : rel.includes(" stylesheet ")
                  ? "style"
                  : rel.includes(" icon ") || rel.includes(" apple-touch-icon ")
                    ? "img"
                    : rel.includes(" preload ")
                      ? (PRELOAD_KIND[as] ?? null)
                      : null;
            refs.push({ ref: value, kind });
          }
        }
      },
    })
    .on("#waitlist form", {
      element(el) {
        // A <template>'s content is inert, so a form inside one isn't the live waitlist form.
        if (action === undefined && inTemplate === 0) {
          const raw = el.getAttribute("action");
          action = raw === null ? null : decodeEntities(raw);
          method = (el.getAttribute("method") ?? "").trim().toLowerCase();
        }
      },
    })
    .transform(new Response(html))
    .text();

  const page = pageUrl(canonical);
  const self = page.origin;
  if (!usableAction(action ?? null, allowedOrigins, self)) found.push("waitlist form endpoint");
  // A GET would put the email in the address bar (and Formspree wants a POST).
  if (action !== undefined && method !== "post") found.push("waitlist form method");
  // A base the CSP's base-uri rejects is ignored by the browser, so URLs resolve against the page.
  let base = page;
  const wanted = baseHref !== undefined ? resolve(baseHref, page) : null;
  if (wanted && cspAllowsKind(allowedOrigins, "base", wanted, self)) base = wanted;

  const reported = new Set<string>();
  const report = (line: string) => {
    if (!reported.has(line)) reported.add(line), found.push(line);
  };
  const readSheets = new Set<string>(); // each stylesheet once, so an @import cycle ends
  const check = ({ ref, kind }: { ref: string; kind: Kind | null }, from: URL) => {
    const url = resolve(ref, from);
    if (!url) {
      // An empty or #-only link goes nowhere, which is fine; a file to fetch must have a URL.
      if (kind && (ref.trim() === "" || !ref.trim().startsWith("#"))) report(`invalid file reference ${JSON.stringify(ref)}`);
      return;
    }
    const path = localPath(url, page);
    // Anything fetched, local or off-site, must get past the CSP for its kind.
    if (kind && !cspAllowsKind(allowedOrigins, kind, url, self)) {
      report(`blocked by the site's CSP: ${path === null || path.startsWith("\0") ? url.href : path}`);
      return;
    }
    if (path === null) return; // off-site: a link is fine
    if (path.startsWith("\0")) report(`missing file ${path.slice(1)}`);
    else if (servedByVercel(url, page)) return;
    else if (!served(path, exists, kind)) report(`missing file ${path === "" ? "index.html" : path}`);
    // A local stylesheet's url()s and @imports resolve against the stylesheet itself.
    else if (kind === "style" && readFile && !readSheets.has(path)) {
      readSheets.add(path);
      const css = readFile(path);
      if (css !== null) for (const r of cssUrls(css)) check(r, url);
    }
  };
  for (const r of refs) check(r, base);
  return found;
}

// What a <link rel=preload as=...> loads, so its CSP directive is known.
const PRELOAD_KIND: Record<string, Kind> = { font: "font", image: "img", script: "script", style: "style" };

// url(...) references in a stylesheet: inside @font-face they are fonts, anywhere else images;
// @import "x.css" (or @import"x.css") and @import url(x.css) are stylesheets. Comments are dropped first; data: URLs
// are checked like any other (img-src data:), and url(#id) points into a document, not at a file.
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
function cssUrls(css: string): Array<{ ref: string; kind: Kind }> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const fontFaces: Array<[number, number]> = [];
  for (const m of text.matchAll(/@font-face\s*\{[^}]*\}/gi)) fontFaces.push([m.index, m.index + m[0].length]);
  const out: Array<{ ref: string; kind: Kind }> = [];
  const imports: Array<[number, number]> = [];
  for (const m of text.matchAll(/@import(?![\w-])\s*(?:"([^"]*)"|'([^']*)'|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\))/gi)) {
    imports.push([m.index, m.index + m[0].length]);
    out.push({ ref: m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5], kind: "style" });
  }
  for (const m of text.matchAll(CSS_URL)) {
    if (imports.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const ref = m[1] ?? m[2] ?? m[3];
    if (ref.trim().startsWith("#")) continue;
    out.push({ ref, kind: fontFaces.some(([a, b]) => m.index >= a && m.index < b) ? "font" : "img" });
  }
  return out;
}

// exists() for what Vercel will actually upload: on disk and not dropped by .vercelignore.
// Handles the plain path patterns this site uses (folders, files, leading "/"), not full globs.
export function deployedFile(root: string): (path: string) => boolean {
  const ignorePath = join(root, ".vercelignore");
  const patterns = (existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const ignored = (path: string) =>
    patterns.some((p) => {
      const anchored = p.startsWith("/");
      const pat = p.replace(/^\/|\/$/g, "");
      const parts = path.split("/");
      return parts.some((_, i) => (anchored ? i === 0 : true) && parts.slice(i, i + pat.split("/").length).join("/") === pat);
    });
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const inside = (path: string) => !path.split(/[\\/]/).includes("..");
  return (path) => inside(path) && !ignored(path) && isFile(join(root, path));
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const left = await findPlaceholders(readFileSync(join(root, "index.html"), "utf8"), {
    exists: deployedFile(root),
    allowedOrigins: allowedFormOrigins(readFileSync(join(root, "vercel.json"), "utf8")),
    readFile: (path) => (deployedFile(root)(path) ? readFileSync(join(root, path), "utf8") : null),
  });
  if (left.length === 0) {
    console.log("Ready to launch: no placeholders left.");
    console.log("Check by hand: Web Analytics is on in the Vercel project (else /_vercel/insights/script.js is a 404).");
  } else {
    console.error(`Not ready to launch. Still to do:\n${left.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
}
