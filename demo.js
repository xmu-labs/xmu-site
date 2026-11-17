// XMU-830: the demo player. "See demo" starts the video; when it ends, the real waitlist button and
// "Watch again" show over its last frame. Without this script the browser's own player still works.
(() => {
  const video = document.querySelector("#demo video");
  const end = document.querySelector("#demo .demo-end");
  if (!video || !end) return;
  // play() rejects when a pause (or a source that never loads) cuts it short; that is not an error for the page
  const start = () => video.play().catch(() => {});

  // Until the first play, one centred play button stands in for the browser's controls (they would cover the
  // caption on the poster). Once the video plays, the browser's own controls take over.
  const play = document.querySelector("#demo .demo-play");
  if (play) {
    video.controls = false;
    play.hidden = false;
    play.addEventListener("click", () => {
      play.hidden = true;
      video.controls = true; // a video without controls can't take focus
      video.focus();
      start();
    });
    // before the first play the video has no controls, so a click on the poster would do nothing: it plays too
    video.addEventListener("click", () => { if (!play.hidden) play.click(); });
  }

  // While the overlay shows, the browser's controls step aside: under the dimmed overlay they would still take
  // Tab presses and clicks nobody can see. Focus on the player moves to the waitlist button.
  const hide = () => {
    if (end.hidden) return;
    const focused = end.contains(document.activeElement);
    end.hidden = true;
    end.classList.remove("on");
    video.controls = true;
    if (focused) video.focus({ preventScroll: true }); // not lost to the page when a media key replays
  };
  video.addEventListener("play", () => {
    hide();
    if (play) { play.hidden = true; video.controls = true; }
  });
  video.addEventListener("seeking", () => { if (!video.ended) hide(); });
  video.addEventListener("ended", () => {
    const focused = document.activeElement === video;
    // preventScroll: a viewer who scrolled on stays put
    const focusJoin = () => { if (focused && !end.hidden) end.querySelector("a").focus({ preventScroll: true }); };
    video.controls = false;
    end.hidden = false;
    // The overlay sits beside the video, so it can't show inside the video's own fullscreen: leave fullscreen
    // first. The page can only take focus once fullscreen has let go of it.
    if (document.fullscreenElement === video) document.exitFullscreen().then(focusJoin, focusJoin);
    else if (video.webkitDisplayingFullscreen) { // iPhone Safari's own player
      video.addEventListener("webkitendfullscreen", focusJoin, { once: true });
      video.webkitExitFullscreen();
    } else focusJoin();
    requestAnimationFrame(() => end.classList.add("on")); // one frame hidden-then-shown, so the entrance transitions
  });
  end.querySelector(".demo-again").addEventListener("click", () => {
    hide();
    video.currentTime = 0;
    video.focus();
    start();
  });
  // "See demo": the link scrolls to the player; the press itself starts the video. A modifier click opens a new
  // tab instead, so this page's video stays put.
  for (const a of document.querySelectorAll('a[href="#demo"]')) {
    a.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button) return;
      start();
    });
  }
})();
