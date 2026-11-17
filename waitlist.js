// Waitlist form for the xmu landing page (XMU-799; two steps since XMU-814).
// Step 1 sends the email alone, so it is never lost; step 2 sends two optional answers.
// Pure logic first (validateEmail, createWaitlist) so it can be tested without a browser;
// the page wiring at the bottom only runs when a document with the form is present.

const MAX_TOTAL = 254;
const MAX_LOCAL = 64;
const STORAGE_KEY = "xmu.waitlist.joined";
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const REMEMBER_MAX = 50;
// The two optional questions of step 2: only the values the form offers are sent.
export const AGENTS = ["claude", "codex", "cursor", "copilot", "other"];
export const TEAM_SIZES = ["2-5", "6-10", "11+"];

export const MESSAGES = {
  joined: "You’re in. We’ll email you when your team can try xmu.",
  already: "You’re already on the list.",
  empty: "Enter a work email, like you@company.com",
  invalid: "Enter a work email, like you@company.com",
  error: "That didn’t go through. Try again.",
  closed: "The waitlist opens soon. Please check back.",
  thanks: "Thanks. That helps us pick the first teams.",
  busy: "Sending…",
};

export function normalizeEmail(raw) {
  return String(raw).trim().toLowerCase();
}

export function validateEmail(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "empty" };
  const email = normalizeEmail(raw);
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  if (email.length > MAX_TOTAL || (at > 0 && local.length > MAX_LOCAL)) return { ok: false, reason: "too_long" };
  if (at <= 0 || !LOCAL_PART.test(local) || !DOMAIN.test(email.slice(at + 1))) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, email };
}

function isConfigured(endpoint) {
  try {
    return new URL(String(endpoint).trim()).protocol === "https:";
  } catch {
    return false;
  }
}

