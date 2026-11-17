# xmu landing page: design system (XMU-814, XMU-817, XMU-830, XMU-833)

The page uses the brand v1 look and the copy v2 text, including the form messages. The look
follows the v41 mock approved on 2026-10-22; the centred hero, "How it works" and the stack
strip follow the XMU-817 mock approved on 2026-10-23, and the window and the How it works screens
take the demo video's product look from the XMU-833 mock approved on 2026-10-24. Everything on it is there to get the lead of a
small team to join the waitlist.

## Page order

1. Header: logo on the left; theme button and "Join the waitlist" on the right.
2. Hero, centred: headline, one line under it, "Join the waitlist", a quieter "See demo",
   "Early access for small teams.", then the product window. "See demo" scrolls to the demo
   and plays it.
3. Pain: "You’re on a team. Working with AI should feel like it." The Stack Overflow 2025
   survey line sits under its paragraph.
4. Demo (XMU-830): the 52-second video in a frame like the hero window, with one centred
   "Watch the demo" button on the poster until the first play, then the browser's own
   controls. It never autoplays. When it ends, the dimmed last frame carries the real "Join
   the waitlist" button and "Watch again". Under it, "Read the demo as text" gives all nine
   steps. Without JavaScript the browser's own player works.
5. Two answers side by side: "In xmu, everyone drives." and "Pick up where your team left
   off." They are text only, because the window already shows it.
6. How it works: four rows, top to bottom. Each row is a step card ("Step N" tag, a name, a
   line and a sentence) next to a still xmu screen of that step, in the window's look: ben
   alone with Claude reading the logs, typing `invite` in xmu's bar with his team list open
   (ana and mia ticked, sam not); the invite landing in ana's and mia's own
   terminals, each picking an agent (Claude, Codex, Cursor, Gemini CLI or any CLI agent, shown
   as `>_`); ben's Claude beside ana's Codex with mia's Cursor stacked under her, ana steering
   ben's Claude; and ben's Claude merging #218 and watching deploy 1.8.4 next to the chat
   history. Sides alternate on desktop, joined by a line and a dot; up to 1180px the card sits
   above its screen; at 760px and below step 2's terminals stack; at 560px and below steps 3
   and 4 show ben's pane only, with the window's phone text sizes. Cards follow the theme,
   screens stay dark. Rows rise in as they scroll into view, unless reduced motion is on; the
   screens themselves never move.
7. Stack strip: "Works with your existing stack and any coding agent.", six chips (they wrap
   on smaller screens) and one line under them.
8. Waitlist card, then the footer.

## Tokens

Dark is the default. The button in the header switches to light and remembers the choice
in `localStorage["xmu-theme"]`. `theme.js` runs first in `<head>`, so a saved light theme
never flashes dark.

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--ground` | `#050A12` | `#F7FAFF` | page |
| `--surface` | `#0F1A2B` | `#FFFFFF` | waitlist card |
| `--sunk` | `#0A1322` | `#EEF4FF` | fields, options |
| `--line` | `#2B3A55` | `#CBD8E8` | rules, card edge |
| `--field` | `#5F7294` | `#6E819C` | field and option borders (3:1 or more) |
| `--text` | `#EAF4FF` | `#050A12` | text |
| `--muted` | `#A7B4C9` | `#2B3A55` | secondary text |
| `--primary` | `#2E6EA8` | `#2E6EA8` | buttons |
| `--primary-hover` | `#3A7DBA` | `#0F2B4D` | button hover |
| `--accent` | `#7EC8F3` | `#2E6EA8` | focus ring, links, checked options |

The phone browser bar (`theme-color`) follows the theme. The logo mark (`mark-dark.webp`) is
the same in both themes, as in the mock.

## Type

Sora 600 for headings, Inter for text, Geist inside the window, Geist Mono for code. All four
are self-hosted woff2 files under SIL OFL 1.1, with the licences in `assets/fonts/`.

| Role | Desktop | Phone (760px and below) |
| --- | --- | --- |
| h1 | 56/64 | 36/44 |
| h2 | 32/40 | 26/34 |
| h2, How it works | 56/64 | 36/44 |
| Hero line | 20/28 | 18/26 |
| Body | 16/24 | 16/24 |
| Small | 14/20 | 14/20 |
| Caption | 12/16 | 12/16 |

