# xmu-site: the xmu.sh landing page

A static page: `index.html`, `styles.css`, `theme.js`, `hero.js`, `waitlist.js`, `demo.js`, `assets/`. No build step.
Vercel serves the repository root (the project's Root Directory is empty). `.vercelignore` keeps the
tests, tools, docs, `.github`, `.gitignore` and `LICENSE` off the live site.

```sh
bun install            # Playwright, for the browser tests
bun test tests         # waitlist logic, page, widths, light/dark, logos, headers, privacy guard
bun run launch-check   # lists placeholders that still block launch
bun run og             # re-renders assets/og.png (link preview) from the hero
```

- **Run `bun run launch-check` before every production deploy.** Nothing runs it
  automatically yet (XMU-800), so a production deploy would ship the placeholders.

- **Install script:** `https://xmu.sh/install` serves `install.sh` as plain text (a rewrite and a
  header in `vercel.json`). It needs `gh`, signed in, while the release repository is private.
  It downloads this machine's files from the latest release (or `XMU_VERSION=vX.Y.Z`) into a
  temporary folder and runs that release's own `install.sh` on them, which checks every file
  before it installs anything. `tests/install.test.ts` runs it against a fake `gh`, and once
  against a copy of the release's own installer (`tests/fixtures/release-install.sh`, as shipped in
  v0.4.3, since the repository that builds it is private). Copy it again when a release changes it.
- **Waitlist:** the step 1 form's `action` in `index.html` is the xmu waitlist form in
  the xmu Formspree account (`https://formspree.io/f/mljjlolk`). To move to another form,
  put its URL (`https://formspree.io/f/<id>`) there. With JavaScript the page posts `{ "email": "…" }` as
  JSON and shows the result on the card. After that, two optional questions post
  `{ "email": "…", "step": "answers", "team_size": "…", "agents": [...] }` (no `team_size` when no size is picked) to the
  same form, only when something is picked and only with the offered values. Without
  JavaScript, the browser posts the email and Formspree shows its own confirmation page.
  If the action is not an https URL, the card says the waitlist opens soon.
  Only Formspree is supported: `launch-check` accepts nothing else, and the CSP in `vercel.json`
  (`connect-src`, `form-action`) allows only `https://formspree.io`.
- **Before launch:** in Formspree, turn off reCAPTCHA for this form (it blocks
  submissions sent from the page's script), then send one real test email.
- **Visit counting:** the page loads Vercel Web Analytics from `/_vercel/insights/script.js`
  (same origin, so the CSP is unchanged). Turn Web Analytics on for the Vercel project
  before launch; until then that path 404s on the live site. Locally and in the tests the
  path is stubbed with an empty script, and `launch-check` skips that one path because
  Vercel serves it, not this folder. Metric: Formspree submissions / Vercel page views per week.
- **Duplicates:** the browser remembers a hash of each joined email and won't send it
  twice. Duplicates from different devices are removed in the service's export.
- **Link preview:** canonical URL, `og:url` and `og:image` point at `https://xmu.sh/`
  (the domain must point at this Vercel project before launch). `assets/og.png` is a
  1200x630 render of the hero; run `bun run og` after any hero change.
- **Theme:** dark by default. `theme.js` loads first in `<head>` so a saved light theme
  (`localStorage["xmu-theme"]`) applies before the first paint.
- **Hero window:** CSS animation. `hero.js` holds it at "waiting for teammates" until the
  window is on screen, then lets the team join; without JavaScript it plays on load.
- **Public repository:** anyone can read this repository, so nothing private goes in it: no
  personal names, no paths from private workspaces, no internal notes. `tests/public-repo.test.ts`
  scans every file name and text file and fails on a banned word or an internal path. The banned
  words live in the `PRIVATE_WORDS` Actions secret, not in the repo (a short word can be read back
  from its hash). CI on this repo fails without the secret; forks and local runs skip that one test
  unless `PRIVATE_WORDS` is set.
- **CI:** `.github/workflows/site-checks.yml` runs `bun test tests` in Chromium on every PR and
  every push to `main`.
- **Licence:** all rights reserved (`LICENSE`). The fonts keep their own SIL OFL licences.
- **Design:** see `DESIGN.md` for the tokens, type, window, motion and form states.
- **Assets:** see `assets/README.md`.
