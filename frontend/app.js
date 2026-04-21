// PuttFinder Labeller — Phase 1 POC
// Client-side state + I/O. Keeps the full labels dict in memory and
// auto-saves (debounced) to the master JSON beside the video.

const els = {
  videoPath: document.getElementById("videoPath"),
  loadBtn: document.getElementById("loadBtn"),
  saveBtn: document.getElementById("saveBtn"),
  saveAsBtn: document.getElementById("saveAsBtn"),
  saveStatus: document.getElementById("saveStatus"),
  frameImg: document.getElementById("frameImg"),
  overlay: document.getElementById("overlay"),
  stepBackBtn: document.getElementById("stepBackBtn"),
  playBtn: document.getElementById("playBtn"),
  stepFwdBtn: document.getElementById("stepFwdBtn"),
  frameSlider: document.getElementById("frameSlider"),
  frameInput: document.getElementById("frameInput"),
  frameTotal: document.getElementById("frameTotal"),
  timeReadout: document.getElementById("timeReadout"),
  radiusInput: document.getElementById("radiusInput"),
  markerList: document.getElementById("markerList"),
  metaReadout: document.getElementById("metaReadout"),
};

const state = {
  meta: null,                    // from /api/load_video
  currentFrame: 1,
  labels: new Map(),             // frame_number -> [{id, pixel_pos:[x,y], radius}]
  nextId: 1,
  selected: null,                // {frame, id}
  playing: false,
  playTimer: null,
  defaultRadius: 8,
  dragging: null,                // {frame, id} currently being dragged
};

// ---------------------------------------------------------------- utilities
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

// Look up markers for a frame, creating an empty list if absent.
function markersFor(frame) {
  if (!state.labels.has(frame)) state.labels.set(frame, []);
  return state.labels.get(frame);
}

// Convert a client-space mouse event into image-pixel coordinates.
function eventToImagePx(ev) {
  const rect = els.overlay.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * els.overlay.width;
  const y = ((ev.clientY - rect.top) / rect.height) * els.overlay.height;
  return [x, y];
}

// ---------------------------------------------------------------- rendering
function drawOverlay() {
  const canvas = els.overlay;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const markers = state.labels.get(state.currentFrame) || [];
  for (const m of markers) {
    const [x, y] = m.pixel_pos;
    const isSel =
      state.selected &&
      state.selected.frame === state.currentFrame &&
      state.selected.id === m.id;

    ctx.lineWidth = isSel ? 2 : 1.25;
    ctx.strokeStyle = isSel ? "#ff7043" : "#4da3ff";
    ctx.beginPath();
    ctx.arc(x, y, m.radius, 0, Math.PI * 2);
    ctx.stroke();

    // Center crosshair
    ctx.beginPath();
    ctx.moveTo(x - 3, y);
    ctx.lineTo(x + 3, y);
    ctx.moveTo(x, y - 3);
    ctx.lineTo(x, y + 3);
    ctx.stroke();

    // Label
    ctx.fillStyle = isSel ? "#ff7043" : "#4da3ff";
    ctx.font = "bold 11px ui-monospace, monospace";
    ctx.fillText(`#${m.id}`, x + m.radius + 4, y - 4);
  }
}

function renderMarkerList() {
  const markers = state.labels.get(state.currentFrame) || [];
  els.markerList.innerHTML = "";
  if (markers.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "— no markers —";
    els.markerList.appendChild(li);
    return;
  }
  for (const m of markers) {
    const li = document.createElement("li");
    const isSel =
      state.selected &&
      state.selected.frame === state.currentFrame &&
      state.selected.id === m.id;
    if (isSel) li.classList.add("selected");
    li.innerHTML = `
      <span>#${m.id}</span>
      <span>(${m.pixel_pos[0].toFixed(1)}, ${m.pixel_pos[1].toFixed(1)})</span>
      <span class="muted">r=${m.radius.toFixed(1)}</span>
      <button class="del" title="Delete">✕</button>
    `;
    li.addEventListener("click", (e) => {
      if (e.target.classList.contains("del")) return;
      state.selected = { frame: state.currentFrame, id: m.id };
      drawOverlay();
      renderMarkerList();
    });
    li.querySelector(".del").addEventListener("click", () => {
      deleteMarker(state.currentFrame, m.id);
    });
    els.markerList.appendChild(li);
  }
}

