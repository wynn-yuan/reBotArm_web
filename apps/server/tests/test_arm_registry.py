"""arm_registry 机型注册表测试。

真机 B601 数值必须与历史硬编码常量逐位一致（老化/重力输出不回归）。
"""
from pathlib import Path

import pytest
import yaml

from rebot_server import arm_registry
from rebot_server.arm_registry import ArmRegistryError, default_config_root

#: 历史常量（B601，来自 aging_runtime / config.py / scanners.motorbridge.py）
HIST_LIMITS = (
    (-2.8, 2.8), (0.0, 3.14), (0.0, 3.14), (-1.57, 1.57), (-1.57, 1.57), (-3.14, 3.14),
)
HIST_KP = (50.0, 150.0, 150.0, 50.0, 50.0, 50.0)
HIST_KD = (3.0, 10.0, 10.0, 5.0, 4.0, 4.0)


@pytest.fixture(scope="module")
def b601() -> arm_registry.ArmModel:
    root = Path(__file__).resolve().parents[3] / "packages" / "arm-models" / "robots"
    return arm_registry.load_arm_by_id("rebot-b601-rs", root=root)


def _write_arm(root: Path, arm_id: str, data: dict) -> Path:
    arm_dir = root / arm_id
    arm_dir.mkdir(parents=True)
    (arm_dir / "model.yaml").write_text(yaml.safe_dump(data), encoding="utf-8")
    return arm_dir


def _minimal(root: Path, arm_id: str = "a1") -> dict:
    return {
        "name": f"test {arm_id}",
        "host_id": 0xFD,
        "motors": [
            {"id": 1, "model": "rs-06"},
            {"id": 2, "model": "rs-06"},
        ],
    }


class TestB601:
    def test_ids_and_gripper(self, b601):
        assert b601.motor_ids == (1, 2, 3, 4, 5, 6)
        assert b601.joint_count == 6
        assert b601.gripper is not None and b601.gripper.id == 7
        assert b601.gripper.model == "rs-00"
        assert b601.gripper.left_joint == "joint_left"
        assert b601.gripper.right_joint == "joint_right"

    def test_host_and_vendor(self, b601):
        assert b601.host_id == 0xFD
        assert b601.vendor == "robstride"
        assert all(m.vendor == "robstride" for m in b601.motors)

    def test_limits_kp_kd_match_history(self, b601):
        assert b601.joint_limits == HIST_LIMITS
        assert b601.mit_kp == HIST_KP
        assert b601.mit_kd == HIST_KD

    def test_gravity_count_and_urdf_names(self, b601):
        assert b601.gravity_revolute_count == 6
        assert b601.root_link == "link1"
        assert b601.urdf_name_for(1) == "joint1"
        assert b601.urdf_name_for(6) == "joint6"

    def test_3d_defaults(self, b601):
        assert b601.model_scale == 2.5
        assert b601.model_position == (0.0, -1.2, 0.0)

    def test_urdf_sits_next_to_model_yaml(self):
        """发布冒烟：B601 文件夹必须含 model.urdf（后端重力/前端 3D 依赖）。"""
        root = default_config_root()
        assert (root / "rebot-b601-rs" / "model.urdf").is_file()

    def test_public_dict_shape(self, b601):
        d = b601.public_dict()
        assert d["arm_id"] == "rebot-b601-rs"
        assert d["motor_ids"] == [1, 2, 3, 4, 5, 6]
        assert d["gripper_id"] == 7
        assert len(d["motors"]) == 6
        assert d["motors"][0] == {
            "id": 1, "name": "J1", "label": "基座旋转", "axis": "yaw",
            "vendor": "robstride", "model": "rs-06", "urdf_name": "joint1",
            "position_limit": [-2.8, 2.8], "mit_kp": 50.0, "mit_kd": 3.0,
        }
        assert d["gripper"]["left_joint"] == "joint_left"


