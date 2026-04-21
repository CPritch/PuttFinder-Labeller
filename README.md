# PuttFinder Labeller

A local, web-based tool for labelling multiple balls in high-speed, 8-bit
infrared AVI footage. The backend is Python (FastAPI + OpenCV); the frontend is
plain HTML/JS/CSS. Labels are stored in a master JSON next to each video.

This repo currently contains **Phase 1 (POC)** — core video I/O, single-click
placement, scroll-to-resize, and auto-save of a Phase-1 JSON payload.

---

## Phase 1 scope

Implemented:
- OpenCV-backed frame reader with a small LRU cache (`/api/frame/{n}`).
- `/api/load_video`, `/api/metadata`, `/api/labels`, `/api/save`, `/api/save_as`.
- Atomic writes of the master JSON (`<video>.labels.json`) beside the video;
  restored automatically on re-load.
- UI with playback (Play/Pause, step ±1 frame, scrubber, frame input).
- Click-to-place markers; scroll-wheel resizes the selected marker (or bumps
  the default if nothing is selected). Shift+scroll for fine control.
- Delete key removes the selected marker; sidebar list also has per-row delete.
- Keyboard shortcuts: `Space` play/pause, `←`/`→` step, `Delete`/`Backspace` remove.
- Phase-1 JSON payload (`id`, `frame`, `pixel_pos`). `radius` is also captured
  now so Phase 3 depth inference doesn't require re-labelling. All other
  physics fields (`world_pos`, `world_vel`, `pixel_vel`, `depth`) are `null`,
  and the `header.camera` block is `null` — they'll be filled in in Phases 2/3.

Not implemented yet (by design): magnifier, multi-ball UX polish, undo/redo,
keyframes + interpolation, 3D math, state-aware interpolation.

---

## Install & run

Requires Python 3.10+.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# from the project root:
uvicorn backend.main:app --reload --port 8000
```

Open <http://localhost:8000>. Paste the absolute path to an `.avi` in the top
bar and click **Load Video**. Drop videos in `./videos/` if you want them
co-located with the repo (the `videos/` folder is gitignored except for
`.gitkeep`).

### Headless servers

If you install on a box without GUI libs, use `opencv-python-headless` in place
of `opencv-python` (same API, no GUI deps).

---

## How labels are stored

On `Save` (auto-save is debounced and runs after every marker change, plus
the manual **Save** button), the backend writes
`<video-stem>.labels.json` next to the source video. **Save As…** prompts for
a filename and writes a named copy in the same directory.

Phase-1 payload shape (Phase 3 will flesh out `header.camera` and the
per-ball physics fields):

```json
{
  "header": {
    "fps": 200,
    "resolution": [624, 540],
    "frame_start": 1,
    "frame_end": 1868,
    "camera": null
  },
  "frames": [
    {
      "frame": 74,
      "time": 0.365,
      "balls": [
        {
          "id": 1,
          "world_pos": null,
          "world_vel": null,
          "pixel_pos": [1.80, 114.78],
          "pixel_vel": null,
          "depth": null,
          "radius": 8.0
        }
      ]
    }
  ]
}
```

Atomic save: writes to a `*.tmp` sibling and renames, so a crash mid-write
won't corrupt the master JSON.

---

## Layout

```
backend/
  main.py          # FastAPI routes
  video_store.py   # OpenCV reader + frame cache
  labels.py        # atomic JSON read/write
frontend/
  index.html
  app.js           # client state, rendering, I/O
  style.css
videos/            # drop your .avi / .json files here (gitignored)
```