function renderFrameReadout() {
  if (!state.meta) return;
  els.frameSlider.value = state.currentFrame;
  els.frameInput.value = state.currentFrame;
  const t = state.meta.fps > 0
    ? (state.currentFrame - 1) / state.meta.fps
    : 0;
  els.timeReadout.textContent = `${t.toFixed(3)} s`;
}

// ------------------------------------------------------------- frame loading
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

  // Match canvas to natural image size on first load / resolution change.
  if (
    els.overlay.width !== els.frameImg.naturalWidth ||
    els.overlay.height !== els.frameImg.naturalHeight
  ) {
    els.overlay.width = els.frameImg.naturalWidth;
    els.overlay.height = els.frameImg.naturalHeight;
    els.frameImg.width = els.frameImg.naturalWidth;
    els.frameImg.height = els.frameImg.naturalHeight;
  }

  drawOverlay();
  renderMarkerList();
}

// ----------------------------------------------------------------- playback
function stopPlayback() {
  state.playing = false;
  els.playBtn.textContent = "Play";
  if (state.playTimer) {
    clearInterval(state.playTimer);
    state.playTimer = null;
  }
}

function startPlayback() {
  if (!state.meta) return;
  state.playing = true;
  els.playBtn.textContent = "Pause";
  const periodMs = state.meta.fps > 0 ? 1000 / state.meta.fps : 33;
  state.playTimer = setInterval(async () => {
    if (state.currentFrame >= state.meta.frame_count) {
      stopPlayback();
      return;
    }
    await showFrame(state.currentFrame + 1);
  }, periodMs);
}

function togglePlayback() {
  if (state.playing) stopPlayback();
  else startPlayback();
}

// ---------------------------------------------------------------- labels I/O
// Build the Phase-1 JSON payload. Future phases will flesh out the header
// (camera intrinsics) and the per-ball fields (world_pos, depth, vels).
function buildPayload() {
  const frames = [];
  const sortedFrames = [...state.labels.keys()].sort((a, b) => a - b);
  for (const f of sortedFrames) {
    const balls = state.labels.get(f) || [];
    if (balls.length === 0) continue;
    frames.push({
      frame: f,
      time: state.meta && state.meta.fps > 0
        ? (f - 1) / state.meta.fps
        : null,
      balls: balls.map((b) => ({
        id: b.id,
        world_pos: null,
        world_vel: null,
        pixel_pos: b.pixel_pos,
        pixel_vel: null,
        depth: null,
        // radius is a Phase-1 addition: it's captured now so Phase 3 can
        // use it for depth inference without re-labelling.
        radius: b.radius,
      })),
    });
  }

  const header = state.meta
    ? {
        fps: state.meta.fps,
        resolution: state.meta.resolution,
        frame_start: state.meta.frame_start,
        frame_end: state.meta.frame_end,
        camera: null, // populated in Phase 3
      }
    : { fps: null, resolution: null, frame_start: null, frame_end: null, camera: null };

  return { header, frames };
}

