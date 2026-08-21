import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from scripts.pi.target_reliability import (
    AtomicAlertState,
    CorruptAlertStateError,
    batch_signatures,
    parse_schedule_config,
    schedule_decision,
)


try:
    PACIFIC = ZoneInfo("America/Los_Angeles")
except Exception:
    PACIFIC = timezone(timedelta(hours=-7), name="America/Los_Angeles")


class AtomicAlertStateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "state.json"

    def tearDown(self):
        self.directory.cleanup()

    def test_transition_is_persisted_before_delivery_and_reused_after_restart(self):
        first = AtomicAlertState(self.path)
        event = first.ensure_transition("95163306", {"name": "Prismatic"})

        second = AtomicAlertState(self.path)
        self.assertEqual(second.pending()[0].source_event_id, event.source_event_id)
        self.assertNotIn("95163306", second.in_stock)

    def test_confirmed_cloud_delivery_moves_tcin_to_in_stock(self):
        state = AtomicAlertState(self.path)
        event = state.ensure_transition("95163306", {})

        state.mark_destination(event.source_event_id, "cloud", status=200)

        self.assertIn("95163306", state.in_stock)

    def test_event_remains_until_every_configured_destination_confirms(self):
        state = AtomicAlertState(self.path, destinations=("cloud", "discord"))
        event = state.ensure_transition("95163306", {})
        state.mark_destination(event.source_event_id, "cloud", status=201)
        self.assertEqual(len(state.pending()), 1)

        state.mark_destination(
            event.source_event_id,
            "discord",
            status=200,
            message_id="123456789",
        )
        self.assertEqual(state.pending(), [])

    def test_legacy_in_stock_state_is_loaded(self):
        self.path.write_text(json.dumps({"in_stock": ["95163306"]}), encoding="utf-8")
        state = AtomicAlertState(self.path)
        self.assertIn("95163306", state.in_stock)
        self.assertEqual(state.pending(), [])

    def test_retry_metadata_is_durable_and_error_is_bounded(self):
        state = AtomicAlertState(self.path, destinations=("cloud", "discord"))
        event = state.ensure_transition("95163306", {})
        state.mark_attempt(event.source_event_id, "discord", error="x" * 900)

        restarted = AtomicAlertState(self.path, destinations=("cloud", "discord"))
        destination = restarted.pending()[0].destinations["discord"]
        self.assertEqual(destination["attempts"], 1)
        self.assertEqual(len(destination["last_error"]), 500)

    def test_corrupt_state_fails_closed_without_overwriting_the_file(self):
        original = "{not-json"
        self.path.write_text(original, encoding="utf-8")
        with self.assertRaises(CorruptAlertStateError):
            AtomicAlertState(self.path)
        self.assertEqual(self.path.read_text(encoding="utf-8"), original)


class ScheduleTests(unittest.TestCase):
    def config(self, now):
        return parse_schedule_config(
            {
                "default_interval": 300,
                "windows": [{"start": "22:00", "end": "04:00", "interval": 15}],
                "release_overrides": [
                    {"date": "2026-08-14", "start": "22:00", "end": "06:00", "interval": 15}
                ],
            },
            now,
            PACIFIC,
        )

    def test_ordinary_date_uses_recurring_window_only(self):
        now = datetime(2026, 8, 13, 23, 0, tzinfo=PACIFIC)
        decision = schedule_decision(self.config(now), now, PACIFIC)
        self.assertEqual(decision.interval, 15)
        self.assertEqual(decision.profile, "window:22:00-04:00")

    def test_release_override_extends_through_the_next_morning(self):
        now = datetime(2026, 8, 15, 5, 30, tzinfo=PACIFIC)
        decision = schedule_decision(self.config(now), now, PACIFIC)
        self.assertEqual(decision.interval, 15)
        self.assertEqual(decision.profile, "release:2026-08-14")

    def test_expired_override_does_not_change_an_ordinary_date(self):
        now = datetime(2026, 8, 20, 12, 0, tzinfo=PACIFIC)
        decision = schedule_decision(self.config(now), now, PACIFIC)
        self.assertEqual(decision.interval, 300)
        self.assertEqual(decision.profile, "default")

    def test_interval_below_fifteen_seconds_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "at least 15"):
            parse_schedule_config(
                {"default_interval": 300, "windows": [{"start": "22:00", "end": "04:00", "interval": 10}]},
                datetime(2026, 8, 11, tzinfo=PACIFIC),
                PACIFIC,
            )

    def test_midnight_spanning_window_applies_after_midnight(self):
        now = datetime(2026, 8, 12, 2, 0, tzinfo=PACIFIC)
        config = parse_schedule_config(
            {"default_interval": 300, "windows": [{"start": "22:00", "end": "04:00", "interval": 15}]},
            now,
            PACIFIC,
        )
        self.assertEqual(schedule_decision(config, now, PACIFIC).interval, 15)


class BatchSignatureTests(unittest.TestCase):
    def test_appending_an_item_changes_only_its_ordered_batch(self):
        products = [{"product_key": str(index), "name": str(index)} for index in range(6)]
        before = batch_signatures(products, 4)
        after = batch_signatures(products + [{"product_key": "6", "name": "6"}], 4)

        self.assertEqual(before[0], after[0])
        self.assertNotEqual(before[1], after[1])

    def test_identical_ordered_batches_keep_the_same_signatures(self):
        products = [{"product_key": str(index)} for index in range(7)]
        self.assertEqual(batch_signatures(products, 4), batch_signatures(list(products), 4))


if __name__ == "__main__":
    unittest.main()
