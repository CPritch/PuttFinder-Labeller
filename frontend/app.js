const els = {
  videoPath: document.getElementById("videoPath"),
  loadBtn: document.getElementById("loadBtn"),
  undoBtn: document.getElementById("undoBtn"),
  redoBtn: document.getElementById("redoBtn"),
  saveBtn: document.getElementById("saveBtn"),
  saveAsBtn: document.getElementById("saveAsBtn"),
  saveStatus: document.getElementById("saveStatus"),
  frameImg: document.getElementById("frameImg"),
  overlay: document.getElementById("overlay"),
  magnifier: document.getElementById("magnifier"),
  magCanvas: document.getElementById("magCanvas"),
  magCoord: document.getElementById("magCoord"),
  magZoom: document.getElementById("magZoom"),
  magToggle: document.getElementById("magToggle"),
  magZoomSel: document.getElementById("magZoomSel"),
  stepBackBtn: document.getElementById("stepBackBtn"),
  playBtn: document.getElementById("playBtn"),
  stepFwdBtn: document.getElementById("stepFwdBtn"),
  frameSlider: document.getElementById("frameSlider"),
  frameInput: document.getElementById("frameInput"),
  frameTotal: document.getElementById("frameTotal"),
  timeReadout: document.getElementById("timeReadout"),
  radiusInput: document.getElementById("radiusInput"),
  markerList: document.getElementById("markerList"),
  ballList: document.getElementById("ballList"),
  metaReadout: document.getElementById("metaReadout"),
  newBallBtn: document.getElementById("newBallBtn"),
  presetSelect: document.getElementById("presetSelect"),
  segmentList: document.getElementById("segmentList"),
};

const GOLF_BALL_RADIUS_M = 0.021335;

const BALL_COLORS = [
  "#4da3ff", "#ff7043", "#66d9a8", "#ffd166",
  "#c792ea", "#ef5350", "#26c6da", "#ffb74d",
  "#9ccc65", "#f06292",
];

const state = {
  meta: null,
  currentFrame: 1,
  balls: new Map(),
  activeBallId: null,
  selection: null,
  nextBallId: 1,
  playing: false,
  playTimer: null,
  defaultRadius: 8,
  magZoom: 8,
  magEnabled: true,
  dragging: null,
  history: { undo: [], redo: [] },
  presets: [],
  preset: null,
  segmentModes: new Map(), // key "ballId:startFrame" -> "linear" | "const_accel"
  trajectoryCache: new Map(), // ballId -> { map: Map<frame, row>, sig: string }
};

