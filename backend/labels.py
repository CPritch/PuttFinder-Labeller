"""Label persistence: read/write the master JSON alongside the video."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any


def load_labels(path: Path) -> dict | None:
    if not path.is_file():
        return None
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_labels(path: Path, payload: dict[str, Any]) -> Path:
    """Atomically write payload to path. Returns the written path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        json.dump(payload, tmp, indent=2)
        tmp_path = Path(tmp.name)
    tmp_path.replace(path)
    return path
