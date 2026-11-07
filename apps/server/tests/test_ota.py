from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from unittest import mock

import rebot_server
from rebot_server.ota import (
    _current_release_id,
    _download_asset,
    _same_build,
    _write_progress,
)


class SameBuildTests(unittest.TestCase):
    def test_github_tag_matches_deploy_release_id(self):
        # deploy.sh stamps <utc-display>-source; GitHub tags are v<utc-display>.
        self.assertTrue(_same_build("20260908-014510-source", "v20260908-014510"))
        self.assertTrue(_same_build("v20260908-014510", "v20260908-014510"))
        self.assertTrue(_same_build("V20260908-014510Z", "20260908-014510"))
        # A trailing -source on the tag form too (belt and braces).
        self.assertTrue(_same_build("v20260908-014510-source", "20260908-014510"))

    def test_different_builds_are_not_same(self):
        self.assertFalse(_same_build("v20260908-014510", "v20260909-010000"))
        self.assertFalse(_same_build("20260908-014510-source", "v20260909-010000"))

    def test_empty_or_none_is_never_same(self):
        self.assertFalse(_same_build("", "v20260908-014510"))
        self.assertFalse(_same_build("v20260908-014510", ""))


class CurrentReleaseIdTests(unittest.TestCase):
    def test_prefers_current_symlink_under_rebotarm_base(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.symlink("releases/v1.2.3", os.path.join(tmp, "current"))
            with mock.patch.dict(os.environ, {"REBOTARM_BASE": tmp}, clear=False):
                self.assertEqual(_current_release_id(), "v1.2.3")

    def test_falls_back_to_version_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "VERSION"), "w") as f:
                f.write("20260908-014510-source\n")
            with mock.patch.dict(os.environ, {"REBOTARM_BASE": tmp}, clear=False):
                self.assertEqual(_current_release_id(), "20260908-014510-source")

    def test_last_resort_is_package_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"REBOTARM_BASE": tmp}, clear=False):
                self.assertEqual(_current_release_id(), str(rebot_server.__version__))


class ProgressTests(unittest.TestCase):
    def test_write_progress_creates_shared_logs(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write_progress(tmp, "downloading", "正在下载", 0.25)
            path = os.path.join(tmp, "shared", "logs", "ota-progress.json")
            with open(path) as f:
                data = json.load(f)
        self.assertEqual(data, {"step": "downloading", "message": "正在下载", "progress": 0.25})

    def test_download_reports_progress_with_content_length(self):
        class FakeResponse(io.BytesIO):
            headers = {"Content-Length": str(4096)}

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        release = {
            "assets": [
                {"name": "x.tar.gz", "browser_download_url": "https://example/x.tar.gz"}
            ]
        }
        with tempfile.TemporaryDirectory() as tmp, mock.patch(
            "rebot_server.ota.urlopen", return_value=FakeResponse(b"x" * 4096)
        ):
            tarball = _download_asset(release, tmp, tmp)
            with open(os.path.join(tmp, "shared", "logs", "ota-progress.json")) as f:
                data = json.load(f)
        self.assertIsNotNone(tarball)
        self.assertEqual(data["step"], "downloading")
        self.assertAlmostEqual(data["progress"], 0.45, places=2)


if __name__ == "__main__":
    unittest.main()