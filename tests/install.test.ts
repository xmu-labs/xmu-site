// XMU-808 — `curl -fsSL https://xmu.sh/install | sh`: the bootstrap served at /install. While the
// release repository is private it downloads through a signed-in `gh`, then runs that release's
// own install.sh, which checks every file before anything is installed.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SITE = join(import.meta.dir, "..");
const SCRIPT = join(SITE, "install.sh");

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  if (tools) rmSync(tools, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xmu-bootstrap-test-"));
  made.push(dir);
  return dir;
}

const MAC_ARM = [
  "xmu-darwin-arm64",
  "xmu-darwin-arm64.sha256",
  "xmu-ts-darwin-arm64",
  "xmu-ts-darwin-arm64.sha256",
];
const ALL = [
  ...MAC_ARM,
  "xmu-linux-x64",
  "xmu-linux-x64.sha256",
  "xmu-ts-linux-x64",
  "xmu-ts-linux-x64.sha256",
  "xmu-agents.tar.gz",
  "xmu-agents.tar.gz.sha256",
  "install.sh",
];

interface Setup {
  /** No `gh` on PATH at all. */
  noGh?: boolean;
  /** gh is signed in to no github.com account: the release cannot be read. */
  signedOut?: boolean;
  /** Another host's sign-in has expired: a bare `gh auth status` fails, github.com works. */
  otherHostExpired?: boolean;
  /** The release's assets, by name. */
  assets?: string[];
  /** `gh release download` fails. */
  downloadFails?: boolean;
  /** The release's install.sh exit code. */
  installCode?: number;
  /** The tag `gh release view` reports: by default XMU_VERSION, else v0.5.0. */
  tag?: string;
  /** The release is an unpublished draft (gh finds drafts by tag for repo writers), or what gh
   * reports in place of the flag. */
  draft?: boolean | string;
  /** `gh release view` fails, writing this to stderr. */
  viewFails?: string;
  /** A folder of real release files that `gh release download` copies from. */
  release?: string;
  uname?: [string, string];
  env?: Record<string, string>;
}

/**
 * The programs the bootstrap and the fakes use, and no other: a machine's own `gh` (CI runners
 * have one in /usr/bin) must never stand in for the fake, or be found when there should be none.
 */
let tools: string | undefined;
function toolDir(): string {
  if (tools) return tools;
  tools = mkdtempSync(join(tmpdir(), "xmu-bootstrap-tools-"));
  for (const name of ["sh", "uname", "mktemp", "rm", "grep", "cat", "cp", "ls", "tr", "printf", "echo", "head", "tail"]) {
    const found = Bun.which(name, { PATH: "/usr/bin:/bin" });
    if (found) symlinkSync(found, join(tools, name));
  }
  return tools;
}

