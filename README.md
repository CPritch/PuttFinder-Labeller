# PuttFinder Labeller

A local, web-based tool for labelling multiple balls in high-speed, 8-bit
infrared AVI footage. Backend is Python (FastAPI + OpenCV); frontend is plain
HTML/JS/CSS. Labels are stored in a master JSON next to each video.

Current status: **Phase 3 (v1.0)** — camera math, per-segment mode inference
(linear in-air vs const-accel on-surface), full Phase-3 JSON schema with
`world_pos`, `world_vel`, `depth`, and per-row `keyframe` flag.

---

## Phases

- **Phase 1 (POC)** — frame I/O, single-click placement, scroll-to-resize, auto-save.
- **Phase 2 (MVP)** — multi-ball with persistent IDs, keyframes + linear
  in-air interpolation, drag-to-move, delete, undo/redo, magnifier.
- **Phase 3 (v1.0) — current** — camera intrinsics → world coords + depth,
  const-accel on-surface interpolation with inherited boundary velocities,
  per-segment mode overrides, full Phase-3 JSON schema with lossless
  `keyframe: true` round-trip.

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
  within any ball's `[first-keyframe, last-keyframe]` span. Each ball
  contributes `pixel_pos`, `pixel_vel`, and `radius`.

---

## Phase 3 features

Rig presets
- Top-bar dropdown selects a camera/surface preset. The bundled **Test Rig**
  is built analytically from the Puttfinder `config.yaml` (MER2-04L-528U3M +
  4 mm lens, 2.52 m above a 10° tilted panel, axial 90°). Presets expose
  camera intrinsics/extrinsics (`matrix_world`, `focal_length_mm`,
  `sensor_width_mm`), a ball radius (`0.021335 m`), and a surface plane
  (`point`, `normal`, `proximity_threshold_m`). The preset is round-tripped in
  `header.camera` / `header.surface`.

Camera math
- `f_px = focal_mm · W / sensor_mm`. Each pixel `(x, y)` projects to a camera
  ray `(x − W/2, −(y − H/2), −1) / f_px`.
- From pixel radius `r_px`, Euclidean distance to the ball centre is
  `L = ball_radius · f_px / r_px`. The ball's world position is then
  `cam_pos + L · (R_world · ray) / |R_world · ray|`.
- `depth` is the scalar projection of `ball_world − cam_pos` onto the camera
  forward axis (`−matrix_world[:3,2]`).
- `world_vel` is a backward difference in world space at the current fps
  (`null` on the first frame of a span).

Segment-aware interpolation
- Between each pair of consecutive keyframes the tool picks a mode:
  - **Linear (in-air)** — straight-line pixel interpolation, constant
    per-frame velocity.
  - **Const-accel (on-surface)** — `v_start` is inherited from the previous
    segment's end velocity (finite difference); acceleration is solved so the
    segment lands on its end keyframe:
    `a = 2·(p₂ − p₁ − v_start·T) / T²`, `p(τ) = p₁ + v_start·τ + ½·a·τ²`
    (τ, T in frames). Isolated 2-keyframe segments fall back to linear.
- Auto-inference: if both endpoints of a segment project to within
  `proximity_threshold_m` of the surface plane, the segment is const-accel;
  otherwise linear.
- Per-segment manual override: the **Segments (active ball)** sidebar shows
  each segment with its inferred mode and a dropdown (`auto` / `linear` /
  `const_accel`). Overrides are stored in `header.segment_modes`.

Save payload (Phase-3 schema)
- `header` — `fps`, `resolution`, `frame_start/end`, `ball_radius_m`,
  `preset_id`, `camera`, `surface`, `segment_modes`.
- Each ball row — `id`, `pixel_pos`, `pixel_vel`, `radius`, `world_pos`,
  `world_vel`, `depth`, and `keyframe: true/false`. The explicit `keyframe`
  flag makes middle keyframes survive a save/load round-trip.

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
  presets.py       # rig presets (camera + surface plane)
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
