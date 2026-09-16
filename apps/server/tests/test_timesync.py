from __future__ import annotations

import datetime
import email.message
import time
import unittest
from email.utils import format_datetime
from unittest import mock

import rebot_server.timesync as timesync
from rebot_server.timesync import parse_http_date, sane_offset, sync_device_clock_once


class ParseHttpDateTests(unittest.TestCase):
    def test_valid_rfc_date(self):
        parsed = parse_http_date("Thu, 10 Sep 2026 07:58:16 GMT")
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed.tzinfo, datetime.timezone.utc)
        self.assertEqual(parsed.year, 2026)

    def test_naive_date_is_normalized_to_utc(self):
        parsed = parse_http_date("Thu, 10 Sep 2026 07:58:16")
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed.tzinfo, datetime.timezone.utc)
        self.assertEqual(parsed.hour, 7)

    def test_garbage_is_none(self):
        self.assertIsNone(parse_http_date("not a date"))
        self.assertIsNone(parse_http_date(""))
        self.assertIsNone(parse_http_date(None))
        self.assertIsNone(parse_http_date(12345))


class SaneOffsetTests(unittest.TestCase):
    def test_zero_and_modest_offsets_ok(self):
        self.assertTrue(sane_offset(0.0))
        self.assertTrue(sane_offset(3600.0))
        self.assertTrue(sane_offset(-3600.0))

    def test_multi_month_drift_is_accepted(self):
        # The whole point of the correction: a dead RTC drifts for months.
        self.assertTrue(sane_offset(60 * 24 * 3600))
        self.assertTrue(sane_offset(-60 * 24 * 3600))

    def test_beyond_bound_or_non_finite_is_sane_false(self):
        self.assertFalse(sane_offset(float("nan")))
        self.assertFalse(sane_offset(float("inf")))
        self.assertFalse(sane_offset(timesync.SANE_MAX_ABS_OFFSET_S + 1.0))


class ClockNowTests(unittest.TestCase):
    def setUp(self):
        self._saved = timesync.CLOCK_OFFSET_SECONDS

    def tearDown(self):
        timesync.CLOCK_OFFSET_SECONDS = self._saved

    def test_clock_now_iso_applies_offset(self):
        timesync.CLOCK_OFFSET_SECONDS = 7200.0
        iso = timesync.clock_now_iso()
        parsed = datetime.datetime.fromisoformat(iso)
        self.assertEqual(parsed.tzinfo, datetime.timezone.utc)
        self.assertAlmostEqual(
            (parsed - datetime.datetime.now(datetime.timezone.utc)).total_seconds(),
            7200.0,
            delta=3.0,
        )


class FakeResponse:
    """Minimal urllib response stand-in with context-manager protocol."""

    def __init__(self, headers):
        self.headers = headers

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def close(self):
        pass


class SyncDeviceClockOnceTests(unittest.TestCase):
    def setUp(self):
        self._saved = timesync.CLOCK_OFFSET_SECONDS
        self._logger_warn = mock.patch.object(timesync.logger, "warning")
        self._logger_warn.start()

    def tearDown(self):
        timesync.CLOCK_OFFSET_SECONDS = self._saved
        self._logger_warn.stop()

    @staticmethod
    def _date_header(seconds_ahead: float) -> str:
        stamp = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
            seconds=seconds_ahead
        )
        return format_datetime(stamp)

    def test_offline_returns_false_without_raising(self):
        with mock.patch.object(
            timesync.urllib.request, "urlopen", side_effect=__import__("urllib.error").error.URLError("offline")
        ):
            self.assertFalse(sync_device_clock_once())
        self.assertEqual(timesync.CLOCK_OFFSET_SECONDS, self._saved)

    def test_http_403_with_date_still_syncs(self):
        # GitHub API quota: 403 but a valid Date header — must count as a sync.
        msg = email.message.Message()
        msg["Date"] = self._date_header(30.0)
        exc = timesync.urllib.error.HTTPError(
            "https://api.github.com/", 403, "rate limited", msg, None
        )
        with mock.patch.object(timesync.urllib.request, "urlopen", side_effect=exc):
            self.assertTrue(sync_device_clock_once())
        self.assertAlmostEqual(timesync.CLOCK_OFFSET_SECONDS, 30.0, delta=5.0)

    def test_success_response_sets_offset(self):
        resp = FakeResponse({"Date": self._date_header(-120.0)})
        with mock.patch.object(timesync.urllib.request, "urlopen", return_value=resp):
            self.assertTrue(sync_device_clock_once())
        self.assertAlmostEqual(timesync.CLOCK_OFFSET_SECONDS, -120.0, delta=5.0)


if __name__ == "__main__":
    unittest.main()