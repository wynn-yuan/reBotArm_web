"""Settings and channel-validation tests (stdlib only)."""

from __future__ import annotations

import unittest

from rebot_server.config import (
    ADAPTER_MOTORBRIDGE,
    ADAPTER_SIMULATION,
    DEFAULT_EXPECTED_MOTOR_IDS,
    ConfigError,
    load_settings,
    validate_channel,
)


class ChannelValidationTests(unittest.TestCase):
    def test_valid_channels_accepted(self):
        for value in ("can0", "can1", "can12"):
            self.assertEqual(validate_channel(value), value)

    def test_invalid_channels_rejected(self):
        invalid = (
            "",
            "CAN0",
            "vcan0",       # virtual CAN is intentionally excluded by spec
            "slcan0",
            "can",
            "can0 ",
            " can0",
            "can-0",
            "can0\n",
            "can0;rm -rf /",
            "can0 && echo pwned",
            "can0/../../etc/passwd",
            None,
            1,
        )
        for value in invalid:
            with self.assertRaises(ConfigError, msg=f"{value!r} should be rejected"):
                validate_channel(value)


class LoadSettingsTests(unittest.TestCase):
    def test_defaults_are_safe(self):
        settings = load_settings(env={})
        self.assertEqual(settings.adapter, ADAPTER_SIMULATION)
        self.assertEqual(settings.channel, "can0")
        self.assertEqual(settings.expected_ids, (1, 2, 3, 4, 5, 6, 7))
        self.assertEqual(settings.host_id, 0xFD)
        self.assertEqual(settings.ping_timeout_ms, 500)
        self.assertEqual(settings.telemetry_hz, 10.0)
        # The single authorized motor write is OFF by default (fail closed).
        self.assertFalse(settings.allow_active_report_write)
        self.assertFalse(settings.allow_aging_write)
        self.assertEqual(settings.sim_found_ids, DEFAULT_EXPECTED_MOTOR_IDS)
        self.assertFalse(settings.sim_fatal_error)
        self.assertEqual(settings.cors_origins, ())
        self.assertEqual(settings.host, "127.0.0.1")
        self.assertEqual(settings.port, 8000)

    def test_motorbridge_adapter_selected(self):
        settings = load_settings(env={"REBOT_ADAPTER": "motorbridge"})
        self.assertEqual(settings.adapter, ADAPTER_MOTORBRIDGE)

    def test_unknown_adapter_fails_closed(self):
        with self.assertRaises(ConfigError):
            load_settings(env={"REBOT_ADAPTER": "hardware"})

    def test_invalid_channel_fails_closed(self):
        with self.assertRaises(ConfigError):
            load_settings(env={"REBOT_CAN_CHANNEL": "can0;reboot"})

    def test_host_id_accepts_hex_literal(self):
        settings = load_settings(env={"REBOT_HOST_ID": "0xFD"})
        self.assertEqual(settings.host_id, 253)

    def test_host_id_out_of_range_rejected(self):
        with self.assertRaises(ConfigError):
            load_settings(env={"REBOT_HOST_ID": "256"})

    def test_ping_timeout_parsed_and_clamped_to_safe_bounds(self):
        # Default matches the SDK/vendor default.
        self.assertEqual(load_settings(env={}).ping_timeout_ms, 500)
        # Explicit values are passed through...
        self.assertEqual(
            load_settings(env={"REBOT_PING_TIMEOUT_MS": "750"}).ping_timeout_ms, 750
        )
        # ...but clamped so a full 7-ID scan stays bounded (<= ~14 s) and a
        # too-small timeout cannot starve a real bus reply.
        self.assertEqual(
            load_settings(env={"REBOT_PING_TIMEOUT_MS": "1"}).ping_timeout_ms, 10
        )
        self.assertEqual(
            load_settings(env={"REBOT_PING_TIMEOUT_MS": "999999"}).ping_timeout_ms,
            2000,
        )

    def test_ping_timeout_non_integer_fails_closed(self):
        with self.assertRaises(ConfigError):
            load_settings(env={"REBOT_PING_TIMEOUT_MS": "fast"})

    def test_telemetry_hz_parsed_and_clamped(self):
        # Default stream rate.
        self.assertEqual(load_settings(env={}).telemetry_hz, 10.0)
        # Explicit values pass through...
        self.assertEqual(
            load_settings(env={"REBOT_TELEMETRY_HZ": "25"}).telemetry_hz, 25.0
        )
        # ...but are clamped so the WebSocket stream rate stays bounded.
        self.assertEqual(
            load_settings(env={"REBOT_TELEMETRY_HZ": "0.1"}).telemetry_hz, 1.0
        )
        self.assertEqual(
            load_settings(env={"REBOT_TELEMETRY_HZ": "500"}).telemetry_hz, 50.0
        )

    def test_telemetry_hz_invalid_fails_closed(self):
        for raw in ("fast", "nan", "inf"):
            with self.assertRaises(ConfigError, msg=raw):
                load_settings(env={"REBOT_TELEMETRY_HZ": raw})

    def test_allow_active_report_write_requires_explicit_opt_in(self):
        # The only authorized motor write defaults to OFF and accepts only
        # explicit truthy values; anything else stays off (fail closed).
        for raw in ("1", "true", "yes", "on", "TRUE"):
            settings = load_settings(
                env={"REBOT_ALLOW_ACTIVE_REPORT_WRITE": raw}
            )
            self.assertTrue(settings.allow_active_report_write, raw)
        for raw in ("0", "false", "no", "off", "2", "maybe", ""):
            settings = load_settings(
                env={"REBOT_ALLOW_ACTIVE_REPORT_WRITE": raw}
            )
            self.assertFalse(settings.allow_active_report_write, raw)

    def test_allow_aging_write_requires_explicit_opt_in(self):
        for raw in ("1", "true", "yes", "on"):
            self.assertTrue(
                load_settings(env={"REBOT_ALLOW_AGING_WRITE": raw}).allow_aging_write
            )
        for raw in ("0", "false", "no", "off", "maybe", ""):
            self.assertFalse(
                load_settings(env={"REBOT_ALLOW_AGING_WRITE": raw}).allow_aging_write
            )

    def test_mit_gains_default_to_reference_values(self):
        settings = load_settings(env={})
        self.assertEqual(settings.mit_kp, (50.0, 150.0, 150.0, 50.0, 50.0, 50.0, 50.0))
        self.assertEqual(settings.mit_kd, (3.0, 10.0, 10.0, 5.0, 4.0, 4.0, 4.0))

    def test_mit_gains_parsed_from_env(self):
        settings = load_settings(
            env={
                "REBOT_MIT_KP": "10,20,30,40,50,60,70",
                "REBOT_MIT_KD": "1,2,3,4,5,6,7",
            }
        )
        self.assertEqual(settings.mit_kp, (10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0))
        self.assertEqual(settings.mit_kd, (1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0))

    def test_mit_gains_invalid_rejected(self):
        for env in (
            {"REBOT_MIT_KP": "1,2,3,4,5,6"},          # only six values
            {"REBOT_MIT_KP": "1,2,3,4,5,6,7,8"},      # eight values
            {"REBOT_MIT_KP": "1,2,x,4,5,6,7"},        # non-numeric
            {"REBOT_MIT_KP": "1,2,0,4,5,6,7"},        # zero (not positive)
            {"REBOT_MIT_KP": "1,2,-3,4,5,6,7"},       # negative
            {"REBOT_MIT_KP": "1,2,3,4,5,6,"},         # empty element
        ):
            with self.assertRaises(ConfigError, msg=env):
                load_settings(env=env)

    def test_sim_found_ids_parsed_sorted_deduped(self):
        settings = load_settings(env={"REBOT_SIM_FOUND_IDS": "3, 1, 2, 3"})
        self.assertEqual(settings.sim_found_ids, (1, 2, 3))

    def test_sim_found_ids_invalid_rejected(self):
        for raw in ("1,x", "0", "-1", "1;echo"):
            with self.assertRaises(ConfigError, msg=raw):
                load_settings(env={"REBOT_SIM_FOUND_IDS": raw})

    def test_cors_origins_parsed(self):
        settings = load_settings(
            env={"REBOT_CORS_ORIGINS": "http://localhost:3000, http://127.0.0.1:5173"}
        )
        self.assertEqual(
            settings.cors_origins,
            ("http://localhost:3000", "http://127.0.0.1:5173"),
        )

    def test_expected_ids_are_fixed_backend_values(self):
        # Env vars or requests cannot change the expected motor IDs.
        settings = load_settings(
            env={"REBOT_EXPECTED_IDS": "1,2", "REBOT_SIM_FOUND_IDS": "1"}
        )
        self.assertEqual(settings.expected_ids, DEFAULT_EXPECTED_MOTOR_IDS)


if __name__ == "__main__":
    unittest.main()
