# Landing page assets (XMU-814)

Run `bun run launch-check` before a production deploy. It lists anything still
marked `data-placeholder` and the waitlist form endpoint while it is unset.

| File | What | Status |
|---|---|---|
| `brand/mark-dark.webp` | The logo mark, used in both themes next to the inline wordmark | done |
| `brand/favicon-32.png`, `brand/apple-touch-icon.png` | Browser tab and home-screen icons | done |
| `fonts/` | Sora, Inter, Geist and Geist Mono as self-hosted variable woff2 files (SIL OFL 1.1, licences in `fonts/OFL-*.txt`) | done |
| `og.png` | Link-preview image, 1200×630, rendered from the hero by `bun run og` | generated |
| `demo.webm`, `demo.mp4` | The 52-second demo video (XMU-830), 1920×1080, no audio: VP9 WebM first, H.264 MP4 for Safari | done |
| `demo-poster.webp` | The demo's poster frame, 1920×1080 | done |

The demo video is a scripted render of the product look, not a screen recording. Its sources, the
render tool and the full build notes are kept outside this repository. To change the video,
re-render it there and copy the three files over these. The video has no speech, so it needs no captions; the
page's "Read the demo as text" gives every step as text.