function segKey(ballId, startFrame) { return `${ballId}:${startFrame}`; }
function invalidateTrajectories() { state.trajectoryCache.clear(); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStatus(msg, isError = false) {
  els.saveStatus.textContent = msg;
  els.saveStatus.style.color = isError ? "#ff7043" : "";
}

function debounce(fn, wait) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function colorFor(ballId) {
  return BALL_COLORS[(ballId - 1) % BALL_COLORS.length];
}

function serialize() {
  const out = [];
  for (const [id, b] of state.balls) {
    const kfs = [];
    for (const [f, kf] of b.keyframes) {
      kfs.push([f, { pixel_pos: [...kf.pixel_pos], radius: kf.radius }]);
    }
    out.push([id, { id, keyframes: kfs }]);
  }
  return {
    balls: out,
    nextBallId: state.nextBallId,
    activeBallId: state.activeBallId,
    segmentModes: [...state.segmentModes.entries()],
  };
}

function restore(snap) {
  state.balls.clear();
  for (const [id, b] of snap.balls) {
    const kfMap = new Map();
    for (const [f, kf] of b.keyframes) {
      kfMap.set(f, { pixel_pos: [...kf.pixel_pos], radius: kf.radius });
    }
    state.balls.set(id, { id, keyframes: kfMap });
  }
  state.nextBallId = snap.nextBallId;
  state.activeBallId = snap.activeBallId;
  state.segmentModes = new Map(snap.segmentModes || []);
  invalidateTrajectories();
  if (state.selection) {
    const ball = state.balls.get(state.selection.ballId);
    if (!ball || !ball.keyframes.has(state.selection.frame)) state.selection = null;
  }
}

function pushHistory() {
  state.history.undo.push(serialize());
  if (state.history.undo.length > 200) state.history.undo.shift();
  state.history.redo.length = 0;
  updateUndoRedoButtons();
}

function undo() {
  if (state.history.undo.length === 0) return;
  state.history.redo.push(serialize());
  restore(state.history.undo.pop());
  renderAll();
  autoSave();
  updateUndoRedoButtons();
}

function redo() {
  if (state.history.redo.length === 0) return;
  state.history.undo.push(serialize());
  restore(state.history.redo.pop());
  renderAll();
  autoSave();
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  els.undoBtn.disabled = state.history.undo.length === 0;
  els.redoBtn.disabled = state.history.redo.length === 0;
}

function ensureActiveBall() {
  if (state.activeBallId != null && state.balls.has(state.activeBallId)) return state.activeBallId;
  const id = state.nextBallId++;
  state.balls.set(id, { id, keyframes: new Map() });
  state.activeBallId = id;
  return id;
}

function createNewBall() {
  pushHistory();
  const id = state.nextBallId++;
  state.balls.set(id, { id, keyframes: new Map() });
  state.activeBallId = id;
  renderAll();
}

function deleteBall(id) {
  if (!state.balls.has(id)) return;
  pushHistory();
  state.balls.delete(id);
  deleteBallCascade(id);
  if (state.activeBallId === id) state.activeBallId = null;
  if (state.selection && state.selection.ballId === id) state.selection = null;
  invalidateTrajectories();
  renderAll();
  autoSave();
}

// ------------------------------------------------------------ camera math
function hasCamera() {
  return !!(state.preset && state.preset.camera && state.preset.camera.matrix_world);
}

function fPx() {
  if (!hasCamera() || !state.meta) return null;
  const cam = state.preset.camera;
  const W = state.meta.width || (state.preset.resolution && state.preset.resolution[0]);
  if (!W) return null;
  return cam.focal_length_mm * W / cam.sensor_width_mm;
}

function matCol(m, i) { return [m[0][i], m[1][i], m[2][i]]; }
function matTrans(m) { return [m[0][3], m[1][3], m[2][3]]; }
function v3Add(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function v3Sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function v3Mul(a, s) { return [a[0]*s, a[1]*s, a[2]*s]; }
function v3Dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function v3Norm(a) { return Math.hypot(a[0], a[1], a[2]); }

// Camera-space ray for a pixel (x, y). Blender convention: image +x right,
// +y up; camera looks along -Z. (px, py) are in OpenCV-style top-left origin
// image coords, so py is flipped.
function pixelToCamRay(px, py) {
  const f = fPx();
  if (f == null || !state.meta) return null;
  const cx = state.meta.width / 2;
  const cy = state.meta.height / 2;
  return [(px - cx) / f, -(py - cy) / f, -1];
}

// Convert a pixel center + pixel radius into a world-space ball position
// plus depth (scalar projection along the camera forward axis).
function pixelToWorld(px, py, pixel_radius) {
  if (!hasCamera() || !state.meta) return null;
  const f = fPx();
  if (!f || !pixel_radius || pixel_radius <= 0) return null;
  const ray = pixelToCamRay(px, py);
  const rayLen = v3Norm(ray);
  // Euclidean distance from camera to ball center (small-ball approximation).
  const L = GOLF_BALL_RADIUS_M * f / pixel_radius;
  const cam = state.preset.camera;
  const R = cam.matrix_world; // column-major camera basis in world
  const xCam = matCol(R, 0), yCam = matCol(R, 1), zCam = matCol(R, 2);
  const camPos = matTrans(R);
  // World direction from camera through the pixel.
  const dirWorld = v3Add(v3Add(v3Mul(xCam, ray[0]), v3Mul(yCam, ray[1])), v3Mul(zCam, ray[2]));
  const dirLen = v3Norm(dirWorld);
  const ballWorld = v3Add(camPos, v3Mul(dirWorld, L / dirLen));
  // Depth along camera forward = -zCam (since camera looks along -Z).
  const forward = v3Mul(zCam, -1);
  const depth = v3Dot(v3Sub(ballWorld, camPos), forward);
  return { world_pos: ballWorld, depth, ray_len: rayLen };
}

function surfacePlane() {
  if (!state.preset || !state.preset.surface) return null;
  const s = state.preset.surface;
  return { point: s.point, normal: s.normal, threshold: s.proximity_threshold_m ?? 0.05 };
}

function pointToPlaneDistance(worldPos) {
  const plane = surfacePlane();
  if (!plane) return null;
  const n = plane.normal;
  const nlen = v3Norm(n);
  if (nlen === 0) return null;
  const d = v3Dot(v3Sub(worldPos, plane.point), n) / nlen;
  return d;
}

// Infer segment mode from two bounding keyframes. On-surface (both within
// threshold) → const_accel; otherwise linear.
function inferSegmentMode(k1, k2) {
  if (!hasCamera()) return "linear";
  const p1 = pixelToWorld(k1.pixel_pos[0], k1.pixel_pos[1], k1.radius);
  const p2 = pixelToWorld(k2.pixel_pos[0], k2.pixel_pos[1], k2.radius);
  if (!p1 || !p2) return "linear";
  const d1 = pointToPlaneDistance(p1.world_pos);
  const d2 = pointToPlaneDistance(p2.world_pos);
  const plane = surfacePlane();
  if (d1 == null || d2 == null || !plane) return "linear";
  const thr = plane.threshold;
  return (Math.abs(d1) <= thr && Math.abs(d2) <= thr) ? "const_accel" : "linear";
}

function resolveSegmentMode(ballId, startFrame, k1, k2) {
  const override = state.segmentModes.get(segKey(ballId, startFrame));
  if (override === "linear" || override === "const_accel") return { mode: override, source: "manual" };
  return { mode: inferSegmentMode(k1, k2), source: "auto" };
}

function sortedKeyframes(ball) {
  return [...ball.keyframes.entries()]
    .map(([frame, kf]) => ({ frame, ...kf }))
    .sort((a, b) => a.frame - b.frame);
}

function segmentsOf(ball) {
  const kfs = sortedKeyframes(ball);
  const segs = [];
  for (let i = 0; i + 1 < kfs.length; i++) {
    segs.push({ k1: kfs[i], k2: kfs[i + 1], index: i });
  }
  return { kfs, segs };
}

// Linear endpoint velocities (px/frame) for a segment.
function linearEndVelPxPerFrame(k1, k2) {
  const df = k2.frame - k1.frame;
  if (df <= 0) return [0, 0];
  return [(k2.pixel_pos[0] - k1.pixel_pos[0]) / df, (k2.pixel_pos[1] - k1.pixel_pos[1]) / df];
}

// Compute per-frame trajectory rows for a ball across [kfs[0].frame, kfs[-1].frame].
// Returns an array of rows:
//   { frame, pixel_pos:[x,y], pixel_vel:[vx,vy]|null (px/s),
//     radius, isKeyframe:bool, segIndex:int, mode:"linear"|"const_accel" }
// Const-accel segments inherit v_start from the previous segment's end velocity
// (finite difference) and choose acceleration to land on p₂ at t=T:
//   a = 2·(p₂ − p₁ − v_start·T) / T²   (T in frames)
// Isolated two-keyframe segments have no prior → fall back to linear.
function computeTrajectory(ball) {
  const cached = state.trajectoryCache.get(ball.id);
  const sig = trajectorySignature(ball);
  if (cached && cached.sig === sig) return cached.rows;
  const { kfs, segs } = segmentsOf(ball);
  const rows = [];
  if (kfs.length === 0) {
    state.trajectoryCache.set(ball.id, { sig, rows });
    return rows;
  }
  if (kfs.length === 1) {
    const k = kfs[0];
    rows.push({
      frame: k.frame, pixel_pos: [...k.pixel_pos], pixel_vel: null,
      radius: k.radius, isKeyframe: true, segIndex: -1, mode: "linear",
    });
    state.trajectoryCache.set(ball.id, { sig, rows });
    return rows;
  }

  // First pass: resolve each segment's mode and remember per-segment v_start
  // (px/frame) for const_accel, computed from prior segment's end velocity.
  const segMeta = segs.map(({ k1, k2, index }) => {
    const res = resolveSegmentMode(ball.id, k1.frame, k1, k2);
    return { k1, k2, index, mode: res.mode, source: res.source, vStart: null, accel: null };
  });
  for (let i = 0; i < segMeta.length; i++) {
    const s = segMeta[i];
    const T = s.k2.frame - s.k1.frame;
    if (s.mode === "const_accel" && T > 0) {
      // v_start from previous segment's end velocity (per frame). For the
      // first segment, there is no prior → fall back to linear.
      if (i === 0) {
        s.mode = "linear";
        s.source = s.source === "manual" ? "manual_fallback" : "auto_fallback";
      } else {
        const prev = segMeta[i - 1];
        const vPrevEnd = endVelocityPxPerFrame(prev);
        const dp = [s.k2.pixel_pos[0] - s.k1.pixel_pos[0], s.k2.pixel_pos[1] - s.k1.pixel_pos[1]];
        const a = [2 * (dp[0] - vPrevEnd[0] * T) / (T * T), 2 * (dp[1] - vPrevEnd[1] * T) / (T * T)];
        s.vStart = vPrevEnd;
        s.accel = a;
      }
    }
  }

  function endVelocityPxPerFrame(s) {
    const T = s.k2.frame - s.k1.frame;
    if (T <= 0) return [0, 0];
    if (s.mode === "const_accel" && s.vStart && s.accel) {
      return [s.vStart[0] + s.accel[0] * T, s.vStart[1] + s.accel[1] * T];
    }
    return linearEndVelPxPerFrame(s.k1, s.k2);
  }

  const fps = state.meta && state.meta.fps > 0 ? state.meta.fps : null;
  const pushRow = (frame, pos, velPerFrame, radius, isKeyframe, segIndex, mode) => {
    const vel = velPerFrame && fps
      ? [velPerFrame[0] * fps, velPerFrame[1] * fps]
      : null;
    rows.push({ frame, pixel_pos: [...pos], pixel_vel: vel, radius, isKeyframe, segIndex, mode });
  };

  // Sample each segment [k1.frame, k2.frame]; include k1 exactly once across
  // segments by emitting it only on the first segment and letting each
  // subsequent segment start at k1.frame + 1.
  for (let i = 0; i < segMeta.length; i++) {
    const s = segMeta[i];
    const { k1, k2 } = s;
    const T = k2.frame - k1.frame;
    const startF = i === 0 ? k1.frame : k1.frame + 1;
    for (let f = startF; f <= k2.frame; f++) {
      const tau = f - k1.frame;
      let pos, velPF, radius, isKf, mode;
      if (f === k1.frame) {
        pos = [...k1.pixel_pos];
        radius = k1.radius;
        isKf = true;
        mode = s.mode;
        velPF = i > 0 ? endVelocityPxPerFrame(segMeta[i - 1]) : (s.mode === "linear" ? linearEndVelPxPerFrame(k1, k2) : (s.vStart || [0, 0]));
      } else if (f === k2.frame) {
        pos = [...k2.pixel_pos];
        radius = k2.radius;
        isKf = true;
        mode = s.mode;
        velPF = endVelocityPxPerFrame(s);
      } else {
        const u = tau / T;
        if (s.mode === "const_accel") {
          const p = [
            k1.pixel_pos[0] + s.vStart[0] * tau + 0.5 * s.accel[0] * tau * tau,
            k1.pixel_pos[1] + s.vStart[1] * tau + 0.5 * s.accel[1] * tau * tau,
          ];
          pos = p;
          velPF = [s.vStart[0] + s.accel[0] * tau, s.vStart[1] + s.accel[1] * tau];
        } else {
          pos = [
            k1.pixel_pos[0] + u * (k2.pixel_pos[0] - k1.pixel_pos[0]),
            k1.pixel_pos[1] + u * (k2.pixel_pos[1] - k1.pixel_pos[1]),
          ];
          velPF = linearEndVelPxPerFrame(k1, k2);
        }
        radius = k1.radius + u * (k2.radius - k1.radius);
        isKf = false;
        mode = s.mode;
      }
      pushRow(f, pos, velPF, radius, isKf, s.index, mode);
    }
  }

  state.trajectoryCache.set(ball.id, { sig, rows });
  return rows;
}

function trajectorySignature(ball) {
  const kfs = sortedKeyframes(ball);
  const parts = kfs.map((k) => `${k.frame},${k.pixel_pos[0].toFixed(3)},${k.pixel_pos[1].toFixed(3)},${k.radius.toFixed(3)}`);
  const overrides = [];
  if (kfs.length > 0) {
    for (let i = 0; i + 1 < kfs.length; i++) {
      const m = state.segmentModes.get(segKey(ball.id, kfs[i].frame));
      if (m) overrides.push(`${kfs[i].frame}:${m}`);
    }
  }
  const preset = state.preset ? state.preset.id : "none";
  return `${preset}|${parts.join("|")}||${overrides.join(",")}`;
}

function rowAt(ball, frame) {
  const rows = computeTrajectory(ball);
  if (rows.length === 0) return null;
  if (frame < rows[0].frame || frame > rows[rows.length - 1].frame) return null;
  // Rows are dense and contiguous; direct offset lookup.
  const idx = frame - rows[0].frame;
  return rows[idx] || null;
}

function markerAt(ball, frame) {
  const r = rowAt(ball, frame);
  if (!r) return null;
  return {
    kind: r.isKeyframe ? "keyframe" : "interp",
    pixel_pos: r.pixel_pos,
    pixel_vel: r.pixel_vel,
    radius: r.radius,
    mode: r.mode,
  };
}

function addOrUpdateKeyframe(ballId, frame, pos, radius) {
  pushHistory();
  let ball = state.balls.get(ballId);
  if (!ball) {
    ball = { id: ballId, keyframes: new Map() };
    state.balls.set(ballId, ball);
  }
  const existing = ball.keyframes.get(frame);
  ball.keyframes.set(frame, {
    pixel_pos: [...pos],
    radius: radius != null ? radius : (existing ? existing.radius : state.defaultRadius),
  });
  state.selection = { ballId, frame };
  state.activeBallId = ballId;
  invalidateTrajectories();
}

function deleteKeyframe(ballId, frame) {
  const ball = state.balls.get(ballId);
  if (!ball || !ball.keyframes.has(frame)) return;
  pushHistory();
  // Drop any segment overrides that referenced this frame as a start key.
  state.segmentModes.delete(segKey(ballId, frame));
  ball.keyframes.delete(frame);
  if (ball.keyframes.size === 0) {
    state.balls.delete(ballId);
    if (state.activeBallId === ballId) state.activeBallId = null;
  }
  if (state.selection && state.selection.ballId === ballId && state.selection.frame === frame) {
    state.selection = null;
  }
  invalidateTrajectories();
  renderAll();
  autoSave();
}

function deleteBallCascade(id) {
  for (const key of [...state.segmentModes.keys()]) {
    if (key.startsWith(`${id}:`)) state.segmentModes.delete(key);
  }
}

function drawOverlay() {
  const canvas = els.overlay;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const ball of state.balls.values()) {
    const m = markerAt(ball, state.currentFrame);
    if (!m) continue;
    const [x, y] = m.pixel_pos;
    const color = colorFor(ball.id);
    const isSel = state.selection && state.selection.ballId === ball.id
      && state.selection.frame === state.currentFrame && m.kind === "keyframe";

    ctx.lineWidth = isSel ? 2 : 1.25;
    ctx.strokeStyle = color;
    if (m.kind === "interp") ctx.setLineDash([4, 3]); else ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(x, y, m.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y);
    ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3);
    ctx.stroke();

    if (m.kind === "keyframe") {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.rect(x + m.radius + 3, y - 3, 4, 4);
      ctx.fill();
    }

    ctx.fillStyle = color;
    ctx.font = "bold 11px ui-monospace, monospace";
    ctx.fillText(`#${ball.id}${m.kind === "interp" ? "·i" : ""}`, x + m.radius + 9, y + 3);
  }
}