/** Runs the bootstrap with a fake `gh` that logs each call and "downloads" stub files. */
function run(setup: Setup = {}) {
  const bin = tempDir();
  const log = join(tempDir(), "gh.log");
  const seen = join(tempDir(), "install.log");
  // The fake gh: `release download` writes each -p file into -D, install.sh a stub that logs
  // what it was given.
  const gh = `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "auth status")
    [ -z "$FAKE_SIGNED_OUT" ] || exit 1
    case " $* " in *" --hostname github.com "*) exit 0 ;; esac
    [ -z "$FAKE_OTHER_HOST_EXPIRED" ] || exit 1; exit 0 ;;
  "release view")
    [ -z "$FAKE_SIGNED_OUT" ] || { echo "HTTP 401: Bad credentials" >&2; exit 1; }
    [ -z "$FAKE_VIEW_FAILS" ] || { echo "$FAKE_VIEW_FAILS" >&2; exit 1; }
    printf '%s\\n' "$FAKE_TAG" "\${FAKE_DRAFT:-false}" $FAKE_ASSETS; exit 0 ;;
  "release download")
    [ -z "$FAKE_DOWNLOAD_FAILS" ] || { echo "HTTP 404: Not Found" >&2; exit 1; }
    shift 2; dir=""; files=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -D) dir="$2"; shift 2 ;;
        -p) files="$files $2"; shift 2 ;;
        *) shift ;;
      esac
    done
    for f in $files; do
      if [ -n "$FAKE_RELEASE" ]; then cp "$FAKE_RELEASE/$f" "$dir/$f"
      elif [ "$f" = install.sh ]; then cp "${bin}/release-install.sh" "$dir/$f"; else echo stub > "$dir/$f"; fi
    done ;;
esac
`;
  // The release's install.sh: it logs the folder it was given and what is in it.
  writeFileSync(
    join(bin, "release-install.sh"),
    `#!/bin/sh\nprintf 'base=%s files=%s\\n' "$XMU_DOWNLOAD_BASE" "$(ls "$XMU_DOWNLOAD_BASE" | tr '\\n' ' ')" >> "${seen}"\nexit "\${FAKE_INSTALL_CODE:-0}"\n`,
  );
  if (!setup.noGh) {
    writeFileSync(join(bin, "gh"), gh);
    chmodSync(join(bin, "gh"), 0o755);
  }
  const [s, m] = setup.uname ?? ["Darwin", "arm64"];
  const tmp = tempDir();
  const r = Bun.spawnSync(["/bin/sh", SCRIPT], {
    env: {
      // The real release installer needs more of the system; gh is still the fake, found first.
      PATH: setup.release ? `${bin}:/usr/bin:/bin` : `${bin}:${toolDir()}`,
      HOME: tempDir(),
      TMPDIR: tmp,
      XMU_UNAME_S: s,
      XMU_UNAME_M: m,
      FAKE_ASSETS: (setup.assets ?? ALL).join(" "),
      ...(setup.signedOut ? { FAKE_SIGNED_OUT: "1" } : {}),
      ...(setup.otherHostExpired ? { FAKE_OTHER_HOST_EXPIRED: "1" } : {}),
      ...(setup.downloadFails ? { FAKE_DOWNLOAD_FAILS: "1" } : {}),
      FAKE_INSTALL_CODE: String(setup.installCode ?? 0),
      FAKE_TAG: setup.tag ?? setup.env?.XMU_VERSION ?? "v0.5.0",
      ...(setup.draft !== undefined ? { FAKE_DRAFT: String(setup.draft) } : {}),
      ...(setup.viewFails ? { FAKE_VIEW_FAILS: setup.viewFails } : {}),
      ...(setup.release ? { FAKE_RELEASE: setup.release } : {}),
      ...setup.env,
    },
  });
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  return {
    code: r.exitCode,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
    gh: read(log),
    installed: read(seen),
    leftInTmp: readdirSync(tmp),
  };
}