class TestLoader:
    def test_unknown_keys_ignored_and_defaults(self, tmp_path):
        root = tmp_path / "cfg"
        _write_arm(root, "a1", {
            **_minimal(root),
            "future_key": {"whatever": 1},
        })
        arm = arm_registry.load_arm_by_id("a1", root=root)
        assert arm.name == "test a1"
        assert arm.gravity_revolute_count == 2  # 缺省 = len(motors)
        assert arm.host_id == 0xFD
        assert arm.motors[0].name == "J1"          # 默认名
        assert arm.motors[0].feedback_id is None   # 默认 None → scanner 用 host_id

    def test_fail_closed_duplicate_id(self, tmp_path):
        root = tmp_path / "cfg"
        data = _minimal(root)
        data["motors"] = [{"id": 1, "model": "rs-06"}, {"id": 1, "model": "rs-00"}]
        _write_arm(root, "a1", data)
        with pytest.raises(ArmRegistryError, match="duplicate motor id 1"):
            arm_registry.load_arm_by_id("a1", root=root)

    def test_fail_closed_empty_motors(self, tmp_path):
        root = tmp_path / "cfg"
        _write_arm(root, "a1", {"motors": []})
        with pytest.raises(ArmRegistryError):
            arm_registry.load_arm_by_id("a1", root=root)

    def test_fail_closed_missing_model(self, tmp_path):
        root = tmp_path / "cfg"
        data = _minimal(root)
        data["motors"] = [{"id": 1, "model": "rs-06"}, {"id": 2}]
        _write_arm(root, "a1", data)
        with pytest.raises(ArmRegistryError, match="non-empty"):
            arm_registry.load_arm_by_id("a1", root=root)

    def test_fail_closed_invalid_vendor(self, tmp_path):
        root = tmp_path / "cfg"
        data = _minimal(root)
        data["motors"][0]["vendor"] = "nope"
        _write_arm(root, "a1", data)
        with pytest.raises(ArmRegistryError, match="unsupported vendor"):
            arm_registry.load_arm_by_id("a1", root=root)

    def test_fail_closed_revolute_count_out_of_range(self, tmp_path):
        root = tmp_path / "cfg"
        data = _minimal(root)
        data["gravity_revolute_count"] = 5
        _write_arm(root, "a1", data)
        with pytest.raises(ArmRegistryError, match="gravity_revolute_count"):
            arm_registry.load_arm_by_id("a1", root=root)

    def test_skips_dir_without_model_yaml(self, tmp_path):
        root = tmp_path / "cfg"
        arm_dir = _write_arm(root, "a1", _minimal(root))
        (arm_dir.parent / "_notes").mkdir()
        arms = arm_registry.load_arm_configs(root)
        assert [a.arm_id for a in arms] == ["a1"]

    def test_no_arms_raises(self, tmp_path):
        root = tmp_path / "cfg"
        root.mkdir()
        with pytest.raises(ArmRegistryError, match="no arm models"):
            arm_registry.load_arm_configs(root)

    def test_missing_root_raises(self, tmp_path):
        with pytest.raises(ArmRegistryError, match="arm config root not found"):
            arm_registry.load_arm_configs(tmp_path / "does-not-exist")

class TestDmDevarm:
    """reBot DevArm DM：多厂商机型（damiao）+ 每关节独立 feedback_id + 无夹爪。"""

    @pytest.fixture(scope="class")
    def dm(self):
        root = Path(__file__).resolve().parents[3] / "packages" / "arm-models" / "robots"
        return arm_registry.load_arm_by_id("rebot-devarm-dm", root=root)

    def test_vendor_and_feedback_ids(self, dm):
        assert dm.vendor == "damiao" and dm.host_id == 0
        assert [m.feedback_id for m in dm.motors] == [0x11, 0x12, 0x13, 0x14, 0x15, 0x16]

    def test_limits_and_gains_from_urdf_yaml(self, dm):
        assert dm.joint_limits == (
            (-2.8, 2.8), (-3.14, 0.0), (-3.14, 0.0),
            (-1.87, 1.57), (-1.57, 1.57), (-3.14, 3.14),
        )
        assert [m.mit_kp for m in dm.motors] == [120.0, 120.0, 120.0, 18.0, 18.0, 18.0]

    def test_no_gripper(self, dm):
        assert dm.gripper is None
        assert dm.joint_count == 6 and dm.motor_ids == (1, 2, 3, 4, 5, 6)