function renderBallList() {
  els.ballList.innerHTML = "";
  const ids = [...state.balls.keys()].sort((a, b) => a - b);
  if (ids.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "— no balls yet —";
    els.ballList.appendChild(li);
    return;
  }
  for (const id of ids) {
    const ball = state.balls.get(id);
    const li = document.createElement("li");
    if (id === state.activeBallId) li.classList.add("active");
    const kfCount = ball.keyframes.size;
    const frames = [...ball.keyframes.keys()].sort((a, b) => a - b);
    const span = frames.length ? `${frames[0]}..${frames[frames.length - 1]}` : "—";
    li.innerHTML = `
      <span class="swatch" style="background:${colorFor(id)}"></span>
      <span>#${id}</span>
      <span class="muted">${kfCount} kf · ${span}</span>
      <button class="del" title="Delete ball">✕</button>
    `;
    li.addEventListener("click", (e) => {
      if (e.target.classList.contains("del")) return;
      state.activeBallId = id;
      renderBallList();
    });
    li.querySelector(".del").addEventListener("click", (e) => {
      e.stopPropagation();
      if (window.confirm(`Delete ball #${id} and all its keyframes?`)) deleteBall(id);
    });
    els.ballList.appendChild(li);
  }
}

function renderMarkerList() {
  els.markerList.innerHTML = "";
  const rows = [];
  for (const ball of state.balls.values()) {
    const m = markerAt(ball, state.currentFrame);
    if (!m) continue;
    rows.push({ ball, m });
  }
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "— no markers —";
    els.markerList.appendChild(li);
    return;
  }
  rows.sort((a, b) => a.ball.id - b.ball.id);
  for (const { ball, m } of rows) {
    const li = document.createElement("li");
    const isSel = state.selection && state.selection.ballId === ball.id
      && state.selection.frame === state.currentFrame && m.kind === "keyframe";
    if (isSel) li.classList.add("selected");
    const modeCls = m.mode === "const_accel" ? "accel" : "linear";
    const modeTag = m.mode ? `<span class="kind-tag ${modeCls}">${m.mode}</span>` : "";
    const tag = m.kind === "keyframe"
      ? `<span class="kind-tag key">KEY</span>${modeTag}`
      : `<span class="kind-tag interp">interp</span>${modeTag}`;
    const del = m.kind === "keyframe"
      ? `<button class="del" title="Delete keyframe">✕</button>`
      : "";
    li.innerHTML = `
      <span class="swatch" style="background:${colorFor(ball.id)}"></span>
      <span>#${ball.id}</span>
      ${tag}
      <span>(${m.pixel_pos[0].toFixed(1)}, ${m.pixel_pos[1].toFixed(1)})</span>
      <span class="muted">r=${m.radius.toFixed(1)}</span>
      ${del}
    `;
    li.addEventListener("click", (e) => {
      if (e.target.classList.contains("del")) return;
      state.activeBallId = ball.id;
      if (m.kind === "keyframe") state.selection = { ballId: ball.id, frame: state.currentFrame };
      drawOverlay();
      renderBallList();
      renderMarkerList();
    });
    const delBtn = li.querySelector(".del");
    if (delBtn) delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteKeyframe(ball.id, state.currentFrame);
    });
    els.markerList.appendChild(li);
  }
}

