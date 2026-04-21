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
};

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
};

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
  return { balls: out, nextBallId: state.nextBallId, activeBallId: state.activeBallId };
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
  if (state.activeBallId === id) state.activeBallId = null;
  if (state.selection && state.selection.ballId === id) state.selection = null;
  renderAll();
  autoSave();
}

function sortedKeyframes(ball) {
  return [...ball.keyframes.entries()]
    .map(([frame, kf]) => ({ frame, ...kf }))
    .sort((a, b) => a.frame - b.frame);
}

function markerAt(ball, frame) {
  const kfs = sortedKeyframes(ball);
  if (kfs.length === 0) return null;
  if (frame < kfs[0].frame || frame > kfs[kfs.length - 1].frame) return null;
  for (let i = 0; i < kfs.length; i++) {
    if (kfs[i].frame === frame) {
      const radius = kfs[i].radius;
      const pos = [...kfs[i].pixel_pos];
      let vel = null;
      if (i + 1 < kfs.length) {
        const k2 = kfs[i + 1];
        vel = segmentVel(kfs[i], k2);
      } else if (i - 1 >= 0) {
        const k0 = kfs[i - 1];
        vel = segmentVel(k0, kfs[i]);
      }
      return { kind: "keyframe", pixel_pos: pos, pixel_vel: vel, radius };
    }
    if (kfs[i].frame > frame) {
      const k1 = kfs[i - 1];
      const k2 = kfs[i];
      const t = (frame - k1.frame) / (k2.frame - k1.frame);
      const pos = [
        k1.pixel_pos[0] + t * (k2.pixel_pos[0] - k1.pixel_pos[0]),
        k1.pixel_pos[1] + t * (k2.pixel_pos[1] - k1.pixel_pos[1]),
      ];
      const radius = k1.radius + t * (k2.radius - k1.radius);
      return { kind: "interp", pixel_pos: pos, pixel_vel: segmentVel(k1, k2), radius };
    }
  }
  return null;
}

function segmentVel(k1, k2) {
  const fps = state.meta && state.meta.fps > 0 ? state.meta.fps : 0;
  if (!fps) return null;
  const df = k2.frame - k1.frame;
  if (df === 0) return null;
  return [
    (k2.pixel_pos[0] - k1.pixel_pos[0]) * fps / df,
    (k2.pixel_pos[1] - k1.pixel_pos[1]) * fps / df,
  ];
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
}

function deleteKeyframe(ballId, frame) {
  const ball = state.balls.get(ballId);
  if (!ball || !ball.keyframes.has(frame)) return;
  pushHistory();
  ball.keyframes.delete(frame);
  if (ball.keyframes.size === 0) {
    state.balls.delete(ballId);
    if (state.activeBallId === ballId) state.activeBallId = null;
  }
  if (state.selection && state.selection.ballId === ballId && state.selection.frame === frame) {
    state.selection = null;
  }
  renderAll();
  autoSave();
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
    const tag = m.kind === "keyframe"
      ? `<span class="kind-tag key">KEY</span>`
      : `<span class="kind-tag interp">interp</span>`;
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

function renderAll() {
  drawOverlay();
  renderBallList();
  renderMarkerList();
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

function buildPayload() {
  const balls = [...state.balls.values()];
  const frameMin = state.meta ? state.meta.frame_start : 1;
  const frameMax = state.meta ? state.meta.frame_end : 1;
  const frames = [];
  for (let f = frameMin; f <= frameMax; f++) {
    const list = [];
    for (const ball of balls) {
      const m = markerAt(ball, f);
      if (!m) continue;
      list.push({
        id: ball.id,
        world_pos: null,
        world_vel: null,
        pixel_pos: m.pixel_pos,
        pixel_vel: m.pixel_vel,
        depth: null,
        radius: m.radius,
      });
    }
    const hasAny = list.length > 0;
    const allSpan = balls.some((b) => {
      const kfs = sortedKeyframes(b);
      return kfs.length && f >= kfs[0].frame && f <= kfs[kfs.length - 1].frame;
    });
    if (hasAny || allSpan) frames.push({
      frame: f,
      time: state.meta && state.meta.fps > 0 ? (f - 1) / state.meta.fps : null,
      balls: list,
    });
  }
  const header = state.meta ? {
    fps: state.meta.fps,
    resolution: state.meta.resolution,
    frame_start: state.meta.frame_start,
    frame_end: state.meta.frame_end,
    camera: null,
  } : { fps: null, resolution: null, frame_start: null, frame_end: null, camera: null };
  return { header, frames };
}

function ingestLoadedLabels(data) {
  state.balls.clear();
  state.nextBallId = 1;
  state.activeBallId = null;
  state.selection = null;
  state.history.undo.length = 0;
  state.history.redo.length = 0;
  if (!data || !data.frames) return;
  for (const fr of data.frames) {
    for (const b of fr.balls || []) {
      const id = b.id;
      if (!state.balls.has(id)) state.balls.set(id, { id, keyframes: new Map() });
      if (id >= state.nextBallId) state.nextBallId = id + 1;
    }
  }
  const kfFrames = new Map();
  for (const fr of data.frames) {
    for (const b of fr.balls || []) {
      if (!kfFrames.has(b.id)) kfFrames.set(b.id, []);
      kfFrames.get(b.id).push({ frame: fr.frame, pixel_pos: b.pixel_pos, radius: b.radius ?? state.defaultRadius });
    }
  }
  for (const [id, rows] of kfFrames) {
    rows.sort((a, b) => a.frame - b.frame);
    const ball = state.balls.get(id);
    if (rows.length === 0) continue;
    ball.keyframes.set(rows[0].frame, { pixel_pos: [...rows[0].pixel_pos], radius: rows[0].radius });
    if (rows.length === 1) continue;
    ball.keyframes.set(rows[rows.length - 1].frame, {
      pixel_pos: [...rows[rows.length - 1].pixel_pos],
      radius: rows[rows.length - 1].radius,
    });
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
    els.metaReadout.innerHTML = `
      <div><b>${state.meta.filename}</b></div>
      <div>${state.meta.width} × ${state.meta.height} @ ${state.meta.fps.toFixed(2)} fps</div>
      <div>${state.meta.frame_count} frames</div>
    `;
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
