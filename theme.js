// Light or dark theme for the xmu landing page (XMU-814).
// A classic script at the top of <head>, so a saved choice applies before the first paint.
// Dark is the default whatever the system setting; storage may be blocked (private mode).
(() => {
  const KEY = "xmu-theme";
  const BAR = { dark: "#050A12", light: "#F7FAFF" }; // the phone browser bar matches the page
  const root = document.documentElement;
  let theme = "dark";
  try {
    if (localStorage.getItem(KEY) === "light") theme = "light";
  } catch {
    // no storage: stay on the default
  }

  function apply(next) {
    theme = next;
    root.dataset.theme = next;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BAR[next]);
    document.querySelector("button.theme")?.setAttribute("aria-label", next === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }

  apply(theme);
  document.addEventListener("DOMContentLoaded", () => {
    apply(theme);
    document.querySelector("button.theme")?.addEventListener("click", () => {
      apply(theme === "dark" ? "light" : "dark");
      try {
        localStorage.setItem(KEY, theme);
      } catch {
        // the choice lasts for this visit only
      }
    });
  });
})();