function renderFrameReadout() {
  if (!state.meta) return;
  els.frameSlider.value = state.currentFrame;
  els.frameInput.value = state.currentFrame;
  const t = state.meta.fps > 0 ? (state.currentFrame - 1) / state.meta.fps : 0;
  els.timeReadout.textContent = `${t.toFixed(3)} s`;
}

function renderSegmentList() {
  els.segmentList.innerHTML = "";
  const id = state.activeBallId;
  const ball = id != null ? state.balls.get(id) : null;
  if (!ball) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "— no active ball —";
    els.segmentList.appendChild(li);
    return;
  }
  const { segs } = segmentsOf(ball);
  if (segs.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "— need two keyframes —";
    els.segmentList.appendChild(li);
    return;
  }
  for (const { k1, k2, index } of segs) {
    const override = state.segmentModes.get(segKey(ball.id, k1.frame)) || "auto";
    const inferred = inferSegmentMode(k1, k2);
    const effective = override === "auto" ? inferred : override;
    const li = document.createElement("li");
    li.className = "segment";
    const tagCls = effective === "const_accel" ? "accel" : "linear";
    li.innerHTML = `
      <span>seg ${index + 1}</span>
      <span class="muted">${k1.frame}→${k2.frame}</span>
      <span class="kind-tag ${tagCls}">${effective}</span>
      <span class="segment-mode">
        <select title="Override mode">
          <option value="auto">auto (${inferred})</option>
          <option value="linear">linear</option>
          <option value="const_accel">const_accel</option>
        </select>
      </span>
    `;
    const sel = li.querySelector("select");
    sel.value = override;
    sel.addEventListener("change", () => {
      pushHistory();
      if (sel.value === "auto") state.segmentModes.delete(segKey(ball.id, k1.frame));
      else state.segmentModes.set(segKey(ball.id, k1.frame), sel.value);
      invalidateTrajectories();
      renderAll();
      autoSave();
    });
    els.segmentList.appendChild(li);
  }
}

