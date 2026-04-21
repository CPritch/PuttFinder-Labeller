"""Thread-safe OpenCV video reader with a small frame cache."""

from __future__ import annotations

import threading
from collections import OrderedDict
from pathlib import Path
from typing import Optional

import cv2
import numpy as np


class VideoStore:
    """Holds a single open video and exposes frame reads by index.

    Frames are indexed 1-based externally (matching the sample JSON's `frame`
    field, which starts at 1), and 0-based internally for OpenCV.
    """

    CACHE_SIZE = 64

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cap: Optional[cv2.VideoCapture] = None
        self._path: Optional[Path] = None
        self._fps: float = 0.0
        self._frame_count: int = 0
        self._width: int = 0
        self._height: int = 0
        self._cache: "OrderedDict[int, bytes]" = OrderedDict()

    # ------------------------------------------------------------------ load
    def load(self, path: str) -> dict:
        p = Path(path).expanduser().resolve()
        if not p.is_file():
            raise FileNotFoundError(f"Video not found: {p}")

        cap = cv2.VideoCapture(str(p))
        if not cap.isOpened():
            raise RuntimeError(f"OpenCV could not open video: {p}")

        with self._lock:
            if self._cap is not None:
                self._cap.release()
            self._cap = cap
            self._path = p
            self._fps = float(cap.get(cv2.CAP_PROP_FPS)) or 0.0
            self._frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            self._width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            self._height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            self._cache.clear()

        return self.metadata()

    # -------------------------------------------------------------- metadata
    def metadata(self) -> dict:
        if self._cap is None or self._path is None:
            raise RuntimeError("No video loaded")
        return {
            "path": str(self._path),
            "filename": self._path.name,
            "fps": self._fps,
            "frame_count": self._frame_count,
            "frame_start": 1,
            "frame_end": self._frame_count,
            "width": self._width,
            "height": self._height,
            "resolution": [self._width, self._height],
        }

    @property
    def path(self) -> Optional[Path]:
        return self._path

    @property
    def labels_path(self) -> Optional[Path]:
        if self._path is None:
            return None
        return self._path.with_suffix(".labels.json")

    # ------------------------------------------------------------------ read
    def get_frame_png(self, frame_number: int) -> bytes:
        """Return PNG-encoded bytes for frame_number (1-based)."""
        if self._cap is None:
            raise RuntimeError("No video loaded")
        if frame_number < 1 or frame_number > self._frame_count:
            raise IndexError(
                f"Frame {frame_number} out of range [1, {self._frame_count}]"
            )

        with self._lock:
            cached = self._cache.get(frame_number)
            if cached is not None:
                self._cache.move_to_end(frame_number)
                return cached

            # OpenCV is 0-based
            self._cap.set(cv2.CAP_PROP_POS_FRAMES, frame_number - 1)
            ok, frame = self._cap.read()
            if not ok or frame is None:
                raise RuntimeError(f"Failed to read frame {frame_number}")

            # Ensure 3-channel BGR for PNG encoding; grayscale 8-bit AVIs
            # can decode as single channel depending on codec.
            if frame.ndim == 2:
                frame = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
            elif frame.shape[2] == 4:
                frame = cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)

            ok, buf = cv2.imencode(".png", frame)
            if not ok:
                raise RuntimeError("PNG encoding failed")
            data = bytes(buf)

            self._cache[frame_number] = data
            if len(self._cache) > self.CACHE_SIZE:
                self._cache.popitem(last=False)
            return data


video_store = VideoStore()
