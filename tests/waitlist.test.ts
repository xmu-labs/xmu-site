// Waitlist form logic (XMU-799, two steps since XMU-814): validation, submit outcomes,
// duplicates, then the optional answers. Pure module tests: fetch and storage are injected,
// so no network and no browser.
import { describe, expect, test } from "bun:test";
import { AGENTS, MESSAGES, TEAM_SIZES, createWaitlist, normalizeEmail, validateEmail } from "../waitlist.js";

// The approved copy (copy v2, form states), word for word.
describe("messages", () => {
  test("every state says the approved words", () => {
    expect(MESSAGES).toEqual({
      joined: "You’re in. We’ll email you when your team can try xmu.",
      already: "You’re already on the list.",
      empty: "Enter a work email, like you@company.com",
      invalid: "Enter a work email, like you@company.com",
      error: "That didn’t go through. Try again.",
      closed: "The waitlist opens soon. Please check back.",
      thanks: "Thanks. That helps us pick the first teams.",
      busy: "Sending…",
    });
  });

  test("the offered answers are the form's, in the form's order", () => {
    expect(AGENTS).toEqual(["claude", "codex", "cursor", "copilot", "other"]);
    expect(TEAM_SIZES).toEqual(["2-5", "6-10", "11+"]);
  });
});

describe("validateEmail", () => {
  const valid: Array<[string, string]> = [
    ["ana@example.com", "ana@example.com"],
    ["  ana@example.com  ", "ana@example.com"],
    ["Ana.Lopez@Example.COM", "ana.lopez@example.com"],
    ["ana+xmu@example.co.uk", "ana+xmu@example.co.uk"],
    ["a_b-c@sub.example.io", "a_b-c@sub.example.io"],
    ["x@y.dev", "x@y.dev"],
  ];
  test.each(valid)("accepts %p as %p", (raw, normalized) => {
    expect(validateEmail(raw)).toEqual({ ok: true, email: normalized });
  });

  const empty = ["", "   ", "\t\n"];
  test.each(empty)("rejects blank %p as empty", (raw) => {
    expect(validateEmail(raw)).toEqual({ ok: false, reason: "empty" });
  });

  const invalid = [
    "ana",
    "ana@",
    "@example.com",
    "ana@example",
    "ana@@example.com",
    "ana@exa mple.com",
    "an a@example.com",
    "ana@example..com",
    ".ana@example.com",
    "ana.@example.com",
    "ana..lopez@example.com",
    "ana@-example.com",
    "ana@example.com.",
    "ana@example.c",
    "ana@example.com,bob@example.com",
    "<script>@example.com",
    "ana@exämple.com",
    "ana\u0000@example.com",
    `ana@${"a".repeat(64)}.com`,
    `ana@sub.${"b".repeat(100)}.io`,
  ];
  test.each(invalid)("rejects malformed %p", (raw) => {
    expect(validateEmail(raw)).toEqual({ ok: false, reason: "invalid" });
  });

  test("rejects an address longer than 254 characters", () => {
    const raw = `${"a".repeat(60)}@${"b".repeat(190)}.com`;
    expect(raw.length).toBeGreaterThan(254);
    expect(validateEmail(raw)).toEqual({ ok: false, reason: "too_long" });
  });

  test("rejects a local part longer than 64 characters", () => {
    expect(validateEmail(`${"a".repeat(65)}@example.com`)).toEqual({ ok: false, reason: "too_long" });
  });

  test("accepts a local part of exactly 64 characters", () => {
    const raw = `${"a".repeat(64)}@example.com`;
    expect(validateEmail(raw)).toEqual({ ok: true, email: raw });
  });

  test("treats non-string input as empty instead of throwing", () => {
    expect(validateEmail(undefined as unknown as string)).toEqual({ ok: false, reason: "empty" });
    expect(validateEmail(null as unknown as string)).toEqual({ ok: false, reason: "empty" });
  });
});

describe("normalizeEmail", () => {
  test("trims and lowercases", () => {
    expect(normalizeEmail("  Ana@Example.com ")).toBe("ana@example.com");
  });
});

// ── submit ────────────────────────────────────────────────────────────────────

type Call = { url: string; init: RequestInit };

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

function throwingStorage(): Storage {
  const fail = () => {
    throw new Error("SecurityError: storage disabled");
  };
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail };
}