function ingestLoadedLabels(data) {
  state.labels.clear();
  state.nextId = 1;
  if (!data || !data.frames) return;
  for (const fr of data.frames) {
    const list = [];
    for (const b of fr.balls || []) {
      const radius = typeof b.radius === "number" ? b.radius : state.defaultRadius;
      list.push({ id: b.id, pixel_pos: b.pixel_pos, radius });
      if (b.id >= state.nextId) state.nextId = b.id + 1;
    }
    if (list.length) state.labels.set(fr.frame, list);
  }
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

const autoSave = debounce(saveNow, 600);

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

// ---------------------------------------------------------------- editing
function addMarkerAt(x, y) {
  const radius = Number(els.radiusInput.value) || state.defaultRadius;
  const marker = {
    id: state.nextId++,
    pixel_pos: [x, y],
    radius,
  };
  markersFor(state.currentFrame).push(marker);
  state.selected = { frame: state.currentFrame, id: marker.id };
  drawOverlay();
  renderMarkerList();
  autoSave();
}

function deleteMarker(frame, id) {
  const list = state.labels.get(frame);
  if (!list) return;
  const idx = list.findIndex((m) => m.id === id);
  if (idx < 0) return;
  list.splice(idx, 1);
  if (list.length === 0) state.labels.delete(frame);
  if (state.selected && state.selected.frame === frame && state.selected.id === id) {
    state.selected = null;
  }
  drawOverlay();
  renderMarkerList();
  autoSave();
}

// Adjust the selected marker's radius by delta (in image pixels).
function adjustSelectedRadius(delta) {
  if (!state.selected) return false;
  const list = state.labels.get(state.selected.frame);
  if (!list) return false;
  const m = list.find((x) => x.id === state.selected.id);
  if (!m) return false;
  m.radius = Math.max(1, m.radius + delta);
  els.radiusInput.value = m.radius.toFixed(1);
  drawOverlay();
  renderMarkerList();
  autoSave();
  return true;
}

// ---------------------------------------------------------------- load flow
async function loadVideo() {
  const path = els.videoPath.value.trim();
  if (!path) {
    setStatus("Enter a video path first.", true);
    return;
  }
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
    setStatus(`Loaded. ${state.labels.size} labelled frame(s) restored.`);
  } catch (e) {
    setStatus(`Load failed: ${e.message}`, true);
  }
}

// ---------------------------------------------------------------- wiring
els.loadBtn.addEventListener("click", loadVideo);
els.videoPath.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadVideo();
});

els.saveBtn.addEventListener("click", saveNow);
els.saveAsBtn.addEventListener("click", saveAs);

els.playBtn.addEventListener("click", togglePlayback);
els.stepFwdBtn.addEventListener("click", () => {
  stopPlayback();
  if (state.meta) showFrame(state.currentFrame + 1);
});
els.stepBackBtn.addEventListener("click", () => {
  stopPlayback();
  if (state.meta) showFrame(state.currentFrame - 1);
});

els.frameSlider.addEventListener("input", (e) => {
  stopPlayback();
  showFrame(Number(e.target.value));
});
els.frameInput.addEventListener("change", (e) => {
  stopPlayback();
  showFrame(Number(e.target.value));
});

els.radiusInput.addEventListener("change", () => {
  state.defaultRadius = Number(els.radiusInput.value) || state.defaultRadius;
});

// Canvas interactions: click places a marker; wheel adjusts selected radius.
els.overlay.addEventListener("click", (ev) => {
  if (!state.meta) return;
  const [x, y] = eventToImagePx(ev);

  // If the click lands on an existing marker, select it instead of adding.
  const list = state.labels.get(state.currentFrame) || [];
  for (const m of list) {
    const dx = x - m.pixel_pos[0];
    const dy = y - m.pixel_pos[1];
    if (Math.hypot(dx, dy) <= Math.max(m.radius, 4)) {
      state.selected = { frame: state.currentFrame, id: m.id };
      drawOverlay();
      renderMarkerList();
      return;
    }
  }

  addMarkerAt(x, y);
});

els.overlay.addEventListener("wheel", (ev) => {
  if (!state.meta) return;
  ev.preventDefault();
  // 1 px per notch, 0.25 with shift for fine control.
  const step = ev.shiftKey ? 0.25 : 1;
  const delta = ev.deltaY > 0 ? -step : step;
  if (!adjustSelectedRadius(delta)) {
    // No selection: bump the default radius instead.
    state.defaultRadius = Math.max(1, state.defaultRadius + delta);
    els.radiusInput.value = state.defaultRadius.toFixed(1);
  }
}, { passive: false });

// Keyboard shortcuts.
window.addEventListener("keydown", (e) => {
  const target = e.target;
  const inField =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement;
  if (inField) return;

  if (e.key === " ") { e.preventDefault(); togglePlayback(); }
  else if (e.key === "ArrowRight") { stopPlayback(); showFrame(state.currentFrame + 1); }
  else if (e.key === "ArrowLeft") { stopPlayback(); showFrame(state.currentFrame - 1); }
  else if (e.key === "Delete" || e.key === "Backspace") {
    if (state.selected) deleteMarker(state.selected.frame, state.selected.id);
  }
});