// Only a hash of the email is kept in the browser, never the address itself. The form
// endpoint is hashed in too, so joining one waitlist doesn't block a different one later.
async function digest(endpoint, email) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${endpoint}\n${email}`));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readJoined(storage) {
  try {
    const list = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Most recent last; a repeat moves to the end so the cap drops the oldest, not the newest.
function rememberJoined(storage, hash) {
  try {
    const list = readJoined(storage).filter((h) => h !== hash);
    storage?.setItem(STORAGE_KEY, JSON.stringify([...list, hash].slice(-REMEMBER_MAX)));
  } catch {
    // Storage blocked (private mode): duplicates are then caught in the export.
  }
}

const result = (status, key = status) => ({ status, message: MESSAGES[key] });

export function createWaitlist({ endpoint, fetch: doFetch, storage, timeoutMs = 10000 }) {
  let inFlight = false;
  let bot = false;
  const url = String(endpoint).trim();

  // One POST with a timeout: "ok" when the service took it, "email" when it refused the
  // address, "error" for anything else.
  async function send(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: controller.signal,
      });
      if (res.status >= 400 && res.status < 500 && namesEmail(res.status, await res.text().catch(() => ""))) return "email";
      if (res.status < 200 || res.status >= 300) return "error";
      // A 2xx means the service took it; a body that then fails to arrive doesn't undo that.
      return saysNotOk(await res.text().catch(() => "")) ? "error" : "ok";
    } catch {
      return "error";
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    // Step 1: the email alone.
    async submit(raw, { honeypot = "" } = {}) {
      const check = validateEmail(raw);
      if (!check.ok) return result("invalid", check.reason === "empty" ? "empty" : "invalid");
      if (!isConfigured(endpoint)) return result("closed");
      if (honeypot.trim() !== "") {
        bot = true;
        return result("joined");
      }
      if (inFlight) return result("busy");

      inFlight = true;
      try {
        const hash = await digest(url, check.email);
        if (readJoined(storage).includes(hash)) {
          rememberJoined(storage, hash);
          return result("already");
        }
        const sent = await send({ email: check.email });
        if (sent === "email") return result("invalid");
        if (sent === "error") return result("error");
        rememberJoined(storage, hash);
        return result("joined");
      } catch {
        return result("error");
      } finally {
        inFlight = false;
      }
    },

    // Step 2: the optional answers for an email that already joined. Nothing picked, nothing sent.
    async answer(raw, { teamSize = null, agents = [] } = {}) {
      const check = validateEmail(raw);
      const picked = new Set(Array.isArray(agents) ? agents : []);
      const body = { team_size: TEAM_SIZES.includes(teamSize) ? teamSize : null, agents: AGENTS.filter((a) => picked.has(a)) };
      // A bot that filled the honeypot got a fake "joined"; its answers are dropped too.
      if (bot || (body.team_size === null && body.agents.length === 0)) return result("thanks");
      if (!check.ok || !isConfigured(endpoint)) return result("error");
      if (inFlight) return result("busy");

      inFlight = true;
      try {
        // team_size is a text field on the form, so an unpicked size is left out rather than sent as null.
        const answers = body.team_size === null ? { agents: body.agents } : body;
        return (await send({ email: check.email, step: "answers", ...answers })) === "ok" ? result("thanks") : result("error");
      } finally {
        inFlight = false;
      }
    },
  };
}

// Formspree answers JSON; some form services send 200 with {"ok":false} when they refuse.
function saysNotOk(body) {
  try {
    const data = JSON.parse(body);
    return data !== null && typeof data === "object" && data.ok === false;
  } catch {
    return false;
  }
}

// Formspree refuses an address it can't accept with a TYPE_EMAIL error, or a 422 whose errors
// name the email field. A rate limit or block (429, 403) on the email field is not a bad address.
function namesEmail(status, body) {
  try {
    const errors = JSON.parse(body)?.errors;
    return Array.isArray(errors) && errors.some((e) => e?.code === "TYPE_EMAIL" || (status === 422 && e?.field === "email"));
  } catch {
    return false;
  }
}

// ── page wiring ───────────────────────────────────────────────────────────────

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// The card has two forms: step 1 (email) and step 2 (optional answers), then a thanks line.
// card[data-state]: idle | sending | bad | error | closed | known | in | answering | answer-error | thanks.
function wire(card) {
  const step1 = card.querySelector(".step1");
  const step2 = card.querySelector(".step2");
  const thanks = card.querySelector(".thanks");
  const input = step1.querySelector("#email");
  const pot = step1.querySelector('input[name="_gotcha"]');
  const join = step1.querySelector("button[type=submit]");
  const note = step1.querySelector("#email-msg");
  const send = step2.querySelector("button[type=submit]");
  const skip = step2.querySelector("button.link");
  const answersNote = step2.querySelector("#answers-msg");
  const waitlist = createWaitlist({ endpoint: step1.getAttribute("action"), fetch: window.fetch.bind(window), storage: safeStorage() });
  const labels = { join: join.textContent, send: send.textContent };
  let email = null;

  // aria-disabled, not disabled: a disabled button drops keyboard focus.
  const busy = (button, on, label) => {
    if (on) button.setAttribute("aria-disabled", "true");
    else button.removeAttribute("aria-disabled");
    if (label !== undefined) button.textContent = label;
  };
  const isBusy = (button) => button.getAttribute("aria-disabled") === "true";

  function finish() {
    step2.hidden = true;
    thanks.hidden = false;
    card.dataset.state = "thanks";
    thanks.focus();
  }

  step1.noValidate = true;
  step1.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isBusy(join)) return;
    card.dataset.state = "sending";
    note.textContent = "";
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
    input.readOnly = true;
    busy(join, true, "Joining…");
    const res = await waitlist.submit(input.value, { honeypot: pot?.value ?? "" });
    input.readOnly = false;
    busy(join, false, labels.join);
    if (res.status === "busy") return;
    if (res.status === "joined") {
      email = input.value;
      card.dataset.state = "in";
      step1.hidden = true;
      step2.hidden = false;
      step2.querySelector(".done").focus();
      return;
    }
    const bad = res.status === "invalid";
    card.dataset.state = bad ? "bad" : { error: "error", closed: "closed", already: "known" }[res.status];
    note.textContent = res.message;
    // Only an error describes the field; "You’re already on the list" is not part of it.
    if (bad) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", note.id);
      input.focus();
    }
  });

  step2.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isBusy(send)) return;
    card.dataset.state = "answering";
    answersNote.textContent = "";
    busy(send, true, MESSAGES.busy);
    busy(skip, true);
    const res = await waitlist.answer(email, {
      teamSize: step2.querySelector('input[name="team_size"]:checked')?.value ?? null,
      agents: [...step2.querySelectorAll('input[name="agents"]:checked')].map((box) => box.value),
    });
    busy(send, false, labels.send);
    busy(skip, false);
    if (res.status === "busy") return;
    if (res.status === "thanks") return finish();
    card.dataset.state = "answer-error";
    answersNote.textContent = res.message;
    answersNote.classList.add("held");
  });

  skip.addEventListener("click", () => {
    if (!isBusy(skip)) finish();
  });
}

if (typeof document !== "undefined") {
  const card = document.querySelector("#waitlist .card");
  if (card) wire(card);
}