function fakeFetch(responder: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ENDPOINT = "https://formspree.io/f/test123";
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

describe("createWaitlist().submit", () => {
  test("posts the normalized email as JSON and reports joined", async () => {
    const f = fakeFetch(ok);
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage: memoryStorage() });
    const res = await wl.submit("  Ana@Example.com ");
    expect(res.status).toBe("joined");
    expect(res.message).toBe(MESSAGES.joined);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(ENDPOINT);
    expect(f.calls[0].init.method).toBe("POST");
    const headers = new Headers(f.calls[0].init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ email: "ana@example.com" });
  });

  test("submit sends only the email, even if answers are passed", async () => {
    const f = fakeFetch(ok);
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage: memoryStorage() });
    await wl.submit("ana@example.com", { agents: ["codex"], teamSize: "2-5" } as never);
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ email: "ana@example.com" });
  });

  test("does not call the endpoint for an invalid email", async () => {
    const f = fakeFetch(ok);
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage: memoryStorage() });
    const res = await wl.submit("ana@");
    expect(res.status).toBe("invalid");
    expect(res.message).toBe(MESSAGES.invalid);
    expect(f.calls).toHaveLength(0);
  });

  test("does not call the endpoint for an empty email", async () => {
    const f = fakeFetch(ok);
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage: memoryStorage() });
    const res = await wl.submit("   ");
    expect(res.status).toBe("invalid");
    expect(res.message).toBe(MESSAGES.empty);
    expect(f.calls).toHaveLength(0);
  });

  test("a second submit of the same email (any case/spacing) is not sent again", async () => {
    const f = fakeFetch(ok);
    const storage = memoryStorage();
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage });
    expect((await wl.submit("ana@example.com")).status).toBe("joined");
    const again = await wl.submit("  ANA@example.com");
    expect(again.status).toBe("already");
    expect(again.message).toMatch(/already on the list/i);
    expect(f.calls).toHaveLength(1);
  });

  test("duplicate memory survives a reload (new instance, same storage)", async () => {
    const f = fakeFetch(ok);
    const storage = memoryStorage();
    await createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage }).submit("ana@example.com");
    const res = await createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage }).submit("ana@example.com");
    expect(res.status).toBe("already");
    expect(f.calls).toHaveLength(1);
  });

  test("never stores the raw email in the browser", async () => {
    const storage = memoryStorage();
    await createWaitlist({ endpoint: ENDPOINT, fetch: fakeFetch(ok).fn, storage }).submit("ana@example.com");
    const dump = Array.from({ length: storage.length }, (_, i) => storage.getItem(storage.key(i)!)).join("\n");
    expect(dump).not.toContain("ana");
    expect(dump).not.toContain("example.com");
  });

  test("accepts internationalised top-level domains in punycode", () => {
    expect(validateEmail("ana@example.xn--p1ai")).toEqual({ ok: true, email: "ana@example.xn--p1ai" });
  });

  test("an email seen again moves to the front, so it is not forgotten by the cap", async () => {
    const storage = memoryStorage();
    const f = fakeFetch(ok);
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage });
    await wl.submit("first@example.com");
    for (let i = 0; i < 49; i++) await wl.submit(`user${i}@example.com`);
    expect((await wl.submit("first@example.com")).status).toBe("already");
    await wl.submit("one-more@example.com");
    expect((await wl.submit("first@example.com")).status).toBe("already");
    expect(f.calls).toHaveLength(51);
  });

  test("accepts a domain label of exactly 63 characters", () => {
    const raw = `ana@${"a".repeat(63)}.com`;
    expect(validateEmail(raw)).toEqual({ ok: true, email: raw });
  });

  test("the remembered list stays small (keeps the latest 50)", async () => {
    const storage = memoryStorage();
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: fakeFetch(ok).fn, storage });
    for (let i = 0; i < 60; i++) await wl.submit(`user${i}@example.com`);
    expect(JSON.parse(storage.getItem("xmu.waitlist.joined")!)).toHaveLength(50);
    expect((await wl.submit("user59@example.com")).status).toBe("already");
  });

  test("joining through one form endpoint does not block the same email at another endpoint", async () => {
    const storage = memoryStorage();
    await createWaitlist({ endpoint: ENDPOINT, fetch: fakeFetch(ok).fn, storage }).submit("ana@example.com");
    const other = fakeFetch(ok);
    const res = await createWaitlist({ endpoint: "https://formspree.io/f/other456", fetch: other.fn, storage }).submit("ana@example.com");
    expect(res.status).toBe("joined");
    expect(other.calls).toHaveLength(1);
  });

  test("a different email after joining is sent", async () => {
    const f = fakeFetch(ok);
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage: memoryStorage() });
    await wl.submit("ana@example.com");
    expect((await wl.submit("bob@example.com")).status).toBe("joined");
    expect(f.calls).toHaveLength(2);
  });

  test("a failed submit is not remembered, so a retry is sent", async () => {
    let fail = true;
    const f = fakeFetch(() => (fail ? new Response("nope", { status: 500 }) : ok()));
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage: memoryStorage() });
    expect((await wl.submit("ana@example.com")).status).toBe("error");
    fail = false;
    expect((await wl.submit("ana@example.com")).status).toBe("joined");
    expect(f.calls).toHaveLength(2);
  });

  const failures: Array<[string, () => Response | Promise<Response>]> = [
    ["HTTP 500", () => new Response("boom", { status: 500 })],
    ["HTTP 400", () => new Response(JSON.stringify({ errors: [{ message: "x" }] }), { status: 400 })],
    ["HTTP 429", () => new Response("slow down", { status: 429 })],
    ["network error", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["redirect to an HTML page", () => new Response("<html>", { status: 302 })],
  ];
  test("a 4xx naming the email (Formspree TYPE_EMAIL or field email) reports an invalid email", async () => {
    for (const errors of [[{ code: "TYPE_EMAIL", message: "should be an email" }], [{ field: "email", message: "is invalid" }]]) {
      const storage = memoryStorage();
      const reply = () => new Response(JSON.stringify({ errors }), { status: 422 });
      const wl = createWaitlist({ endpoint: ENDPOINT, fetch: fakeFetch(reply).fn, storage });
      expect(await wl.submit("ana@example.com")).toEqual({ status: "invalid", message: MESSAGES.invalid });
    }
    // Only a 4xx: a server error is still a try-again, whatever its body says.
    const boom = () => new Response(JSON.stringify({ errors: [{ code: "TYPE_EMAIL" }] }), { status: 500 });
    expect((await createWaitlist({ endpoint: ENDPOINT, fetch: fakeFetch(boom).fn, storage: memoryStorage() }).submit("ana@example.com")).status).toBe("error");
  });

  test("a rate limit or block that names the email field (another code) is a try-again, not an invalid email", async () => {
    for (const status of [429, 403]) {
      const reply = () => new Response(JSON.stringify({ errors: [{ field: "email", code: "RATE_LIMITED", message: "too many" }] }), { status });
      const res = await createWaitlist({ endpoint: ENDPOINT, fetch: fakeFetch(reply).fn, storage: memoryStorage() }).submit("ana@example.com");
      expect([status, res]).toEqual([status, { status: "error", message: MESSAGES.error }]);
    }
  });

  test("a TYPE_EMAIL code on any 4xx still reports an invalid email", async () => {
    const reply = () => new Response(JSON.stringify({ errors: [{ code: "TYPE_EMAIL" }] }), { status: 400 });
    expect((await createWaitlist({ endpoint: ENDPOINT, fetch: fakeFetch(reply).fn, storage: memoryStorage() }).submit("ana@example.com")).status).toBe("invalid");
  });

  test.each(failures)("%s reports a retryable error, never success", async (_name, responder) => {
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: fakeFetch(responder).fn, storage: memoryStorage() });
    const res = await wl.submit("ana@example.com");
    expect(res.status).toBe("error");
    expect(res.message).toMatch(/try again/i);
  });

  test("a redirect to an HTML page is never followed into a fake success", async () => {
    // Behaves like the real fetch: follows redirects (ending on a 200 HTML page)
    // unless the request says redirect: "error", in which case it rejects.
    const f = fakeFetch((call) => {
      if (call.init.redirect === "error") return Promise.reject(new TypeError("Failed to fetch: redirect"));
      return new Response("<html>thanks</html>", { status: 200, headers: { "content-type": "text/html" } });
    });
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage: memoryStorage() });
    expect((await wl.submit("ana@example.com")).status).toBe("error");
  });

  test("a 200 whose JSON says ok:false is an error, not success", async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ ok: false, error: "Form not found" }), { status: 200 }));
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage: memoryStorage() });
    expect((await wl.submit("ana@example.com")).status).toBe("error");
  });

  test("a 200 with an empty or non-JSON body still counts as success", async () => {
    for (const body of ["", "<html>thanks</html>"]) {
      const wl = createWaitlist({ endpoint: ENDPOINT, fetch: fakeFetch(() => new Response(body, { status: 200 })).fn, storage: memoryStorage() });
      expect((await wl.submit("ana@example.com")).status).toBe("joined");
    }
  });

  test("a 2xx whose body then fails to arrive still counts as joined (the service has the email)", async () => {
    const broken = new Response(new ReadableStream({ start(c) { c.error(new Error("reset")); } }), { status: 200 });
    const storage = memoryStorage();
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: fakeFetch(() => broken).fn, storage });
    expect((await wl.submit("ana@example.com")).status).toBe("joined");
    expect((await wl.submit("ana@example.com")).status).toBe("already");
  });

  test("an endpoint that never answers times out as an error", async () => {
    const hang = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: hang.fn, storage: memoryStorage(), timeoutMs: 20 });
    const res = await wl.submit("ana@example.com");
    expect(res.status).toBe("error");
    expect(hang.calls[0].init.signal).toBeDefined();
  });

  test("a double submit while the first is in flight sends only once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeFetch(async () => {
      await gate;
      return ok();
    });
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage: memoryStorage() });
    const first = wl.submit("ana@example.com");
    const second = await wl.submit("ana@example.com");
    expect(second.status).toBe("busy");
    release();
    expect((await first).status).toBe("joined");
    expect(f.calls).toHaveLength(1);
  });

  const unconfigured = ["", "   ", "REPLACE_ME", "http://formspree.io/f/abc", "javascript:alert(1)", "not a url"];
  test.each(unconfigured)("endpoint %p counts as not configured: no request, no fake success", async (endpoint) => {
    const f = fakeFetch(ok);
    const wl = createWaitlist({ endpoint, fetch: f.fn, storage: memoryStorage() });
    const res = await wl.submit("ana@example.com");
    expect(res.status).toBe("closed");
    expect(res.message).toBe(MESSAGES.closed);
    expect(f.calls).toHaveLength(0);
  });

  test("a filled honeypot (bot) looks like success but sends nothing", async () => {
    const f = fakeFetch(ok);
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage: memoryStorage() });
    const res = await wl.submit("ana@example.com", { honeypot: "http://spam.example" });
    expect(res.status).toBe("joined");
    expect(f.calls).toHaveLength(0);
  });

  test("works when browser storage is blocked (private mode)", async () => {
    const f = fakeFetch(ok);
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage: throwingStorage() });
    expect((await wl.submit("ana@example.com")).status).toBe("joined");
  });

  test("after a filled honeypot, the step 2 answers are not sent either", async () => {
    const f = fakeFetch(ok);
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage: memoryStorage() });
    await wl.submit("bot@example.com", { honeypot: "http://spam.example" });
    const res = await wl.answer("bot@example.com", { teamSize: "2-5", agents: ["claude"] });
    expect(res.status).toBe("thanks");
    expect(f.calls).toHaveLength(0);
  });

  test("works with no storage at all", async () => {
    const f = fakeFetch(ok);
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage: null });
    expect((await wl.submit("ana@example.com")).status).toBe("joined");
  });

  test("corrupt stored data is ignored, not a crash", async () => {
    const storage = memoryStorage();
    storage.setItem("xmu.waitlist.joined", "{not json");
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: fakeFetch(ok).fn, storage });
    expect((await wl.submit("ana@example.com")).status).toBe("joined");
  });
});