function renderAll() {
  drawOverlay();
  renderBallList();
  renderMarkerList();
  renderSegmentList();
  renderFrameReadout();
  updateUndoRedoButtons();
}

async function showFrame(frameNumber) {
  if (!state.meta) return;
  const n = Math.max(1, Math.min(state.meta.frame_count, frameNumber));
  state.currentFrame = n;
  renderFrameReadout();

  const url = `/api/frame/${n}?t=${Date.now()}`;
  await new Promise((resolve, reject) => {
    els.frameImg.onload = () => resolve();
    els.frameImg.onerror = reject;
    els.frameImg.src = url;
  });
  if (els.overlay.width !== els.frameImg.naturalWidth ||
      els.overlay.height !== els.frameImg.naturalHeight) {
    els.overlay.width = els.frameImg.naturalWidth;
    els.overlay.height = els.frameImg.naturalHeight;
    els.frameImg.width = els.frameImg.naturalWidth;
    els.frameImg.height = els.frameImg.naturalHeight;
  }
  drawOverlay();
  renderMarkerList();
  renderBallList();
}

function stopPlayback() {
  state.playing = false;
  els.playBtn.textContent = "Play";
  if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; }
}

function startPlayback() {
  if (!state.meta) return;
  state.playing = true;
  els.playBtn.textContent = "Pause";
  const periodMs = state.meta.fps > 0 ? 1000 / state.meta.fps : 33;
  state.playTimer = setInterval(async () => {
    if (state.currentFrame >= state.meta.frame_count) { stopPlayback(); return; }
    await showFrame(state.currentFrame + 1);
  }, periodMs);
}

function togglePlayback() {
  if (state.playing) stopPlayback(); else startPlayback();
}

function eventToImagePx(ev) {
  const rect = els.overlay.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * els.overlay.width;
  const y = ((ev.clientY - rect.top) / rect.height) * els.overlay.height;
  return [x, y];
}

function findMarkerAtPoint(x, y) {
  const hits = [];
  for (const ball of state.balls.values()) {
    const m = markerAt(ball, state.currentFrame);
    if (!m) continue;
    const dx = x - m.pixel_pos[0];
    const dy = y - m.pixel_pos[1];
    const d = Math.hypot(dx, dy);
    if (d <= Math.max(m.radius, 4)) hits.push({ ball, m, d });
  }
  hits.sort((a, b) => a.d - b.d);
  return hits[0] || null;
}

function roundVec(v, n = 6) {
  return v == null ? null : v.map((x) => Number(x.toFixed(n)));
}