describe("xmu.sh/install", () => {
  test("is served at /install as plain text", () => {
    const config = JSON.parse(readFileSync(join(SITE, "vercel.json"), "utf8"));
    expect(config.rewrites).toContainEqual({ source: "/install", destination: "/install.sh" });
    // The dot escaped: in a path-to-regexp group it would match any character.
    const header = config.headers.find((h: { source: string }) => h.source === "/install(\\.sh)?");
    expect(header.headers).toContainEqual({ key: "Content-Type", value: "text/plain; charset=utf-8" });
  });

  test("runs only once it has all of itself: a cut-off download runs nothing", () => {
    const text = readFileSync(SCRIPT, "utf8").trimEnd();
    expect(text.split("\n").at(-1)).toBe('main "$@"');
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
  });

  test("downloads this machine's files from the latest release, then runs its install.sh on them", () => {
    const r = run();
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    // github.com by name: a GH_HOST set for GitHub Enterprise must not send gh elsewhere.
    const view = r.gh.split("\n").find((l) => l.startsWith("release view"))!;
    expect(view).toContain("--repo github.com/xmu-labs/xmu-monorepo ");
    const download = r.gh.split("\n").find((l) => l.startsWith("release download"))!;
    expect(download).toContain("--repo github.com/xmu-labs/xmu-monorepo ");
    // The tag the listing came from, so a release published in between cannot mix the two.
    expect(view).toContain("--json tagName,isDraft,assets");
    expect(download.startsWith("release download v0.5.0 ")).toBe(true);
    expect(r.out).toContain("Downloading xmu (v0.5.0, darwin-arm64)");
    for (const f of [...MAC_ARM, "xmu-agents.tar.gz", "xmu-agents.tar.gz.sha256", "install.sh"]) {
      expect(download).toContain(`-p ${f}`);
    }
    expect(download).not.toContain("linux");
    // The release's own installer, given the folder it was downloaded to.
    expect(r.installed).toMatch(/^base=\S+ files=/);
    expect(r.installed).toContain("xmu-darwin-arm64 ");
    expect(r.installed).toContain("xmu-agents.tar.gz ");
    // The download folder is gone afterwards.
    expect(r.leftInTmp).toEqual([]);
  });

  test("each platform gets its own files", () => {
    const cases: [[string, string], string][] = [
      [["Linux", "x86_64"], "linux-x64"],
      [["Linux", "amd64"], "linux-x64"],
      [["Linux", "aarch64"], "linux-arm64"],
      [["Darwin", "x86_64"], "darwin-x64"],
      [["Darwin", "arm64"], "darwin-arm64"],
    ];
    for (const [uname, target] of cases) {
      const assets = [`xmu-${target}`, `xmu-${target}.sha256`, `xmu-ts-${target}`, `xmu-ts-${target}.sha256`, "install.sh"];
      const r = run({ uname, assets });
      expect(r.code, target).toBe(0);
      expect(r.gh, target).toContain(`-p xmu-${target} `);
    }
  });

  test("an asset is matched by its whole name, never as a pattern", () => {
    const r = run({ assets: [...MAC_ARM, "install.sh", "xmu-agentsXtarYgz", "xmu-agentsXtarYgzXsha256"] });
    expect(r.code).toBe(0);
    expect(r.gh).not.toContain("xmu-agents");
  });

  test("a release without the agents archive (v0.4.0) still installs its programs", () => {
    const r = run({ assets: [...MAC_ARM, "install.sh"] });
    expect(r.code).toBe(0);
    expect(r.gh).not.toContain("xmu-agents");
  });

  test("XMU_VERSION picks a release; anything else is refused before gh is asked", () => {
    const r = run({ env: { XMU_VERSION: "v0.5.0" } });
    expect(r.code).toBe(0);
    expect(r.gh).toContain("release view v0.5.0 ");
    expect(r.gh).toContain("release download v0.5.0 ");
    for (const tag of ["latest; rm -rf ~", "v0.5.0\n--repo evil/repo", "v0.5", "0.5.0", "v0.5.0.1", "v0.5.0 "]) {
      const bad = run({ env: { XMU_VERSION: tag } });
      expect(bad.code, tag).not.toBe(0);
      expect(bad.err, tag).toBe("xmu install: XMU_VERSION must be a release tag such as v0.5.0\n");
      expect(bad.gh, tag).toBe("");
    }
  });

  test("without gh, it says how to get it and signs nothing in", () => {
    const r = run({ noGh: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain("needs the GitHub CLI (gh)");
    expect(r.err).toContain("https://cli.github.com");
    expect(r.err).toContain("gh auth login");
  });

  test("with gh signed out, it says to sign in", () => {
    const r = run({ signedOut: true });
    expect(r.code).toBe(1);
    // gh's own line first: it names the cause; then what to do.
    expect(r.err).toBe(
      "HTTP 401: Bad credentials\nxmu install: gh is not signed in to github.com, or cannot reach it: gh auth status says which, gh auth login signs in\n",
    );
    expect(r.gh).not.toContain("release download");
  });

  test("signed in but refused, it shows gh's own reason", () => {
    const why = "HTTP 403: Resource protected by organization SAML enforcement.";
    const r = run({ viewFails: why });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${why}\n`);
    expect(r.err).toContain("xmu install: cannot read the latest release of github.com/xmu-labs/xmu-monorepo");
    expect(r.gh).not.toContain("release download");
  });

  test("an expired sign-in on another host does not stop it", () => {
    const r = run({ otherHostExpired: true });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.installed).toContain("xmu-darwin-arm64");
  });

  test("a tag gh reports that is not a release tag is refused before any download", () => {
    for (const tag of ["", "v1;id", "--repo", "v0.5.0 x"]) {
      const r = run({ tag });
      expect(r.code, tag).toBe(1);
      expect(r.err, tag).toContain("did not name a release tag");
      expect(r.gh, tag).not.toContain("release download");
    }
  });

  test("a draft release is refused before any download: its files can still change", () => {
    const r = run({ draft: true, env: { XMU_VERSION: "v0.6.0" } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("v0.6.0 is a draft release");
    expect(r.gh).toContain("isDraft");
    expect(r.gh).not.toContain("release download");
    expect(r.installed).toBe("");
  });

  test("a release whose draft flag reads as anything but false is refused the same way", () => {
    for (const draft of ["null", "False", "maybe"]) {
      const r = run({ draft, env: { XMU_VERSION: "v0.6.0" } });
      expect(r.code).toBe(1);
      expect(r.err).toContain("v0.6.0 is a draft release");
      expect(r.gh).not.toContain("release download");
      expect(r.installed).toBe("");
    }
  });

  test("with the release's real install.sh, it installs xmu, xmu-ts and the agents", () => {
    const release = tempDir();
    const program = (name: string) => {
      writeFileSync(join(release, name), `#!/bin/sh\necho "${name.startsWith("xmu-ts") ? "xmu-ts" : "xmu"} 9.9.9"\n`);
      chmodSync(join(release, name), 0o755);
    };
    const src = tempDir();
    mkdirSync(join(src, "agents", "pm"), { recursive: true });
    mkdirSync(join(src, "skills", "wrap"), { recursive: true });
    writeFileSync(join(src, "agents", "pm", "pm.md"), "---\nname: pm\n---\n");
    writeFileSync(join(src, "skills", "wrap", "SKILL.md"), "---\nname: wrap\n---\n");
    expect(Bun.spawnSync(["tar", "-czf", join(release, "xmu-agents.tar.gz"), "-C", src, "agents", "skills"]).exitCode).toBe(0);
    program("xmu-darwin-arm64");
    program("xmu-ts-darwin-arm64");
    for (const f of ["xmu-darwin-arm64", "xmu-ts-darwin-arm64", "xmu-agents.tar.gz"]) {
      const sum = new Bun.CryptoHasher("sha256").update(readFileSync(join(release, f))).digest("hex");
      writeFileSync(join(release, `${f}.sha256`), `${sum}  ${f}\n`);
    }
    // XMU-1011: the release's installer lives in the private monorepo (packages/cli/install.sh), so
    // this repo keeps a copy of it as shipped in v0.4.3. Copy it again when a release changes it.
    cpSync(join(import.meta.dir, "fixtures", "release-install.sh"), join(release, "install.sh"));
    const home = tempDir();
    const r = run({ release, env: { HOME: home, XDG_DATA_HOME: "" } });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("installed xmu 9.9.9");
    expect(existsSync(join(home, ".local", "bin", "xmu"))).toBe(true);
    expect(existsSync(join(home, ".local", "bin", "xmu-ts"))).toBe(true);
    expect(existsSync(join(home, ".local", "share", "xmu", "agents", "pm", "pm.md"))).toBe(true);
    expect(r.leftInTmp).toEqual([]);
    // A file that does not match its checksum installs nothing.
    writeFileSync(join(release, "xmu-darwin-arm64"), "#!/bin/sh\necho tampered\n");
    const other = tempDir();
    const bad = run({ release, env: { HOME: other, XDG_DATA_HOME: "" } });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("checksum");
    expect(existsSync(join(other, ".local", "bin", "xmu"))).toBe(false);
  });

  test("an unsupported machine is refused before any download", () => {
    const r = run({ uname: ["FreeBSD", "amd64"] });
    expect(r.code).toBe(1);
    expect(r.err).toContain("unsupported platform FreeBSD/amd64 (supported: Linux and macOS on x64 and arm64)");
    expect(r.gh).not.toContain("release download");
  });

  test("a release with no build for this machine says so", () => {
    const r = run({ assets: ["xmu-linux-x64", "xmu-linux-x64.sha256", "install.sh"] });
    expect(r.code).toBe(1);
    expect(r.err).toContain("has no xmu-darwin-arm64");
    expect(r.gh).not.toContain("release download");
  });

  test("a failed download or install fails, and leaves nothing behind", () => {
    const d = run({ downloadFails: true });
    expect(d.code).toBe(1);
    expect(d.err).toContain("xmu install: the download failed");
    expect(d.installed).toBe("");
    expect(d.leftInTmp).toEqual([]);
    const i = run({ installCode: 3 });
    expect(i.code).toBe(3);
    expect(i.leftInTmp).toEqual([]);
  });
});
