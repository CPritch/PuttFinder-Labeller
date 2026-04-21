# PuttFinder Labeller

A local, web-based tool for labelling multiple balls in high-speed, 8-bit
infrared AVI footage. Backend is Python (FastAPI + OpenCV); frontend is plain
HTML/JS/CSS. Labels are stored in a master JSON next to each video.

Current status: **Phase 2 (MVP)** — multi-ball tracking with persistent IDs,
linear-interpolation keyframes, editing + undo/redo, and a cursor magnifier.

---

## Phases

- **Phase 1 (POC)** — frame I/O, single-click placement, scroll-to-resize, auto-save.
- **Phase 2 (MVP) — current** — multi-ball with persistent IDs, keyframes +
  linear in-air interpolation, drag-to-move, delete, undo/redo, magnifier.
- **Phase 3 (planned)** — camera intrinsics → world coords, depth inference,
  constant-acceleration on-surface interpolation, full JSON schema.

---

## Phase 2 features

UI / UX
- Persistent ball IDs with per-ball color. Sidebar lists all balls; click to
  make active, `✕` to delete a ball and its keyframes. `+ New` or `N` key
  creates a new ball. First click on an empty project auto-creates ball #1.
- Click empty space = place a keyframe for the active ball on the current frame.
- Click an existing marker = select it (if keyframe) or promote to a keyframe
  (if interpolated). Drag to move. Scroll wheel resizes the selected marker
  (Shift-scroll for 0.25 px steps).
- **Magnifier** — floating zoom window around the cursor (toggle + 4×/6×/8×/12×/16×).
  Shows all markers in view, with crosshairs centered on the cursor for
  pixel-perfect clicks.
- Keyframes render as solid circles with a small square badge and `#N` label.
  Interpolated markers render dashed with a `#N·i` label.

Editing
- **Undo / Redo** — `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`), toolbar buttons,
  200-entry history.
- **Delete** — `Delete` / `Backspace` removes the selected keyframe; per-row
  `✕` in the sidebar also deletes keyframes or whole balls.
- Editing an interpolated frame (dragging, resizing, or clicking-place) upgrades
  it into a new keyframe and recomputes the adjacent segments.

Interpolation
- **Linear (in-air)** between each pair of consecutive keyframes for a ball:
  `pos(f) = k1.pos + t·(k2.pos − k1.pos)` where `t = (f − k1.frame)/(k2.frame − k1.frame)`.
- `pixel_vel` per frame is the **segment velocity**
  `(k2.pos − k1.pos) · fps / (k2.frame − k1.frame)` (units: px/s), matching the
  sample JSON's magnitude. Single-keyframe balls have `pixel_vel: null`.

Save payload
- Emits one frame entry for every integer frame in the video range that sits
  within any ball's `[first-keyframe, last-keyframe]` span (matching the
  densified shape of the sample JSON). Each ball contributes `pixel_pos`,
  `pixel_vel`, and `radius`. `world_pos`, `world_vel`, `depth`, and
  `header.camera` remain `null` until Phase 3.

---

## Install & run (uv)

Requires [uv](https://docs.astral.sh/uv/) and Python ≥ 3.10.

```bash
uv sync
uv run uvicorn backend.main:app --reload --port 8000
```

Open <http://localhost:8000>. Paste the absolute path to an `.avi` in the top
bar, click **Load Video**. Drop videos in `./videos/` to keep them co-located
with the repo (the folder is gitignored except for `.gitkeep`).

### Headless servers

Swap `opencv-python` for `opencv-python-headless` in `pyproject.toml` if the
target box has no GUI libs (same API, no GUI deps).

---

## Keyboard & mouse reference

| Input                        | Effect                                           |
| ---------------------------- | ------------------------------------------------ |
| Click on empty space         | Place keyframe for active ball                   |
| Click on marker              | Select keyframe (or promote interpolated → key)  |
| Drag marker                  | Move keyframe (upgrading interpolated if needed) |
| Scroll wheel on frame        | Resize selected keyframe (or default radius)     |
| Shift + scroll               | Fine adjust (0.25 px per notch)                  |
| `Space`                      | Play / Pause                                     |
| `←` / `→`                    | Step ±1 frame                                    |
| `Delete` / `Backspace`       | Delete selected keyframe                         |
| `N`                          | New ball                                         |
| `Ctrl+Z` / `Ctrl+Shift+Z`    | Undo / Redo                                      |

---

## Layout

```
backend/
  main.py          # FastAPI routes
  video_store.py   # OpenCV reader + frame cache
  labels.py        # atomic JSON read/write
frontend/
  index.html
  app.js           # client state, interpolation, rendering, I/O
  style.css
videos/            # drop your .avi / .json files here (gitignored)
pyproject.toml     # uv-managed project metadata
uv.lock
```
