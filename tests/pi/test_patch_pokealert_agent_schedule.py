import json
import tempfile
import unittest
from pathlib import Path

from scripts.maintenance.patch_pokealert_agent_schedule import patch_source


FIXTURE = '''import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEDULE_FILE = Path("target-schedule.json")
MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, MAX_WINDOWS = 5, 3600, 12

def now():
    return datetime.now(timezone.utc).isoformat()

def _valid_hhmm(value):
    return True

def set_target_schedule(payload):
    return False, "old"
'''


class ScheduleAgentPatcherTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "target-schedule.json"
        namespace = {"__name__": "fixture"}
        self.patched = patch_source(FIXTURE)
        exec(compile(self.patched, "pi_agent.py", "exec"), namespace)
        namespace["SCHEDULE_FILE"] = self.path
        self.set_schedule = namespace["set_target_schedule"]

    def tearDown(self):
        self.directory.cleanup()

    def valid_payload(self):
        return {
            "default_interval": 300,
            "windows": [{"start": "22:00", "end": "04:00", "interval": 15}],
            "release_overrides": [
                {"date": "2099-08-14", "start": "22:00", "end": "06:00", "interval": 15}
            ],
        }

    def test_patch_is_idempotent_and_accepts_a_release_override(self):
        self.assertEqual(self.patched, patch_source(self.patched))
        ok, message = self.set_schedule(self.valid_payload())
        self.assertTrue(ok, message)
        stored = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(stored["release_overrides"][0]["date"], "2099-08-14")
        self.assertIn("1 release override", message)

    def test_invalid_payloads_leave_the_existing_file_unchanged(self):
        self.path.write_text('{"sentinel":true}', encoding="utf-8")
        invalid_payloads = [
            {**self.valid_payload(), "release_overrides": [
                {"date": "2099-08-14", "start": "22:00", "end": "06:00", "interval": 15},
                {"date": "2099-08-14", "start": "22:00", "end": "06:00", "interval": 15},
            ]},
            {**self.valid_payload(), "release_overrides": [
                {"date": "not-a-date", "start": "22:00", "end": "06:00", "interval": 15}
            ]},
            {**self.valid_payload(), "release_overrides": [
                {"date": "2099-08-14", "start": "22:00", "end": "06:00", "interval": 14}
            ]},
            {**self.valid_payload(), "release_overrides": [
                {"date": "2099-08-14", "start": "22:00", "end": "06:00", "interval": 3601}
            ]},
            {**self.valid_payload(), "release_overrides": [
                {"date": f"2099-09-{(index % 28) + 1:02d}", "start": "22:00", "end": "06:00", "interval": 15}
                for index in range(33)
            ]},
        ]
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                ok, _ = self.set_schedule(payload)
                self.assertFalse(ok)
                self.assertEqual(self.path.read_text(encoding="utf-8"), '{"sentinel":true}')

    def test_expired_overrides_are_dropped_when_writing(self):
        payload = self.valid_payload()
        payload["release_overrides"].insert(0, {
            "date": "2020-01-01", "start": "22:00", "end": "06:00", "interval": 15
        })
        ok, message = self.set_schedule(payload)
        self.assertTrue(ok, message)
        stored = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual([item["date"] for item in stored["release_overrides"]], ["2099-08-14"])


if __name__ == "__main__":
    unittest.main()