Headings use `text-wrap: balance`. Long words wrap anywhere, buttons included, so a
translated page never scrolls sideways.

## Layout

- Content is 1200px at most. The gutter is 40px, 32px at 1023px and below, and 16px at
  760px and below. Gutters always clear the phone's safe-area insets.
- Layout spacing uses 4, 8, 12, 16, 20, 24, 32, 40, 48, 56, 64, 72 and 96px. Sections are
  96px apart on desktop, 72px on tablet and 56px on a phone. A few controls are tuned off
  that scale (button padding 18px, card padding 28px, 10px gaps).
- Every tap target is 44px tall or more. The focus ring is 2px of `--accent` with a 2px
  offset. On an option it goes round the whole pill.

## The product window

- Session `refunds-hotfix`. Three people and their agents work at once: ben with Claude, ana
  with Codex, and mia (lead) with Cursor. Each pane is its agent's own CLI (Claude's ✻ and
  tool lines, Codex's `›` prompt and bullets, Cursor's hexagons and follow-up box), with an
  agent chip (logo and name) in its header. No CLI welcome banners. xmu's own bar runs along
  the bottom: `xmu › invite · chat · help`, with no status label (XMU-860). The team chat sits
  beside the panes.
- Settled state: Claude has found limit.ts:40 (cents compared to dollars) and fixed it, and ana
  is typing into ben's Claude ("also fix partial refunds. same check in partial.ts") in her
  colour, under a flag with her name.
- It opens with the team joining, and it is never half empty: ben's pane already shows
  `~/shop $ xmu` and Claude reading the prod logs, and the chat starts with "ben started the
  session", "ben invited ana and mia" and ben's ask. The invite card ("Invite your team",
  xmu.sh/s/refunds-hotfix, "Link copied", "Waiting for ana and mia" with dashed A and M
  avatars) sits in ana's seat. ana joins with Codex at 0.9s and mia with Cursor at 1.7s; the
  card moves to mia's seat as ana arrives and reads "Waiting for mia". Each pane opens on its
  agent's chip and empty prompt the moment its person joins. Their avatars pop into the bar
  (taking their room as they arrive), the count goes from 1 person to 3 (the old count fades
  out before the new one fades in), and the chat logs who joined. From 761 to 1199px the card
  waits in ana's seat and slides across to mia's. The join waits for the window: until 85% of the panes (or
  of the screen, if they are taller) are on screen, it holds with ben in and the invite card
  up, so laptop visitors see the team arrive. It has to stay on screen for 0.2s, so a jump to the
  waitlist that only scrolls past it doesn't start it, and a page opened in a background tab waits
  until the tab is shown. Without JavaScript it plays on load. At 760px and below there is no
  card, and the avatars and the chat show the joins. On a 390x844 phone the panes are about
  72% on screen at load, so the join starts after a small scroll.
- It stays dark in both themes. It is one image to screen readers (`role="img"`, label
  "Three teammates and their agents working in one xmu session"), and nothing inside it can
  be focused.
- Every text in it is 12px or larger on desktop (avatar initials aside). Its height is fixed
  at each width, so nothing jumps between waiting and settled.
- 1200px and up: ben on the left, ana over mia on the right, chat on the far right (560px tall).
  761 to 1199px: ben on top, ana and mia side by side below; the chat stays beside the panes
  down to 1024px, then moves under them. 1023px and below, on screen, the chat has a fixed
  height with the newest message at the bottom and older lines fading under its top edge.
  760px and below: ben's pane only, the chat under it and xmu's bar at the bottom, with the
  avatars saying who is in (no count text). In ben's pane, long log lines switch to a short form
  when it is narrow, and under 375px a line still too long fades out at the right edge.
- The light theme keeps the window and the step screens dark.

## Motion