function worldVelAt(ball, f, rows, idx) {
  if (idx <= 0) return null;
  const fps = state.meta && state.meta.fps > 0 ? state.meta.fps : null;
  if (!fps) return null;
  const prev = rows[idx - 1];
  const curr = rows[idx];
  if (!prev.world_pos || !curr.world_pos) return null;
  const dt = 1 / fps;
  return [
    (curr.world_pos[0] - prev.world_pos[0]) / dt,
    (curr.world_pos[1] - prev.world_pos[1]) / dt,
    (curr.world_pos[2] - prev.world_pos[2]) / dt,
  ];
}

function buildPayload() {
  const balls = [...state.balls.values()];
  const frameMin = state.meta ? state.meta.frame_start : 1;
  const frameMax = state.meta ? state.meta.frame_end : 1;

  // Precompute per-ball dense rows + world projections (depth/world_pos) to
  // allow backward-difference world_vel.
  const perBall = new Map();
  for (const ball of balls) {
    const rows = computeTrajectory(ball);
    const enriched = rows.map((r) => {
      const w = pixelToWorld(r.pixel_pos[0], r.pixel_pos[1], r.radius);
      return {
        frame: r.frame,
        pixel_pos: r.pixel_pos,
        pixel_vel: r.pixel_vel,
        radius: r.radius,
        isKeyframe: r.isKeyframe,
        world_pos: w ? w.world_pos : null,
        depth: w ? w.depth : null,
      };
    });
    const byFrame = new Map();
    enriched.forEach((row, idx) => {
      byFrame.set(row.frame, { row, idx });
    });
    perBall.set(ball.id, { rows: enriched, byFrame });
  }

  const frames = [];
  for (let f = frameMin; f <= frameMax; f++) {
    const list = [];
    for (const ball of balls) {
      const bundle = perBall.get(ball.id);
      const found = bundle && bundle.byFrame.get(f);
      if (!found) continue;
      const { row, idx } = found;
      const worldVel = worldVelAt(ball, f, bundle.rows, idx);
      list.push({
        id: ball.id,
        world_pos: roundVec(row.world_pos),
        world_vel: roundVec(worldVel),
        pixel_pos: roundVec(row.pixel_pos, 3),
        pixel_vel: roundVec(row.pixel_vel, 3),
        depth: row.depth != null ? Number(row.depth.toFixed(6)) : null,
        radius: Number(row.radius.toFixed(3)),
        keyframe: row.isKeyframe === true ? true : false,
      });
    }
    if (list.length === 0) continue;
    frames.push({
      frame: f,
      time: state.meta && state.meta.fps > 0 ? (f - 1) / state.meta.fps : null,
      balls: list,
    });
  }

  const camera = state.preset && state.preset.camera ? state.preset.camera : null;
  const surface = state.preset && state.preset.surface ? state.preset.surface : null;
  const header = {
    fps: state.meta ? state.meta.fps : null,
    resolution: state.meta ? state.meta.resolution : null,
    frame_start: state.meta ? state.meta.frame_start : null,
    frame_end: state.meta ? state.meta.frame_end : null,
    ball_radius_m: GOLF_BALL_RADIUS_M,
    preset_id: state.preset ? state.preset.id : null,
    camera,
    surface,
    segment_modes: [...state.segmentModes.entries()].map(([k, v]) => {
      const [ballId, startFrame] = k.split(":");
      return { ball_id: Number(ballId), start_frame: Number(startFrame), mode: v };
    }),
  };
  return { header, frames };
}

function ingestLoadedLabels(data) {
  state.balls.clear();
  state.segmentModes.clear();
  state.nextBallId = 1;
  state.activeBallId = null;
  state.selection = null;
  state.history.undo.length = 0;
  state.history.redo.length = 0;
  invalidateTrajectories();
  if (!data || !data.frames) return;

  // Collect all frame/ball rows in order.
  const rowsByBall = new Map();
  for (const fr of data.frames) {
    for (const b of fr.balls || []) {
      const id = b.id;
      if (!state.balls.has(id)) state.balls.set(id, { id, keyframes: new Map() });
      if (id >= state.nextBallId) state.nextBallId = id + 1;
      if (!rowsByBall.has(id)) rowsByBall.set(id, []);
      rowsByBall.get(id).push({
        frame: fr.frame,
        pixel_pos: b.pixel_pos,
        radius: b.radius ?? state.defaultRadius,
        keyframe: b.keyframe === true,
      });
    }
  }

  for (const [id, rows] of rowsByBall) {
    rows.sort((a, b) => a.frame - b.frame);
    const ball = state.balls.get(id);
    const explicit = rows.filter((r) => r.keyframe === true);
    let chosen;
    if (explicit.length >= 1) {
      // Honor explicit keyframe flags. Always include the first and last
      // appearance as keyframes too, so span reconstruction is lossless.
      const firstRow = rows[0];
      const lastRow = rows[rows.length - 1];
      const set = new Map();
      for (const r of explicit) set.set(r.frame, r);
      set.set(firstRow.frame, firstRow);
      set.set(lastRow.frame, lastRow);
      chosen = [...set.values()].sort((a, b) => a.frame - b.frame);
    } else {
      // Legacy payload (no keyframe flags): fall back to endpoints only.
      if (rows.length === 0) continue;
      chosen = rows.length === 1 ? [rows[0]] : [rows[0], rows[rows.length - 1]];
    }
    for (const r of chosen) {
      ball.keyframes.set(r.frame, { pixel_pos: [...r.pixel_pos], radius: r.radius });
    }
  }

  // Restore segment-mode overrides from header, if present.
  const header = data.header || {};
  for (const entry of header.segment_modes || []) {
    if (!entry) continue;
    const { ball_id, start_frame, mode } = entry;
    if ((mode === "linear" || mode === "const_accel") && ball_id != null && start_frame != null) {
      state.segmentModes.set(segKey(ball_id, start_frame), mode);
    }
  }

  if (state.balls.size > 0) state.activeBallId = Math.min(...state.balls.keys());
}

