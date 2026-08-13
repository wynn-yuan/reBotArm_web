"""Gravity-compensation model for the reBot B601-RS arm.

Parses the URDF model to extract per-link mass, centre-of-mass, and joint
geometry, then computes the joint-space gravity torque vector with a pure
recursive Newton-Euler backward pass (gravity only — no velocity or
acceleration terms).  The result is a 7-element list of motor-side torque
feedforward values (N·m) suitable for the ``tau_ff`` argument of the
motorbridge SDK ``Motor.send_mit``.

No external dependencies beyond numpy and the standard library.
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from typing import Optional, Sequence

import numpy as np


# Gravity vector in the world frame (Z-up URDF convention: gravity is -Z).
_GRAVITY = np.array([0.0, 0.0, -9.81], dtype=np.float64)

# Only 6 revolute joints carry gravity torque.  The gripper (J7) is a
# prismatic joint and does not produce a gravity torque about its axis.
_REVOLUTE_JOINT_COUNT = 6


def _rpy_to_rotation(rpy: Sequence[float]) -> np.ndarray:
    """Build a 3×3 rotation matrix from roll-pitch-yaw (fixed-axis X-Y-Z)."""
    r, p, y = float(rpy[0]), float(rpy[1]), float(rpy[2])
    cr, sr = math.cos(r), math.sin(r)
    cp, sp = math.cos(p), math.sin(p)
    cy, sy = math.cos(y), math.sin(y)
    return np.array(
        [
            [cp * cy, -cp * sy, sp],
            [cr * sy + sr * sp * cy, cr * cy - sr * sp * sy, -sr * cp],
            [sr * sy - cr * sp * cy, sr * cy + cr * sp * sy, cr * cp],
        ],
        dtype=np.float64,
    )


def _build_transform(origin_xyz: Sequence[float], origin_rpy: Sequence[float]) -> np.ndarray:
    """Build a 4×4 homogeneous transform from an URDF <origin>."""
    T = np.eye(4, dtype=np.float64)
    T[:3, :3] = _rpy_to_rotation(origin_rpy)
    T[0, 3] = float(origin_xyz[0])
    T[1, 3] = float(origin_xyz[1])
    T[2, 3] = float(origin_xyz[2])
    return T


def _rotation_about_axis(axis_xyz: Sequence[float], angle: float) -> np.ndarray:
    """Build a 3×3 rotation matrix about *axis_xyz* by *angle* radians."""
    ax = np.array([float(axis_xyz[0]), float(axis_xyz[1]), float(axis_xyz[2])], dtype=np.float64)
    norm = np.linalg.norm(ax)
    if norm < 1e-12:
        return np.eye(3, dtype=np.float64)
    ax = ax / norm
    c = math.cos(angle)
    s = math.sin(angle)
    v = 1.0 - c
    return np.array(
        [
            [c + ax[0] * ax[0] * v, ax[0] * ax[1] * v - ax[2] * s, ax[0] * ax[2] * v + ax[1] * s],
            [ax[1] * ax[0] * v + ax[2] * s, c + ax[1] * ax[1] * v, ax[1] * ax[2] * v - ax[0] * s],
            [ax[2] * ax[0] * v - ax[1] * s, ax[2] * ax[1] * v + ax[0] * s, c + ax[2] * ax[2] * v],
        ],
        dtype=np.float64,
    )


class GravityModel:
    """Gravity torque calculator for the reBot B601-RS.

    Parameters
    ----------
    urdf_path : str
        Path to the URDF model file.
    compensation_factors : sequence of float, optional
        Per-joint scaling factors (7 elements).  Defaults to all-ones.

    Usage::

        model = GravityModel("rebot-b601-rs.urdf")
        tau_g = model.compute([0.0, 1.57, 0.0, 0.0, 0.0, 0.0, 0.0])
        # tau_g → [τ1, τ2, τ3, τ4, τ5, τ6, 0.0]  (N·m, motor side)
    """

    def __init__(
        self,
        urdf_path: str,
        compensation_factors: Optional[Sequence[float]] = None,
    ) -> None:
        self._joints: list[dict] = []  # ordered J1..J6
        self._compensation = list(compensation_factors) if compensation_factors else [1.0] * 7
        if len(self._compensation) != 7:
            raise ValueError("compensation_factors must have exactly 7 elements")
        self._parse_urdf(urdf_path)

    # ── URDF parsing ──────────────────────────────────────────────────────

    def _parse_urdf(self, path: str) -> None:
        tree = ET.parse(path)
        root = tree.getroot()

        # Collect link masses and COMs by name.
        links: dict[str, dict] = {}
        for el in root.findall("link"):
            name = el.get("name", "")
            inertial = el.find("inertial")
            mass = 0.0
            com_xyz = (0.0, 0.0, 0.0)
            if inertial is not None:
                mass_el = inertial.find("mass")
                if mass_el is not None:
                    mass = float(mass_el.get("value", "0"))
                origin_el = inertial.find("origin")
                if origin_el is not None:
                    com_xyz = self._parse_xyz(origin_el, "xyz", (0.0, 0.0, 0.0))
            links[name] = {"mass": mass, "com": com_xyz}

        # Walk the kinematic chain: parent → child via joints.
        # The URDF has the chain: base_link → joint1 → link1 → joint2 → link2 → ...
        # We only care about the 6 revolute joints (J1..J6).
        parent_map: dict[str, str] = {}  # child → parent
        joint_info: dict[str, dict] = {}  # child → joint data
        for el in root.findall("joint"):
            jtype = el.get("type", "")
            if jtype not in ("revolute", "continuous"):
                continue
            pname = el.find("parent")
            cname = el.find("child")
            if pname is None or cname is None:
                continue
            parent = pname.get("link", "")
            child = cname.get("link", "")
            parent_map[child] = parent
            origin_el = el.find("origin")
            origin_xyz = self._parse_xyz(origin_el, "xyz", (0.0, 0.0, 0.0))
            origin_rpy = self._parse_xyz(origin_el, "rpy", (0.0, 0.0, 0.0))
            axis_el = el.find("axis")
            axis_xyz = self._parse_xyz(axis_el, "xyz", (0.0, 0.0, 1.0))
            joint_info[child] = {
                "parent": parent,
                "origin_xyz": origin_xyz,
                "origin_rpy": origin_rpy,
                "axis": axis_xyz,
            }

        # Build the ordered list of revolute joints (J1..J6).
        # Start from link1, follow the chain.
        child = "link1"
        while child in parent_map:
            parent = parent_map[child]
            ji = joint_info.get(child)
            if ji is None:
                break
            li = links.get(child, {"mass": 0.0, "com": (0.0, 0.0, 0.0)})
            self._joints.append(
                {
                    "parent": parent,
                    "child": child,
                    "origin_xyz": ji["origin_xyz"],
                    "origin_rpy": ji["origin_rpy"],
                    "axis": ji["axis"],
                    "mass": li["mass"],
                    "com": li["com"],
                    "T_origin": _build_transform(ji["origin_xyz"], ji["origin_rpy"]),
                }
            )
            child = self._next_child(parent_map, child)

        # Add fixed links downstream of the last revolute joint (gripper mass).
        # These contribute to the gravity torque of all upstream joints.
        self._fixed_links: list[dict] = []
        last_child = self._joints[-1]["child"] if self._joints else None
        if last_child:
            self._collect_fixed_links(last_child, parent_map, links, joint_info)

        if len(self._joints) != _REVOLUTE_JOINT_COUNT:
            raise ValueError(
                f"expected {_REVOLUTE_JOINT_COUNT} revolute joints, found {len(self._joints)}"
            )

    def _next_child(self, parent_map: dict[str, str], current: str) -> str:
        """Find the next link in the chain that has 'current' as parent."""
        for child, parent in parent_map.items():
            if parent == current:
                return child
        return ""

    def _collect_fixed_links(
        self,
        start: str,
        parent_map: dict[str, str],
        links: dict[str, dict],
        joint_info: dict[str, dict],
    ) -> None:
        """Recursively collect fixed-link masses downstream of *start*."""
        # Find children of *start* that are not revolute joints.
        children = [c for c, p in parent_map.items() if p == start]
        for child in children:
            ji = joint_info.get(child)
            if ji is not None:
                # This is a revolute joint — shouldn't happen downstream of J6.
                continue
            # Fixed link: find its mass and COM.
            li = links.get(child, {"mass": 0.0, "com": (0.0, 0.0, 0.0)})
            # Find the fixed joint connecting start → child.
            self._fixed_links.append(
                {
                    "parent": start,
                    "child": child,
                    "mass": li["mass"],
                    "com": li["com"],
                }
            )
            self._collect_fixed_links(child, parent_map, links, joint_info)

    @staticmethod
    def _parse_xyz(
        el: Optional[ET.Element],
        attr: str,
        default: tuple[float, float, float],
    ) -> tuple[float, float, float]:
        if el is None:
            return default
        raw = el.get(attr, "")
        if not raw:
            return default
        parts = raw.split()
        if len(parts) != 3:
            return default
        return (float(parts[0]), float(parts[1]), float(parts[2]))

    # ── Gravity computation ───────────────────────────────────────────────

    def compute(self, q: Sequence[float]) -> list[float]:
        """Compute gravity torque for each motor given joint angles *q* (rad).

        Parameters
        ----------
        q : sequence of float
            Joint angles in radians, ordered J1..J7.  Only J1..J6 are used;
            J7 (gripper) torque is always zero.

        Returns
        -------
        list of float
            Gravity torque for each of the 7 motors (N·m, motor side).
            J7 is always 0.0.
        """
        if len(q) < _REVOLUTE_JOINT_COUNT:
            raise ValueError(f"expected at least {_REVOLUTE_JOINT_COUNT} joint angles")

        # ── Forward kinematics ──────────────────────────────────────────
        # Compute world-frame transforms and COM positions for each link.
        T = np.eye(4, dtype=np.float64)  # world-from-parent transform
        com_world: list[np.ndarray] = []  # world-frame COM of each link
        joint_world: list[np.ndarray] = []  # world-frame joint origin
        axis_world: list[np.ndarray] = []  # world-frame joint axis
        masses: list[float] = []  # per-link mass

        for i, joint in enumerate(self._joints):
            T_joint = joint["T_origin"]
            # Rotation about the joint axis
            R_q = _rotation_about_axis(joint["axis"], float(q[i]))
            T_rot = np.eye(4, dtype=np.float64)
            T_rot[:3, :3] = R_q

            T = T @ T_joint @ T_rot
            joint_world.append(T[:3, 3].copy())

            # COM in world frame
            com_local = np.array(
                [joint["com"][0], joint["com"][1], joint["com"][2], 1.0],
                dtype=np.float64,
            )
            com_w = (T @ com_local)[:3]
            com_world.append(com_w)

            # Joint axis in world frame
            ax_local = np.array(
                [joint["axis"][0], joint["axis"][1], joint["axis"][2], 0.0],
                dtype=np.float64,
            )
            ax_w = (T @ ax_local)[:3]
            ax_w = ax_w / np.linalg.norm(ax_w) if np.linalg.norm(ax_w) > 1e-12 else ax_w
            axis_world.append(ax_w)

            masses.append(joint["mass"])

        # Add fixed links (gripper assembly) to the last link's COM list.
        # Their mass contributes to the gravity torque of all upstream joints.
        extra_masses: list[tuple[np.ndarray, float]] = []  # (com_world, mass)
        for fl in self._fixed_links:
            parent_idx = self._find_parent_index(fl["parent"])
            if parent_idx < 0:
                continue
            T_parent = np.eye(4, dtype=np.float64)
            T_parent[:3, 3] = joint_world[parent_idx]
            # The fixed link's COM is given in the link's own frame; we need
            # the transform from parent to this link.  For the URDF structure
            # here, the fixed joint origin directly gives the transform.
            com_local = np.array([fl["com"][0], fl["com"][1], fl["com"][2], 1.0], dtype=np.float64)
            com_w = (T_parent @ com_local)[:3]
            extra_masses.append((com_w, fl["mass"]))

        # ── Gravity torque computation (backward pass) ────────────────────
        # For each joint i, the gravity torque is:
        #   τ_i = axis_i · Σ_{j ≥ i} (COM_j_world - joint_i_world) × (m_j × g)
        # where j runs over all links downstream of joint i, including fixed links.

        tau_g = [0.0] * _REVOLUTE_JOINT_COUNT

        for i in range(_REVOLUTE_JOINT_COUNT):
            moment = np.zeros(3, dtype=np.float64)

            # Contribution from revolute links downstream of i
            for j in range(i, _REVOLUTE_JOINT_COUNT):
                r = com_world[j] - joint_world[i]
                moment += np.cross(masses[j] * _GRAVITY, r)

            # Contribution from fixed links
            for com_w, mass in extra_masses:
                r = com_w - joint_world[i]
                moment += np.cross(mass * _GRAVITY, r)

            # Project onto joint axis
            tau_g[i] = float(np.dot(axis_world[i], moment))

        # Apply per-joint compensation factors (motor-side torques).
        tau_g = [tau_g[i] * self._compensation[i] for i in range(_REVOLUTE_JOINT_COUNT)]

        # J7 (gripper) always has zero gravity torque.
        return tau_g + [0.0]

    def _find_parent_index(self, parent_name: str) -> int:
        """Find the joint index whose child link matches *parent_name*."""
        for i, joint in enumerate(self._joints):
            if joint["child"] == parent_name:
                return i
        return -1