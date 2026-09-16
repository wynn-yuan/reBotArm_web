from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import rebot_server
from rebot_server.ota import _current_release_id, _same_build


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


if __name__ == "__main__":
    unittest.main()