async function saveNow() {
  if (!state.meta) return;
  try {
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: buildPayload() }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    setStatus(`Saved → ${data.path.split("/").pop()}  ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    setStatus(`Save failed: ${e.message}`, true);
  }
}

const autoSave = debounce(saveNow, 500);

async function saveAs() {
  if (!state.meta) return;
  const defaultName = state.meta.filename.replace(/\.[^.]+$/, "") + ".labels.json";
  const name = window.prompt("Save as (filename, stored next to video):", defaultName);
  if (!name) return;
  try {
    const res = await fetch("/api/save_as", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: buildPayload(), filename: name }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    setStatus(`Saved copy → ${data.path.split("/").pop()}`);
  } catch (e) {
    setStatus(`Save-As failed: ${e.message}`, true);
  }
}

async function loadVideo() {
  const path = els.videoPath.value.trim();
  if (!path) { setStatus("Enter a video path first.", true); return; }
  stopPlayback();
  setStatus("Loading…");
  try {
    const res = await fetch("/api/load_video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const data = await res.json();
    state.meta = data.metadata;
    ingestLoadedLabels(data.labels);

    els.frameSlider.min = 1;
    els.frameSlider.max = state.meta.frame_count;
    els.frameInput.min = 1;
    els.frameInput.max = state.meta.frame_count;
    els.frameTotal.textContent = `/ ${state.meta.frame_count}`;
    updateMetaReadout();
    await showFrame(1);
    renderAll();
    setStatus(`Loaded. ${state.balls.size} ball(s) restored.`);
  } catch (e) {
    setStatus(`Load failed: ${e.message}`, true);
  }
}

function updateMagnifier(ev) {
  if (!state.magEnabled || !state.meta) { els.magnifier.classList.add("hidden"); return; }
  const [x, y] = eventToImagePx(ev);
  if (x < 0 || y < 0 || x >= els.overlay.width || y >= els.overlay.height) {
    els.magnifier.classList.add("hidden");
    return;
  }
  const zoom = state.magZoom;
  const size = els.magCanvas.width;
  const src = size / zoom;
  const sx = x - src / 2;
  const sy = y - src / 2;
  const ctx = els.magCanvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(els.frameImg, sx, sy, src, src, 0, 0, size, size);

  ctx.strokeStyle = "#ffd166";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2);
  ctx.stroke();

  for (const ball of state.balls.values()) {
    const m = markerAt(ball, state.currentFrame);
    if (!m) continue;
    const mx = (m.pixel_pos[0] - sx) * zoom;
    const my = (m.pixel_pos[1] - sy) * zoom;
    if (mx < -20 || my < -20 || mx > size + 20 || my > size + 20) continue;
    ctx.strokeStyle = colorFor(ball.id);
    ctx.lineWidth = 1.5;
    if (m.kind === "interp") ctx.setLineDash([4, 3]); else ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(mx, my, m.radius * zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  els.magCoord.textContent = `${x.toFixed(1)}, ${y.toFixed(1)}`;
  els.magZoom.textContent = `${zoom}×`;

  const vp = document.getElementById("viewport").getBoundingClientRect();
  let left = ev.clientX - vp.left + 20;
  let top = ev.clientY - vp.top + 20;
  const magW = els.magnifier.offsetWidth || 200;
  const magH = els.magnifier.offsetHeight || 210;
  if (left + magW > vp.width) left = ev.clientX - vp.left - magW - 20;
  if (top + magH > vp.height) top = ev.clientY - vp.top - magH - 20;
  els.magnifier.style.left = `${Math.max(4, left)}px`;
  els.magnifier.style.top = `${Math.max(4, top)}px`;
  els.magnifier.classList.remove("hidden");
}

async function loadPresets() {
  try {
    const res = await fetch("/api/presets");
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    state.presets = data.presets || [];
    els.presetSelect.innerHTML = "";
    for (const p of state.presets) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name || p.id;
      els.presetSelect.appendChild(opt);
    }
    if (state.presets.length > 0) {
      state.preset = state.presets[0];
      els.presetSelect.value = state.preset.id;
      updateMetaReadout();
    }
  } catch (e) {
    setStatus(`Presets failed: ${e.message}`, true);
  }
}

function updateMetaReadout() {
  const metaLines = [];
  if (state.meta) {
    metaLines.push(`<div><b>${state.meta.filename}</b></div>`);
    metaLines.push(`<div>${state.meta.width} × ${state.meta.height} @ ${state.meta.fps.toFixed(2)} fps</div>`);
    metaLines.push(`<div>${state.meta.frame_count} frames</div>`);
  } else {
    metaLines.push(`<div>No video loaded.</div>`);
  }
  if (state.preset) {
    const cam = state.preset.camera || {};
    const pos = cam.position || [0, 0, 0];
    const f = fPx();
    metaLines.push(`<hr/>`);
    metaLines.push(`<div><b>Rig:</b> ${state.preset.name || state.preset.id}</div>`);
    metaLines.push(`<div>focal ${cam.focal_length_mm} mm · sensor ${cam.sensor_width_mm} mm</div>`);
    metaLines.push(`<div>f<sub>px</sub> ${f != null ? f.toFixed(2) : "—"}</div>`);
    metaLines.push(`<div>cam pos (${pos.map((x) => x.toFixed(3)).join(", ")}) m</div>`);
    metaLines.push(`<div>ball r ${state.preset.ball_radius_m} m</div>`);
  }
  els.metaReadout.innerHTML = metaLines.join("");
}

els.presetSelect.addEventListener("change", () => {
  const p = state.presets.find((x) => x.id === els.presetSelect.value);
  if (p) {
    state.preset = p;
    invalidateTrajectories();
    updateMetaReadout();
    renderAll();
    autoSave();
  }
});

els.loadBtn.addEventListener("click", loadVideo);
els.videoPath.addEventListener("keydown", (e) => { if (e.key === "Enter") loadVideo(); });
els.saveBtn.addEventListener("click", saveNow);
els.saveAsBtn.addEventListener("click", saveAs);
els.undoBtn.addEventListener("click", undo);
els.redoBtn.addEventListener("click", redo);
els.newBallBtn.addEventListener("click", createNewBall);

els.playBtn.addEventListener("click", togglePlayback);
els.stepFwdBtn.addEventListener("click", () => { stopPlayback(); if (state.meta) showFrame(state.currentFrame + 1); });
els.stepBackBtn.addEventListener("click", () => { stopPlayback(); if (state.meta) showFrame(state.currentFrame - 1); });

els.frameSlider.addEventListener("input", (e) => { stopPlayback(); showFrame(Number(e.target.value)); });
els.frameInput.addEventListener("change", (e) => { stopPlayback(); showFrame(Number(e.target.value)); });
els.radiusInput.addEventListener("change", () => {
  state.defaultRadius = Number(els.radiusInput.value) || state.defaultRadius;
});
els.magToggle.addEventListener("change", () => {
  state.magEnabled = els.magToggle.checked;
  if (!state.magEnabled) els.magnifier.classList.add("hidden");
});
els.magZoomSel.addEventListener("change", () => {
  state.magZoom = Number(els.magZoomSel.value);
});

els.overlay.addEventListener("mousedown", (ev) => {
  if (!state.meta) return;
  if (ev.button !== 0) return;
  const [x, y] = eventToImagePx(ev);
  const hit = findMarkerAtPoint(x, y);
  if (hit) {
    state.activeBallId = hit.ball.id;
    if (hit.m.kind === "keyframe") {
      state.selection = { ballId: hit.ball.id, frame: state.currentFrame };
      state.dragging = { ballId: hit.ball.id, frame: state.currentFrame, offset: [x - hit.m.pixel_pos[0], y - hit.m.pixel_pos[1]], startedHistory: false };
    } else {
      pushHistory();
      addOrUpdateKeyframe(hit.ball.id, state.currentFrame, hit.m.pixel_pos, hit.m.radius);
      state.dragging = { ballId: hit.ball.id, frame: state.currentFrame, offset: [x - hit.m.pixel_pos[0], y - hit.m.pixel_pos[1]], startedHistory: true };
      renderAll();
      autoSave();
    }
  } else {
    const ballId = ensureActiveBall();
    pushHistory();
    addOrUpdateKeyframe(ballId, state.currentFrame, [x, y], state.defaultRadius);
    state.dragging = { ballId, frame: state.currentFrame, offset: [0, 0], startedHistory: true };
    renderAll();
    autoSave();
  }
});

window.addEventListener("mousemove", (ev) => {
  if (state.dragging && state.meta) {
    const [x, y] = eventToImagePx(ev);
    const { ballId, frame, offset } = state.dragging;
    const ball = state.balls.get(ballId);
    if (ball && ball.keyframes.has(frame)) {
      const kf = ball.keyframes.get(frame);
      kf.pixel_pos = [x - offset[0], y - offset[1]];
      invalidateTrajectories();
      drawOverlay();
      renderMarkerList();
    }
  }
  if (ev.target === els.overlay || state.dragging) {
    updateMagnifier(ev);
  }
});

window.addEventListener("mouseup", () => {
  if (state.dragging) {
    state.dragging = null;
    autoSave();
  }
});

els.overlay.addEventListener("mouseleave", () => {
  if (!state.dragging) els.magnifier.classList.add("hidden");
});
els.overlay.addEventListener("mouseenter", () => {
  if (state.magEnabled) els.magnifier.classList.remove("hidden");
});

els.overlay.addEventListener("wheel", (ev) => {
  if (!state.meta) return;
  ev.preventDefault();
  const step = ev.shiftKey ? 0.25 : 1;
  const delta = ev.deltaY > 0 ? -step : step;
  if (state.selection) {
    const ball = state.balls.get(state.selection.ballId);
    if (ball && ball.keyframes.has(state.selection.frame)) {
      pushHistory();
      const kf = ball.keyframes.get(state.selection.frame);
      kf.radius = Math.max(1, kf.radius + delta);
      invalidateTrajectories();
      els.radiusInput.value = kf.radius.toFixed(1);
      renderAll();
      autoSave();
      return;
    }
  }
  state.defaultRadius = Math.max(1, state.defaultRadius + delta);
  els.radiusInput.value = state.defaultRadius.toFixed(1);
}, { passive: false });

window.addEventListener("keydown", (e) => {
  const t = e.target;
  const inField = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
  if (inField) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
    e.preventDefault(); redo(); return;
  }
  if (e.key === " ") { e.preventDefault(); togglePlayback(); }
  else if (e.key === "ArrowRight") { stopPlayback(); showFrame(state.currentFrame + 1); }
  else if (e.key === "ArrowLeft") { stopPlayback(); showFrame(state.currentFrame - 1); }
  else if (e.key === "Delete" || e.key === "Backspace") {
    if (state.selection) deleteKeyframe(state.selection.ballId, state.selection.frame);
  } else if (e.key.toLowerCase() === "n") {
    createNewBall();
  }
});

updateUndoRedoButtons();
loadPresets();
