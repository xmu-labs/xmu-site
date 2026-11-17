// Hero window (XMU-829): the team joins once the window is on screen. On a laptop most of it
// starts below the fold, so until it scrolls into view it holds at "waiting for teammates":
// ben is in and the invite card is up. Without this script it plays on load, as before.
//
// The hold is a class: CSS pauses every animation in the window (.tm.held), and taking the class
// off resumes them where they are, without rewinding the ones that already finished. CSS recreates
// some animations when the layout or a setting changes (a breakpoint, print, reduced motion), and
// a new one starts from zero, so sync() puts every animation back on the window's own clock.
(() => {
  const fig = document.querySelector("#top .tm");
  const panes = fig?.querySelector(".panes");
  if (!panes) return;
  const anims = () => fig.getAnimations({ subtree: true }).filter((a) => a.timeline instanceof DocumentTimeline);
  const now = () => Number(document.timeline.currentTime);
  const WAITING = 600; // ms into the sequence: the invite card has landed, nobody has joined yet
  const SETTLE = 200; // ms the window must stay on screen, so a scroll that only passes it doesn't count
  const JOINING = 850; // ms: the last moment before ana's avatar and the count start to change
  // the window's clock: 0 when it starts, stopped at WAITING while it waits. With reduced motion
  // there is nothing to play, so it starts long finished.
  let origin = now() - 60000;
  let started = false, held = false, done = false, onScreen = false, settle = 0, queued = false;
  // real time the page was last shown: a hidden page shows nothing, so a hold that comes late there undoes nothing.
  // Unless the join was already on show when it went hidden: a busy page delivers both events late, together.
  let shown = 0, watched = false;
  document.addEventListener("visibilitychange", () => {
    const t = performance.now();
    if (!document.hidden) shown = t;
    else if (started && t > Math.max(shown, origin + JOINING)) watched = true;
  });
  const seq = () => (held ? WAITING : now() - origin);
  const sync = () => {
    if (!started || queued) return; // before its first frame the window has no clock to keep
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const t = seq();
      for (const a of anims()) a.currentTime = t;
    });
  };
  addEventListener("resize", sync);
  for (const q of ["print", "(prefers-reduced-motion: reduce)"]) matchMedia(q).addEventListener("change", sync);
  // the window starts on its first frame, which can come well after this script runs: take the clock
  // from there, and if CSS replaces the first animation before then, from the one that takes its place
  const start = () => {
    const first = anims()[0];
    if (!first) {
      // printing has no animations either: start again once the page is back on screen
      if (matchMedia("print").matches) {
        matchMedia("print").addEventListener("change", start, { once: true });
        return;
      }
      started = true;
      return;
    }
    first.ready.then(() => {
      origin = first.startTime ?? now() - Number(first.currentTime);
      started = true;
      sync(); // on a slow CPU some animations start a few frames after the first
      wait();
    }, start);
  };
  start();

  // on screen when it is due doesn't skip the hold: the release comes once the window has settled
  const hold = () => {
    // a timer that comes late on a busy page finds the join already showing: rewinding would undo it
    // in front of the visitor. Count in real time: the window's clock can stop with the main thread
    // while the join keeps moving on screen. A hidden tab's timers come late too, but there nobody
    // has seen it, so count from when the page was last shown.
    const late = performance.now() - Math.max(origin + WAITING, shown);
    if (done || watched || (late > JOINING - WAITING && !document.hidden)) return;
    held = true;
    fig.classList.add("held");
    sync();
  };
  const check = () => {
    clearTimeout(settle);
    if (onScreen && !document.hidden) settle = setTimeout(release, SETTLE);
  };
  const seen = (entries) => {
    const e = entries[entries.length - 1];
    onScreen = e.intersectionRect.height >= Math.min(e.boundingClientRect.height, innerHeight) * 0.85;
    check();
  };
  // every 5%, so a stop mid-scroll still counts, plus the release point itself: when the panes are
  // taller than the screen it is 85% of the screen, which falls between the steps
  let io;
  const observe = () => {
    io?.disconnect();
    if (done) return;
    const at = Math.min(1, (innerHeight * 0.85) / panes.getBoundingClientRect().height);
    io = new IntersectionObserver(seen, { threshold: [...Array.from({ length: 21 }, (_, i) => i / 20), at] });
    io.observe(panes);
  };
  function release() {
    done = true;
    io.disconnect();
    removeEventListener("resize", observe);
    document.removeEventListener("visibilitychange", check);
    if (held) origin = now() - WAITING;
    held = false;
    fig.classList.remove("held");
  }
  function wait() {
    const left = WAITING - seq();
    // this script came late and the window is already playing: let it
    if (left <= 0 || !("IntersectionObserver" in window)) return;
    observe();
    addEventListener("resize", observe);
    setTimeout(hold, left);
    document.addEventListener("visibilitychange", check);
  }
})();
