"""Camera / rig presets for Phase 3.

Each preset returns a dict with the fields the labeller needs to convert 2D
pixel detections into 3D world coordinates plus a surface plane to inform
interpolation-mode inference.

Presets are constructed analytically from the same rig parameters the
synthetic-data pipeline uses (see the Puttfinder config.yaml). The resulting
header.camera block matches the shape of the sample master JSON so the payload
remains round-trippable.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np


GOLF_BALL_RADIUS_M = 0.021335


def _rotation_x(theta: float) -> np.ndarray:
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def _rodrigues(v: np.ndarray, axis: np.ndarray, angle: float) -> np.ndarray:
    k = axis / np.linalg.norm(axis)
    c, s = math.cos(angle), math.sin(angle)
    return v * c + np.cross(k, v) * s + k * float(k @ v) * (1.0 - c)


def _euler_xyz_from_matrix(r: np.ndarray) -> tuple[float, float, float]:
    sy = -r[2, 0]
    cy = math.sqrt(max(0.0, 1.0 - sy * sy))
    if cy > 1e-6:
        rx = math.atan2(r[2, 1], r[2, 2])
        ry = math.asin(sy)
        rz = math.atan2(r[1, 0], r[0, 0])
    else:
        rx = math.atan2(-r[1, 2], r[1, 1])
        ry = math.asin(sy)
        rz = 0.0
    return rx, ry, rz


def _test_rig() -> dict[str, Any]:
    floor_tilt_deg = 10.0
    camera_height_m = 2.52
    focal_length_mm = 4.0
    sensor_width_mm = 4.306
    resolution = (624, 540)
    fps = 200
    axial_rotation_deg = 90.0

    tilt = math.radians(floor_tilt_deg)
    axial = math.radians(axial_rotation_deg)

    # Tilt the floor's XY plane around world X → normal moves off +Z.
    normal = _rotation_x(tilt) @ np.array([0.0, 0.0, 1.0])
    cam_pos = camera_height_m * normal

    # Camera +Z axis (world) points along the plane normal (camera view is -Z).
    cam_z = normal / np.linalg.norm(normal)
    # Pre-axial "up" in image: the ramp's local +Y after tilting. Perpendicular
    # to cam_z by construction.
    ramp_up = _rotation_x(tilt) @ np.array([0.0, 1.0, 0.0])
    cam_y = _rodrigues(ramp_up, cam_z, axial)
    cam_y = cam_y / np.linalg.norm(cam_y)
    cam_x = np.cross(cam_y, cam_z)
    cam_x = cam_x / np.linalg.norm(cam_x)

    matrix_world = np.eye(4)
    matrix_world[:3, 0] = cam_x
    matrix_world[:3, 1] = cam_y
    matrix_world[:3, 2] = cam_z
    matrix_world[:3, 3] = cam_pos

    rx, ry, rz = _euler_xyz_from_matrix(matrix_world[:3, :3])

    return {
        "id": "test_rig",
        "name": "Test Rig",
        "description": (
            "MER2-04L-528U3M + 4 mm lens, 2.52 m above a 10° tilted panel, "
            "axial 90°. Built from Puttfinder config.yaml."
        ),
        "fps": fps,
        "resolution": list(resolution),
        "ball_radius_m": GOLF_BALL_RADIUS_M,
        "camera": {
            "position": cam_pos.tolist(),
            "rotation_euler": [rx, ry, rz],
            "focal_length_mm": focal_length_mm,
            "sensor_width_mm": sensor_width_mm,
            "matrix_world": matrix_world.tolist(),
        },
        "surface": {
            "point": [0.0, 0.0, 0.0],
            "normal": normal.tolist(),
            "proximity_threshold_m": 2.0 * GOLF_BALL_RADIUS_M,
        },
        "physics": {
            "gravity": [0.0, 0.0, -9.81],
            "friction": 0.4,
            "radius_tolerance_px": 0.5,
        },
    }


_PRESETS: dict[str, dict[str, Any]] = {
    "test_rig": _test_rig(),
}


def list_presets() -> list[dict[str, Any]]:
    return list(_PRESETS.values())


def get_preset(preset_id: str) -> dict[str, Any] | None:
    return _PRESETS.get(preset_id)
