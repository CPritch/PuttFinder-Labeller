"""FastAPI app: serves the labeling UI, video frames, and label I/O."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .labels import load_labels, save_labels
from .video_store import video_store

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"

app = FastAPI(title="PuttFinder Labeller", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class LoadVideoRequest(BaseModel):
    path: str


class SavePayload(BaseModel):
    payload: dict[str, Any] = Field(default_factory=dict)
    filename: str | None = None  # only used for save-as


# ---------------------------------------------------------------- API routes
@app.post("/api/load_video")
def api_load_video(body: LoadVideoRequest):
    try:
        meta = video_store.load(body.path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(e))

    labels_path = video_store.labels_path
    existing = load_labels(labels_path) if labels_path else None
    return {"metadata": meta, "labels": existing}


@app.get("/api/metadata")
def api_metadata():
    try:
        return video_store.metadata()
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/frame/{frame_number}")
def api_frame(frame_number: int):
    try:
        data = video_store.get_frame_png(frame_number)
    except IndexError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/labels")
def api_get_labels():
    labels_path = video_store.labels_path
    if labels_path is None:
        raise HTTPException(status_code=400, detail="No video loaded")
    data = load_labels(labels_path)
    return {"path": str(labels_path), "labels": data}


@app.post("/api/save")
def api_save(body: SavePayload):
    """Auto-save: overwrites the master JSON beside the video."""
    labels_path = video_store.labels_path
    if labels_path is None:
        raise HTTPException(status_code=400, detail="No video loaded")
    written = save_labels(labels_path, body.payload)
    return {"status": "ok", "path": str(written)}


@app.post("/api/save_as")
def api_save_as(body: SavePayload):
    """Save-as: writes a new JSON next to the video using provided filename."""
    if video_store.path is None:
        raise HTTPException(status_code=400, detail="No video loaded")
    if not body.filename:
        raise HTTPException(status_code=400, detail="filename is required")

    # Keep writes beside the video to avoid arbitrary filesystem writes.
    safe_name = Path(body.filename).name
    if not safe_name.endswith(".json"):
        safe_name += ".json"
    target = video_store.path.parent / safe_name
    written = save_labels(target, body.payload)
    return {"status": "ok", "path": str(written)}


# -------------------------------------------------------------- Static UI
@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")