- Two animations: the window opening with the team joining and then working, and the How it
  works rows rising in as they scroll into view. In the window, everyone has joined by 1.7s
  and the work starts at 2.2s: Claude's Bash call finishes and its live log ("Reading logs…"
  included) collapses to its one-line summary, in one step, as Claude's CLI does; then the fix
  prints line by line. ana types into Codex (22ms per character, her caret behind), mia's
  Cursor reads along, and chat messages take their room as they arrive. Everything has landed
  by about 5s; ana steering ben's Claude is the last beat.
- ben's pane is one transcript that behaves like a terminal: each line takes its room the
  moment it prints (no fade), there is only ever one prompt box, and when ana steers, her box
  replaces his in the same frame. The transcript sits on the pane's bottom once it fills it, so
  on a phone `~/shop $ xmu` and the Bash call scroll up out of the top as the fix arrives.
- ana's cursor in ben's box blinks three times and the invite card's dots pulse twice, so
  nothing moves after a few seconds (WCAG 2.2.2). Nothing animates from scale(0).
- The CSP forbids inline styles, so each timed moment has a step class (`s1` to `s27`) in
  `styles.css`, in document order: `--d` start, `--n` characters typed, `--t` typing time.
  Two states that replace each other (ana's empty prompt and her typing, mia's empty box and
  her work) share one grid cell, so nothing reflows.
- With reduced motion, and on paper, nothing types or moves and every line shows in its final
  state: everyone already in, no invite card, "3 people · 3 agents".
- Hover styles only apply on devices that can hover.

## Waitlist card

Step 1 asks only for the work email, so it is never lost. After a visitor joins, step 2
shows two optional questions on the same card, with Skip.

| Step | What the visitor sees |
| --- | --- |
| Idle | "Work email" label, empty field, "Join the waitlist" |
| Sending | "Joining…", button busy at the same width, field read-only |
| Bad email | "Enter a work email, like you@company.com" under the field, focus on the field |
| Network or server error | "That didn’t go through. Try again.", email kept |
| Already on the list | "You’re already on the list." with no error colour |
| Not set up yet | "The waitlist opens soon. Please check back." |
| Joined | "You’re in. We’ll email you when your team can try xmu." takes focus, then step 2 |
| Step 2 sending | "Sending…", Send and Skip busy |
| Step 2 failed | "That didn’t go through. Try again.", picks kept, Skip still works. The line keeps its room on a retry, so Skip and Send don't move |
| Thanks | "Thanks. That helps us pick the first teams." takes focus |

Busy buttons use `aria-disabled`, so keyboard focus stays where it was.

## Agent logos

- **Where:** inside the product window, the How it works screens and the stack strip. Each
  agent shows its tool's logo in the window bar, on its pane chip and on its chat messages;
  step 2's agent picker shows Claude, Codex, Cursor and Gemini CLI by logo, and any other CLI
  agent as a plain `>_` glyph. People keep their initials.
- **Use is nominative only:** the logos say which tools xmu works with. Never imply a
  partnership, endorsement or sponsorship ("partner", "official", "certified" are out), never
  alter, recolour beyond the tokens below, or combine a logo with xmu's wordmark.
- **Markup:** inline `<svg class="mlogo lg-*">` from simple-icons (CC0 paths), with
  `<title>` and metadata stripped, `aria-hidden="true" focusable="false"`.
- **Colour:** Claude `#D97757` (its ✻ mark in the window uses it too, nothing else does),
  Codex, Cursor and Gemini CLI in the window's text colour `#EAF4FF`. Each keeps 3:1 against
  its badge in both themes.

## Constraints

- Strict CSP (`vercel.json`): no inline scripts or styles and no third-party requests.
  The form may post only to Formspree.
- "xmu" is lowercase everywhere, including the title, meta tags and alt text.
- Windows high contrast: buttons, step tags, avatars, agent chips, the "typing" pill, ana's
  flag, the picked agent in step 2, the focused row in step 1's team list and "Link copied"
  keep an edge; step 1's ticked boxes are solid blocks; logos, cursors, window dots,
  the join's dots and the step connectors use the system text colour.
- Print: dark text on white, without the form, the theme button or the waitlist buttons. The window prints whole and finished, with all three
  panes and its dark fill, on A4 and Letter at the browser's default margins. The step screens
  keep their dark fill too, each step prints whole, and "How it works" stays with step 1.