// Step 2 (XMU-814): after joining, two optional answers go in a second request.
describe("createWaitlist().answer", () => {
  const body = (f: ReturnType<typeof fakeFetch>, i = 0) => JSON.parse(String(f.calls[i].init.body));
  const setup = (responder: (call: Call) => Promise<Response> | Response = ok, storage: Storage = memoryStorage()) => {
    const f = fakeFetch(responder);
    return { f, storage, wl: createWaitlist({ endpoint: ENDPOINT, fetch: f.fn, storage }) };
  };

  test("sends the email, the step, the team size and the agents in the form's order", async () => {
    const { f, wl } = setup();
    const res = await wl.answer("Ana@Example.com", { teamSize: "6-10", agents: ["other", "claude", "cursor"] });
    expect(res).toEqual({ status: "thanks", message: MESSAGES.thanks });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(ENDPOINT);
    expect(f.calls[0].init.method).toBe("POST");
    expect(body(f)).toEqual({ email: "ana@example.com", step: "answers", team_size: "6-10", agents: ["claude", "cursor", "other"] });
  });

  test.each(["2-5", "6-10", "11+"])("team size %p alone is sent, with no agents", async (size) => {
    const { f, wl } = setup();
    expect((await wl.answer("ana@example.com", { teamSize: size })).status).toBe("thanks");
    expect(body(f)).toEqual({ email: "ana@example.com", step: "answers", team_size: size, agents: [] });
  });

  // team_size is a text field on the form: a JSON null could fail its rules, so it is left out.
  test("agents alone are sent, with no team_size field at all", async () => {
    const { f, wl } = setup();
    await wl.answer("ana@example.com", { agents: ["copilot"] });
    expect(body(f)).toEqual({ email: "ana@example.com", step: "answers", agents: ["copilot"] });
  });

  test("with nothing picked, nothing is sent and the visitor is thanked", async () => {
    const { f, wl } = setup();
    expect(await wl.answer("ana@example.com", {})).toEqual({ status: "thanks", message: MESSAGES.thanks });
    expect(await wl.answer("ana@example.com", { teamSize: null, agents: [] })).toEqual({ status: "thanks", message: MESSAGES.thanks });
    expect(f.calls).toHaveLength(0);
  });

  test("an unoffered team size or agent is dropped; only unoffered picks count as nothing", async () => {
    const { f, wl } = setup();
    await wl.answer("ana@example.com", { teamSize: "1000", agents: ["codex", "<script>", "codex", "claude-code"] });
    expect(body(f)).toEqual({ email: "ana@example.com", step: "answers", agents: ["codex"] });
    await wl.answer("ana@example.com", { teamSize: "solo", agents: ["nope"] });
    expect(f.calls).toHaveLength(1);
  });

  const failures: Array<[string, () => Response | Promise<Response>]> = [
    ["HTTP 500", () => new Response("boom", { status: 500 })],
    ["HTTP 422 naming the email", () => new Response(JSON.stringify({ errors: [{ code: "TYPE_EMAIL" }] }), { status: 422 })],
    ["network error", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a 200 whose JSON says ok:false", () => new Response(JSON.stringify({ ok: false }), { status: 200 })],
  ];
  test.each(failures)("%s is a try-again error", async (_name, responder) => {
    const { wl } = setup(responder);
    expect(await wl.answer("ana@example.com", { teamSize: "2-5" })).toEqual({ status: "error", message: MESSAGES.error });
  });

  test("a failed send can be retried, and the retry sends once", async () => {
    let fail = true;
    const { f, wl } = setup(() => (fail ? Promise.reject(new TypeError("Failed to fetch")) : ok()));
    expect((await wl.answer("ana@example.com", { teamSize: "2-5" })).status).toBe("error");
    fail = false;
    expect((await wl.answer("ana@example.com", { teamSize: "2-5" })).status).toBe("thanks");
    expect(f.calls).toHaveLength(2);
  });

  test("an endpoint that never answers times out as an error", async () => {
    const hang = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const wl = createWaitlist({ endpoint: ENDPOINT, fetch: hang.fn, storage: memoryStorage(), timeoutMs: 20 });
    expect((await wl.answer("ana@example.com", { teamSize: "2-5" })).status).toBe("error");
  });

  test("a double send while the first is in flight sends only once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { f, wl } = setup(async () => {
      await gate;
      return ok();
    });
    const first = wl.answer("ana@example.com", { teamSize: "2-5" });
    expect((await wl.answer("ana@example.com", { teamSize: "2-5" })).status).toBe("busy");
    release();
    expect((await first).status).toBe("thanks");
    expect(f.calls).toHaveLength(1);
  });

  test("answering never changes the joined memory", async () => {
    const { wl, storage } = setup();
    await wl.submit("ana@example.com");
    const before = storage.getItem("xmu.waitlist.joined");
    await wl.answer("ana@example.com", { teamSize: "2-5" });
    await wl.answer("bob@example.com", { agents: ["codex"] });
    expect(storage.getItem("xmu.waitlist.joined")).toBe(before);
    expect((await wl.submit("bob@example.com")).status).toBe("joined");
  });

  test("works when browser storage is blocked", async () => {
    const { wl } = setup(ok, throwingStorage());
    expect((await wl.answer("ana@example.com", { teamSize: "2-5" })).status).toBe("thanks");
  });
});
