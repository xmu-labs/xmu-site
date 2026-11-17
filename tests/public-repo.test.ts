// XMU-1011: this repository is public. Nothing private may land in it: no personal names, no
// paths or ids from the private workspace, no name of the private wiki. Every file name and every
// text file is scanned, dotfiles included, so a comment added in a later PR trips this test
// before it merges.
//
// The banned words are not in this repository: a short word can be read back from any hash of
// it. CI passes them in the PRIVATE_WORDS secret (comma or newline separated). Without it, the
// banned-word test is skipped, except where CI sets REQUIRE_PRIVATE_WORDS=true, where a missing
// list fails. To run it locally: PRIVATE_WORDS="word1,word2" bun test tests/public-repo.test.ts
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SELF = relative(ROOT, import.meta.path);

// Paths and ids that only exist in the private workspace. The lines between the guard-fixtures
// markers are the only ones the path scan skips: they must name what they catch.
// guard-fixtures:start
const INTERNAL_PATHS: RegExp[] = [
  /\/mnt\//,
  /project-files/i,
  /\/Users\//,
  /[A-Za-z]:\\Users\\/,
  /\/home\/(?!runner\/)/,
  /\/root\//,
  /\/tmp\/claude/,
  /(^|[\s"'`(\[])plans\//,
  /memory_vault/,
  /\bcmsg_[A-Za-z0-9]/,
  /\bchan_[A-Za-z0-9]{8,}/,
  /claude\.ai\/code\/(session|project)/,
];
// guard-fixtures:end

const BINARY = new Set([".png", ".webp", ".jpg", ".jpeg", ".gif", ".ico", ".mp4", ".webm", ".woff", ".woff2"]);
const SKIP_DIRS = new Set([".git", "node_modules"]);
// Words this long are also found inside a longer word ("namedev"); shorter ones only on their own,
// so a short word doesn't trip on every word that happens to contain it.
const GLUED_MIN = 5;

// Lower case, accents stripped ("Á" -> "a").
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function parseWords(list: string | undefined): string[] {
  return (list ?? "").split(/[,\n]/).map((w) => fold(w.trim())).filter(Boolean);
}

// Split on anything that is not a letter, so "Name's", "Náme" and "name20" all give the bare word.
export function words(text: string): string[] {
  return fold(text).split(/[^\p{L}]+/u).filter(Boolean);
}

export function bannedWords(text: string, banned: string[]): string[] {
  const tokens = [...new Set(words(text))];
  return banned.filter((b) => tokens.includes(b) || (b.length >= GLUED_MIN && tokens.some((t) => t.includes(b))));
}

export function internalPaths(line: string): RegExp[] {
  return INTERNAL_PATHS.filter((re) => re.test(line));
}

// A file's lines, with the guard's own marked fixture lines left out.
export function scannedLines(file: string): string[] {
  let skip = false;
  return readFileSync(join(ROOT, file), "utf8")
    .split("\n")
    .map((line) => {
      if (line.includes("guard-fixtures:start")) skip = true;
      const out = skip ? "" : line;
      if (line.includes("guard-fixtures:end")) skip = false;
      return out;
    });
}

// The files git would commit: tracked ones plus new ones that .gitignore doesn't drop.
function repoFiles(): string[] {
  const git = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT });
  if (git.exitCode === 0) return git.stdout.toString().split("\0").filter(Boolean);
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (SKIP_DIRS.has(e.name) ? [] : walk(join(dir, e.name))) : [relative(ROOT, join(dir, e.name))],
    );
  return walk(ROOT);
}

