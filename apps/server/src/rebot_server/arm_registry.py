"""机械臂机型注册表（平台唯一真源）。

每款机型 = ``<arm_config_root>/<arm_id>/model.yaml`` 一个自包含文件夹
（同目录还有 ``model.urdf`` 与 ``meshes/``）。后端扫描/老化/重力、前端
3D/标签/限位/遥测校验都从这里的 :class:`ArmModel` 派生。

依赖：标准库 + PyYAML。本模块不 import 包内其它模块（避免与 config.py 循环）。

容忍加载：未知 key 忽略、缺省可选 key 用默认值；承重字段 fail closed
（:class:`ArmRegistryError`，服务应转为启动失败）。
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence, Union

import yaml

LOGGER = logging.getLogger(__name__)

#: motorbridge 0.5.1 SDK 支持的子电机厂商（与 add_<vendor>_motor 一一对应）。
SUPPORTED_VENDORS = ("robstride", "damiao", "myactuator", "hightorque")

DEFAULT_HOST_ID = 0xFD
DEFAULT_MODEL_SCALE = 2.5
DEFAULT_MODEL_ROTATION_X = -1.5707963267948966  # -pi/2（z 轴朝上 → 屏幕 Y 轴）
DEFAULT_MODEL_POSITION = (0.0, -1.2, 0.0)
DEFAULT_GRAVITY_REVOLUTE_COUNT = 6
DEFAULT_ROOT_LINK = "link1"

_ARM_CONFIG_DIR_ENV = "REBOT_ARM_CONFIG_DIR"


class ArmRegistryError(ValueError):
    """机型配置缺失或非法，平台按 fail-closed 处理。"""


@dataclass(frozen=True)
class MotorSpec:
    """一个转动关节的子电机定义（J1..J6）。"""

    id: int
    vendor: str = "robstride"
    model: str = ""                        # robstride: rs-06 / rs-00 ...
    name: str = ""                         # "J1"
    label: str = ""                        # "基座旋转"
    axis: str = "rotational"               # yaw|pitch|roll
    position_limit: Optional[tuple[float, float]] = None
    mit_kp: Optional[float] = None
    mit_kd: Optional[float] = None
    feedback_id: Optional[int] = None      # None → 用 arm.host_id
    urdf_name: Optional[str] = None        # None → f"joint{id}"


@dataclass(frozen=True)
class GripperSpec:
    """夹爪子电机定义（可选，B601 的 id=7）。"""

    id: int
    vendor: str = "robstride"
    model: str = ""
    name: str = "Gripper"
    label: str = "夹爪"
    axis: str = "grip"
    position_limit: Optional[tuple[float, float]] = None
    mit_kp: Optional[float] = None
    mit_kd: Optional[float] = None
    left_joint: str = "joint_left"
    right_joint: str = "joint_right"


@dataclass(frozen=True)
class ArmModel:
    """一款机械臂的完整定义。所有数值都应来自 model.yaml，代码里不写死。"""

    arm_id: str
    name: str
    vendor: str
    host_id: int
    motors: tuple[MotorSpec, ...]
    gripper: Optional[GripperSpec] = None
    gravity_revolute_count: int = DEFAULT_GRAVITY_REVOLUTE_COUNT
    root_link: str = DEFAULT_ROOT_LINK
    model_scale: float = DEFAULT_MODEL_SCALE
    model_rotation_x: float = DEFAULT_MODEL_ROTATION_X
    model_position: tuple[float, float, float] = DEFAULT_MODEL_POSITION

    # ---- 派生属性 ------------------------------------------------
    @property
    def motor_ids(self) -> tuple[int, ...]:
        return tuple(m.id for m in self.motors)

    @property
    def joint_count(self) -> int:
        return len(self.motors)

    @property
    def motor_map(self) -> dict[int, MotorSpec]:
        return {m.id: m for m in self.motors}

    @property
    def joint_limits(self) -> tuple[tuple[float, float], ...]:
        """按 motors 顺序的关节限位；未配置的用 ±∞（等价"无限制"）。"""
        return tuple(
            m.position_limit if m.position_limit is not None
            else (float("-inf"), float("inf"))
            for m in self.motors
        )

    @property
    def mit_kp(self) -> tuple[Optional[float], ...]:
        return tuple(m.mit_kp for m in self.motors)

    @property
    def mit_kd(self) -> tuple[Optional[float], ...]:
        return tuple(m.mit_kd for m in self.motors)

    # ---- 完整链路派生（转动关节 + 夹爪） -----------------------------
    # ``motor_ids``/``joint_count`` 只含转动关节（前端旋转关节视图）；
    # 扫描/老化/遥测/MIT 增益需要把夹爪（如有）也纳入，用下面这些。

    @property
    def joint_ids(self) -> tuple[int, ...]:
        """完整链路电机 ID（转动关节 + 夹爪）。"""
        ids = list(self.motor_ids)
        if self.gripper is not None:
            ids.append(self.gripper.id)
        return tuple(ids)

    @property
    def joint_positions(self) -> tuple[tuple[float, float], ...]:
        """按完整链路顺序的关节限位（含夹爪；未配置用 ±∞）。"""
        limits = list(self.joint_limits)
        if self.gripper is not None:
            limits.append(
                self.gripper.position_limit
                if self.gripper.position_limit is not None
                else (float("-inf"), float("inf"))
            )
        return tuple(limits)

    @property
    def joint_mit_kp(self) -> tuple[Optional[float], ...]:
        return tuple(self.mit_kp) + ((self.gripper.mit_kp,) if self.gripper else ())

    @property
    def joint_mit_kd(self) -> tuple[Optional[float], ...]:
        return tuple(self.mit_kd) + ((self.gripper.mit_kd,) if self.gripper else ())

    def spec_for(self, motor_id: int):
        """任意链路电机 id → MotorSpec 或 GripperSpec（未知 id 返回 None）。

        扫描/激活上报的注册循环用它取 vendor/model/feedback_id。
        """
        if self.gripper is not None and self.gripper.id == motor_id:
            return self.gripper
        return self.motor_map.get(motor_id)

    def urdf_name_for(self, motor_id: int) -> str:
        spec = self.motor_map.get(motor_id)
        if spec is None:
            raise ArmRegistryError(f"{self.arm_id}: motor id {motor_id} not registered")
        return spec.urdf_name or f"joint{motor_id}"

    def public_dict(self) -> dict:
        """前端 /api/models 系列接口的公共形状（详见 api.py）。"""
        motors = []
        for m in self.motors:
            motors.append({
                "id": m.id,
                "name": m.name,
                "label": m.label,
                "axis": m.axis,
                "vendor": m.vendor,
                "model": m.model,
                "urdf_name": self.urdf_name_for(m.id),
                "position_limit": list(m.position_limit) if m.position_limit else None,
                "mit_kp": m.mit_kp,
                "mit_kd": m.mit_kd,
            })
        gripper = None
        if self.gripper is not None:
            g = self.gripper
            gripper = {
                "id": g.id,
                "name": g.name,
                "label": g.label,
                "axis": g.axis,
                "vendor": g.vendor,
                "model": g.model,
                "position_limit": list(g.position_limit) if g.position_limit else None,
                "mit_kp": g.mit_kp,
                "mit_kd": g.mit_kd,
                "left_joint": g.left_joint,
                "right_joint": g.right_joint,
            }
        return {
            "arm_id": self.arm_id,
            "name": self.name,
            "vendor": self.vendor,
            "host_id": self.host_id,
            "joint_count": self.joint_count,
            "motor_ids": list(self.motor_ids),
            "gripper_id": self.gripper.id if self.gripper else None,
            "model_scale": self.model_scale,
            "model_rotation_x": self.model_rotation_x,
            "model_position": list(self.model_position),
            "motors": motors,
            "gripper": gripper,
        }


# ---------------------------------------------------------------------------
# 加载
# ---------------------------------------------------------------------------

def default_config_root() -> Path:
    """默认机型配置根（本机开发 = ``<repo>/packages/arm-models/robots``）。

    env ``REBOT_ARM_CONFIG_DIR`` 显式覆盖。部署时由 config.py 传入 ``web_dist_dir/robots``。
    """
    env_root = os.environ.get(_ARM_CONFIG_DIR_ENV)
    if env_root:
        return Path(env_root)
    # src/rebot_server/arm_registry.py → parents[0]=rebot_server ... [4]=<repo>
    return Path(__file__).resolve().parents[4] / "packages" / "arm-models" / "robots"


def config_root_for(web_dist_dir: str = "") -> Path:
    """机型配置根：部署路径（web_dist_dir/robots，模型随前端 dist 打包）
    优先，否则回开发路径。config.py / api.py 共用，保证列表与激活是同一个根。
    """
    if web_dist_dir:
        return Path(web_dist_dir) / "robots"
    return default_config_root()


def load_arm_configs(root: Optional[Union[str, Path]] = None) -> tuple[ArmModel, ...]:
    """扫描 *root*（默认见 :func:`default_config_root`）下所有 ``*/model.yaml``。"""
    root = Path(root) if root is not None else default_config_root()
    if not root.is_dir():
        raise ArmRegistryError(f"arm config root not found: {root}")
    arms: list[ArmModel] = []
    for entry in sorted(root.iterdir()):
        model_file = entry / "model.yaml"
        if not entry.is_dir() or not model_file.is_file():
            if entry.is_dir():
                LOGGER.warning("arm-models: skipping %s (no model.yaml)", entry.name)
            continue
        arms.append(_load_arm(entry))
    if not arms:
        raise ArmRegistryError(f"no arm models registered under {root}")
    return tuple(arms)


def load_arm_by_id(arm_id: str, root: Optional[Union[str, Path]] = None) -> ArmModel:
    for arm in load_arm_configs(root):
        if arm.arm_id == arm_id:
            return arm
    raise ArmRegistryError(f"arm model {arm_id!r} is not registered")


def _load_arm(arm_dir: Path) -> ArmModel:
    model_file = arm_dir / "model.yaml"
    try:
        data = yaml.safe_load(model_file.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ArmRegistryError(f"cannot read {model_file}: {exc}") from exc
    except yaml.YAMLError as exc:
        raise ArmRegistryError(f"invalid YAML in {model_file}: {exc}") from exc
    if not isinstance(data, dict) or not data.get("motors"):
        raise ArmRegistryError(f"{model_file}: 'motors' must be a non-empty list")

    arm_id = arm_dir.name
    default_vendor = _str(data.get("vendor"), "robstride").lower()
    host_id = _to_int(data.get("host_id"), DEFAULT_HOST_ID, "host_id")

    motors: list[MotorSpec] = []
    seen_ids: set[int] = set()
    for raw in data["motors"]:
        motor = _parse_motor(raw, default_vendor)
        if motor.id in seen_ids:
            raise ArmRegistryError(f"{arm_id}: duplicate motor id {motor.id}")
        seen_ids.add(motor.id)
        motors.append(motor)
    if not motors:
        raise ArmRegistryError(f"{model_file}: 'motors' is empty")

    gripper = None
    gripper_raw = data.get("gripper")
    if gripper_raw is not None:
        gripper = _parse_gripper(gripper_raw, default_vendor)
        if gripper.id in seen_ids:
            raise ArmRegistryError(f"{arm_id}: duplicate motor id {gripper.id} (gripper)")
        seen_ids.add(gripper.id)

    # 缺省 = 全部 motors 都是转动关节（夹爪在 gripper，不计入）。
    revolute_count_raw = data.get("gravity_revolute_count")
    if revolute_count_raw is None:
        gravity_revolute_count = len(motors)
    else:
        gravity_revolute_count = _to_int(revolute_count_raw, len(motors),
                                         "gravity_revolute_count")
    if not 0 < gravity_revolute_count <= len(motors):
        raise ArmRegistryError(
            f"{arm_id}: gravity_revolute_count ({gravity_revolute_count}) "
            f"must be in (0, {len(motors)}]"
        )

    return ArmModel(
        arm_id=arm_id,
        name=_str(data.get("name"), arm_id),
        vendor=default_vendor,
        host_id=host_id,
        motors=tuple(motors),
        gripper=gripper,
        gravity_revolute_count=gravity_revolute_count,
        root_link=_str(data.get("root_link"), DEFAULT_ROOT_LINK),
        model_scale=_float(data.get("model_scale"), DEFAULT_MODEL_SCALE, "model_scale"),
        model_rotation_x=_float(data.get("model_rotation_x"), DEFAULT_MODEL_ROTATION_X,
                                "model_rotation_x"),
        model_position=_tuple3(data.get("model_position"), DEFAULT_MODEL_POSITION),
    )


def _parse_motor(raw: object, default_vendor: str) -> MotorSpec:
    if not isinstance(raw, dict):
        raise ArmRegistryError("each motor entry must be a mapping")
    motor_id = _to_int(raw.get("id"), None, "motor id")
    if motor_id is None:
        raise ArmRegistryError("motor entry missing 'id'")
    vendor = _str(raw.get("vendor"), default_vendor).lower()
    _check_vendor(vendor, f"motor {motor_id}")
    model = _nonempty(raw.get("model"), f"motor {motor_id} 'model'")
    mit_raw = raw.get("mit") or {}
    return MotorSpec(
        id=motor_id,
        vendor=vendor,
        model=model,
        name=_str(raw.get("name"), f"J{motor_id}"),
        label=_str(raw.get("label"), _str(raw.get("name"), "")),
        axis=_str(raw.get("axis"), "rotational"),
        position_limit=_tuple2(raw.get("position_limit"), f"motor {motor_id}"),
        mit_kp=_float(mit_raw.get("kp"), None, f"motor {motor_id} mit.kp"),
        mit_kd=_float(mit_raw.get("kd"), None, f"motor {motor_id} mit.kd"),
        feedback_id=_to_int(raw.get("feedback_id"), None, f"motor {motor_id} feedback_id"),
        urdf_name=raw.get("urdf_name"),
    )


def _parse_gripper(raw: object, default_vendor: str) -> GripperSpec:
    if not isinstance(raw, dict):
        raise ArmRegistryError("gripper entry must be a mapping")
    gid = _to_int(raw.get("id"), None, "gripper id")
    if gid is None:
        raise ArmRegistryError("gripper entry missing 'id'")
    vendor = _str(raw.get("vendor"), default_vendor).lower()
    _check_vendor(vendor, "gripper")
    mit_raw = raw.get("mit") or {}
    return GripperSpec(
        id=gid,
        vendor=vendor,
        model=_nonempty(raw.get("model"), "gripper 'model'"),
        name=_str(raw.get("name"), "Gripper"),
        label=_str(raw.get("label"), "夹爪"),
        axis=_str(raw.get("axis"), "grip"),
        position_limit=_tuple2(raw.get("position_limit"), "gripper"),
        mit_kp=_float(mit_raw.get("kp"), None, "gripper mit.kp"),
        mit_kd=_float(mit_raw.get("kd"), None, "gripper mit.kd"),
        left_joint=_str(raw.get("left_joint"), "joint_left"),
        right_joint=_str(raw.get("right_joint"), "joint_right"),
    )


# ---------------------------------------------------------------------------
# 解析小工具（容忍加载：未知 key 忽略；缺省回默认值；错误类型 fail closed）
# ---------------------------------------------------------------------------

def _check_vendor(vendor: str, where: str) -> None:
    if vendor not in SUPPORTED_VENDORS:
        raise ArmRegistryError(
            f"{where}: unsupported vendor {vendor!r} (supported: {', '.join(SUPPORTED_VENDORS)})"
        )

def _str(raw: object, default: str) -> str:
    return str(raw) if raw is not None else default

def _nonempty(raw: object, what: str) -> str:
    value = _str(raw, "")
    if not value.strip():
        raise ArmRegistryError(f"{what} must be a non-empty string")
    return value

def _float(raw: object, default: Optional[float], what: str) -> Optional[float]:
    if raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ArmRegistryError(f"{what} must be a number, got {raw!r}") from None
    return value

def _to_int(raw: object, default: Optional[int], what: str) -> Optional[int]:
    if raw is None:
        return default
    if isinstance(raw, bool):
        raise ArmRegistryError(f"{what} must be an integer, got {raw!r}")
    if isinstance(raw, int):
        return raw
    if isinstance(raw, str):
        try:
            return int(raw, 0)  # 兼容 0xFD / 0x01 hex
        except ValueError:
            pass
    raise ArmRegistryError(f"{what} must be an integer, got {raw!r}")

def _tuple2(raw: object, what: str) -> Optional[tuple[float, float]]:
    if raw is None:
        return None
    if not isinstance(raw, (list, tuple)) or len(raw) != 2:
        raise ArmRegistryError(f"{what} 'position_limit' must be [lo, hi]")
    lo = _float(raw[0], None, f"{what} limit.lo")
    hi = _float(raw[1], None, f"{what} limit.hi")
    if lo is None or hi is None or lo > hi:
        raise ArmRegistryError(f"{what}: invalid position_limit [{lo}, {hi}]")
    return (lo, hi)

def _tuple3(raw: object, default: tuple[float, float, float]) -> tuple[float, float, float]:
    if raw is None:
        return default
    if not isinstance(raw, (list, tuple)) or len(raw) != 3:
        raise ArmRegistryError("model_position must be [x, y, z]")
    parts = [_float(v, None, "model_position") for v in raw]
    if any(v is None for v in parts):
        raise ArmRegistryError("model_position values must be numbers")
    return (parts[0], parts[1], parts[2])  # type: ignore[misc]