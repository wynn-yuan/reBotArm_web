"""Tests for optional same-origin static hosting (``staticweb.py``).

Covers:
* default OFF (no REBOT_WEB_DIST_DIR => no static routes),
* serving index / assets / SPA fallback when enabled,
* fail-closed validation (missing dir, file-not-dir, no index.html),
* path-traversal containment (``..`` and symlink escape => 404),
* hidden files never served,
* /api and /ws keep priority; unknown /api/* is a plain 404 (not the SPA).

No hardware, no network: a temporary directory stands in for the Vite dist.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path

try:
    import httpx  # noqa: F401  (required by TestClient)
    from fastapi.testclient import TestClient

    from rebot_server.app import create_app

    _DEPS_AVAILABLE = True
except Exception:  # ImportError or broken install
    _DEPS_AVAILABLE = False

from rebot_server.config import ConfigError, Settings
from rebot_server.staticweb import validate_web_root


def _make_dist(root: Path) -> Path:
    """A minimal Vite-like dist tree."""
    dist = root / "dist"
    assets = dist / "assets"
    assets.mkdir(parents=True)
    (dist / "index.html").write_text(
        "<!doctype html><html><body>SPA-INDEX</body></html>", encoding="utf-8"
    )
    (assets / "app-abc123.js").write_text("console.log('js');", encoding="utf-8")
    (assets / "app-def456.css").write_text("body{}", encoding="utf-8")
    (assets / ".hidden-secret").write_text("hidden", encoding="utf-8")
    nested = dist / "nested"
    nested.mkdir()
    (nested / "index.html").write_text(
        "<!doctype html><html><body>NESTED-INDEX</body></html>", encoding="utf-8"
    )
    return dist


@unittest.skipUnless(_DEPS_AVAILABLE, "fastapi/httpx not installed")
class StaticHostingTests(unittest.TestCase):
    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix="rebot-static-"))
        self.dist = _make_dist(self._tmp)
        # A secret file OUTSIDE the dist to prove containment.
        self.secret = self._tmp / "secret.txt"
        self.secret.write_text("TOP-SECRET", encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _client(self, web_dist_dir=""):
        return TestClient(
            create_app(settings=Settings(web_dist_dir=web_dist_dir))
        )

    # ---- default OFF ------------------------------------------------------

    def test_static_hosting_disabled_by_default(self):
        client = self._client()
        self.assertEqual(client.get("/").status_code, 404)
        self.assertEqual(client.get("/index.html").status_code, 404)
        # API still works.
        self.assertEqual(client.get("/api/health").status_code, 200)

    # ---- fail-closed validation --------------------------------------------

    def test_missing_directory_fails_closed(self):
        with self.assertRaises(ConfigError):
            create_app(
                settings=Settings(web_dist_dir=str(self._tmp / "nope"))
            )

    def test_file_instead_of_directory_fails_closed(self):
        with self.assertRaises(ConfigError):
            create_app(settings=Settings(web_dist_dir=str(self.secret)))

    def test_directory_without_index_html_fails_closed(self):
        empty = self._tmp / "empty"
        empty.mkdir()
        with self.assertRaises(ConfigError):
            create_app(settings=Settings(web_dist_dir=str(empty)))

    def test_empty_value_fails_closed(self):
        with self.assertRaises(ConfigError):
            validate_web_root("   ")

    # ---- serving -------------------------------------------------------------

    def test_root_serves_index(self):
        client = self._client(str(self.dist))
        response = client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("SPA-INDEX", response.text)
        self.assertTrue(response.headers["content-type"].startswith("text/html"))

    def test_asset_served_with_content(self):
        client = self._client(str(self.dist))
        response = client.get("/assets/app-abc123.js")
        self.assertEqual(response.status_code, 200)
        self.assertIn("console.log", response.text)
        self.assertIn("javascript", response.headers["content-type"])

    def test_nested_directory_serves_its_index(self):
        client = self._client(str(self.dist))
        response = client.get("/nested/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("NESTED-INDEX", response.text)

    def test_unknown_route_falls_back_to_spa_index(self):
        client = self._client(str(self.dist))
        for path in ("/monitor", "/motion/center", "/assets/missing.js"):
            with self.subTest(path=path):
                response = client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertIn("SPA-INDEX", response.text)

    def test_api_and_ws_keep_priority_when_static_enabled(self):
        client = self._client(str(self.dist))
        # Health still served by the API (not masked by index.html).
        body = client.get("/api/health").json()
        self.assertEqual(body["status"], "ok")
        # Unknown API path: plain 404, never the SPA.
        response = client.get("/api/definitely-not-real")
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("SPA-INDEX", response.text)
        # Unknown /ws path: 404 (HTTP against the ws namespace).
        response = client.get("/ws/definitely-not-real")
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("SPA-INDEX", response.text)
        # /docs and /openapi.json still belong to FastAPI.
        self.assertEqual(client.get("/docs").status_code, 200)
        self.assertEqual(client.get("/openapi.json").status_code, 200)

    # ---- containment -----------------------------------------------------------

    def test_hidden_files_never_served(self):
        client = self._client(str(self.dist))
        # Dotfile requests fail closed with 404 — never the file, never the
        # SPA (404 is the stricter, chosen behavior).
        response = client.get("/assets/.hidden-secret")
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("hidden", response.text)
        response = client.get("/.env")
        self.assertEqual(response.status_code, 404)

    def test_dotdot_segments_cannot_escape_root(self):
        client = self._client(str(self.dist))
        # Direct handler-level exercise with raw '..' segments (HTTP clients
        # may normalize dot-segments before sending).
        for path in (
            "../secret.txt",
            "assets/../../secret.txt",
            "..%2f..%2fsecret.txt",
        ):
            with self.subTest(path=path):
                response = client.get("/" + path)
                self.assertNotIn("TOP-SECRET", response.text)
        # Unit-level: the static route handler resolves outside => not the
        # secret contents.
        from rebot_server.staticweb import create_static_web_router

        router = create_static_web_router(self.dist)
        handler = router.routes[0].endpoint
        response = handler("../secret.txt")
        text = getattr(response, "body", b"")
        self.assertNotIn(b"TOP-SECRET", text)

    def test_symlink_escape_is_refused(self):
        if os.name == "nt" and not self._can_symlink():
            self.skipTest("symlink creation not permitted on this host")
        link = self.dist / "assets" / "escape"
        os.symlink(self.secret, str(link))
        client = self._client(str(self.dist))
        response = client.get("/assets/escape")
        self.assertNotIn("TOP-SECRET", response.text)

    def _can_symlink(self) -> bool:
        try:
            probe = self._tmp / "probe-link"
            os.symlink(self.secret, str(probe))
            probe.unlink()
            return True
        except OSError:
            return False

    # ---- telemetry still works alongside static hosting ------------------------

    def test_telemetry_websocket_unaffected_by_static_hosting(self):
        client = self._client(str(self.dist))
        with client.websocket_connect("/ws/robot/telemetry") as ws:
            frame = ws.receive_json()
            self.assertEqual(frame["source"], "simulation")
            self.assertEqual(len(frame["joints"]), 7)


class ValidateWebRootUnitTests(unittest.TestCase):
    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix="rebot-static-unit-"))

    def tearDown(self):
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_valid_root_returns_resolved_path(self):
        dist = _make_dist(self._tmp)
        root = validate_web_root(str(dist))
        self.assertTrue(root.is_dir())
        self.assertEqual(root, dist.resolve())

    def test_missing_raises(self):
        with self.assertRaises(ConfigError):
            validate_web_root(str(self._tmp / "missing"))

    def test_file_raises(self):
        f = self._tmp / "afile"
        f.write_text("x", encoding="utf-8")
        with self.assertRaises(ConfigError):
            validate_web_root(str(f))

    def test_no_index_raises(self):
        d = self._tmp / "noidx"
        d.mkdir()
        with self.assertRaises(ConfigError):
            validate_web_root(str(d))


if __name__ == "__main__":
    unittest.main()