describe("the word matcher", () => {
  // Made-up words stand in for banned ones, so these cases name nobody.
  const FAKE = ["zorblax"];

  test("finds the word in any case", () => {
    expect(bannedWords("Ask ZORBLAX first", FAKE)).toEqual(["zorblax"]);
  });

  test("finds the word with accents", () => {
    expect(bannedWords("Zórbláx said so", FAKE)).toEqual(["zorblax"]);
  });

  test("finds the word before a possessive, digits or punctuation", () => {
    for (const s of ["Zorblax's form", "zorblax20", "(zorblax)", "zorblax@example.com", "x_zorblax_y"]) {
      expect([s, bannedWords(s, FAKE)]).toEqual([s, ["zorblax"]]);
    }
  });

  test("reports each banned word once", () => {
    expect(bannedWords("zorblax zorblax Zorblax", FAKE)).toEqual(["zorblax"]);
  });

  test("reads the banned words from a comma or newline separated list, normalized", () => {
    expect(parseWords(" Zórblax, quuxington\n\n,  ")).toEqual(["zorblax", "quuxington"]);
    expect(parseWords(undefined)).toEqual([]);
  });

  test("finds a long word glued to other letters, but a short one only on its own", () => {
    expect(bannedWords("by QuuxingtonSmith", ["quuxington"])).toEqual(["quuxington"]);
    expect(bannedWords("ask quuxingtondev", ["quuxington"])).toEqual(["quuxington"]);
    expect(bannedWords("zorblaxian", ["zorblax"])).toEqual(["zorblax"]);
    expect(bannedWords("abcfoo foodev", ["foo"])).toEqual([]);
    expect(bannedWords("Foo's", ["foo"])).toEqual(["foo"]);
  });
});

describe("the path matcher", () => {
  // guard-fixtures:start
  test("knows the private ids and paths", () => {
    for (const line of [
      "see /mnt/x and plans/y",
      "see chan_XXXXXXXXXXXXXXXX",
      "https://claude.ai/code/project/x",
      "/tmp/claude-0/scratch",
      "/root/.cache",
      String.raw`C:\Users\me`,
    ]) {
      expect([line, internalPaths(line).length > 0]).toEqual([line, true]);
    }
  });
  // guard-fixtures:end

  test("leaves ordinary paths alone", () => {
    for (const line of [
      "~/.local/bin and $HOME/.config are fine",
      '<a href="/plans/team">Plans</a>',
      "explains/why",
      "cd /home/runner/work/xmu-site",
    ]) {
      expect([line, internalPaths(line)]).toEqual([line, []]);
    }
  });

  test("scans its own file too, outside the marked fixture lines", () => {
    expect(scannedLines(SELF).some((l) => l.includes("const " + "INTERNAL_PATHS:"))).toBe(false);
    expect(scannedLines(SELF).some((l) => l.includes("describe(\"nothing private"))).toBe(true);
  });
});

describe("nothing private in the public repo", () => {
  const files = repoFiles();
  const text = files.filter((f) => !BINARY.has(extname(f).toLowerCase()));
  const banned = parseWords(process.env.PRIVATE_WORDS);

  test("the scan sees the dotfiles, the tests and the workflow", () => {
    expect(files).toContain(".vercelignore");
    expect(files).toContain(".github/workflows/site-checks.yml");
    expect(files).toContain(SELF);
    expect(files).toContain("index.html");
  });

  test("CI that requires the banned-word list has it", () => {
    if (process.env.REQUIRE_PRIVATE_WORDS === "true") expect(banned.length).toBeGreaterThan(0);
  });

  test.skipIf(banned.length === 0)("no file name or text file holds a banned word", () => {
    const hits = [
      ...files.filter((f) => bannedWords(f, banned).length).map((f) => `file name: ${f}`),
      ...text.filter((f) => bannedWords(readFileSync(join(ROOT, f), "utf8"), banned).length).map((f) => `in: ${f}`),
    ];
    expect(hits).toEqual([]);
  });

  test("no file name or text file holds a path or id from the private workspace", () => {
    const hits = [
      ...files.filter((f) => internalPaths(f).length).map((f) => `file name: ${f}`),
      ...text.flatMap((f) => scannedLines(f).flatMap((line, i) => internalPaths(line).map((re) => `${f}:${i + 1} ${re}`))),
    ];
    expect(hits).toEqual([]);
  });
});
