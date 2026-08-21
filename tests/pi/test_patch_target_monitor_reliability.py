import unittest

from scripts.maintenance.patch_target_monitor_reliability import patch_source


FIXTURE = '''import asyncio
import json
import os
import random
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit

MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS = 5, 3600
POKEALERT_INGEST_URL = os.getenv("POKEALERT_INGEST_URL", "").strip()
POKEALERT_INGEST_TOKEN = os.getenv("POKEALERT_INGEST_TOKEN", "legacy").strip()
POKEALERT_WATCHLIST_REFRESH = int(os.getenv("POKEALERT_WATCHLIST_REFRESH", "180"))
DISCORD_WEBHOOK_URL = ""
PRODUCTS = {}
PRODUCTS_PER_CONTEXT = 5
POKEALERT_WATCHLIST_URL = "https://example.test/api/watchlist"
SCHEDULE_FILE = Path("schedule.json")
SCHEDULE_CACHE_TTL_SECONDS = 30
CHECK_INTERVAL_DAY = 300
CHECK_INTERVAL_NIGHT = 30

def load_schedule(path=SCHEDULE_FILE):
    return None

_SCHEDULE_CACHE = {"loaded_at": 0.0, "value": None}

def schedule_interval(schedule, now=None):
    return schedule["default_interval"]

def current_check_interval():
    return CHECK_INTERVAL_DAY

def parse_stock(body):
    return None

def build_worker_health(value):
    return {"cpu_percent": value}

def load_remote_products():
    return None

def unique_product_items(products):
    return list(products.items())

class ApiMonitor:
    def __init__(self):
        self.in_stock = set()
        self.state_file = Path("api_monitor_state.json")
        self._side_effects = set()
        self._last_cpu_times = None
        self.active_contexts = 0
        self._load_state()

    async def _post_ingest(self, event_type, payload):
        return None

    async def _publish_worker_health(self):
        await self._post_ingest("worker_health", build_worker_health(0))

    async def _publish_drop(self, name, tcin, price=None, quantity=None, status=None):
        await self._post_ingest("drop", {"product_key": tcin})

    async def _publish_inventory(self, tcin, state):
        return None

    async def _alert(self, name, tcin, price=None, image=None, quantity=None, status=None):
        return None

    def _side_effect(self, coro):
        return None

    async def _enrich_and_alert(self, name, tcin, state, page, visitor_id):
        return None

    async def _apply(self, name, tcin, state, page=None, visitor_id=None):
        return None

    async def watchlist_refresh_forever(self, sync_watchers, interval=POKEALERT_WATCHLIST_REFRESH):
        return None

    async def run(self):
        return None

async def main():
    return None
'''


class TargetMonitorPatcherTests(unittest.TestCase):
    def test_patch_is_idempotent_and_compilable(self):
        once = patch_source(FIXTURE)
        twice = patch_source(once)

        self.assertEqual(once, twice)
        self.assertIn("TARGET_RELIABILITY_PATCH_V1", once)
        self.assertIn('"source_event_id": event.source_event_id', once)
        self.assertIn('query["wait"] = "true"', once)
        self.assertIn('"15"', once)
        self.assertIn("batch_signatures", once)
        self.assertIn("retry_delay = 300.0", once)
        self.assertIn("if not had_failure", once)
        compile(once, "ApiMonitor.py", "exec")

    def test_patch_removes_embedded_ingest_token_fallback(self):
        patched = patch_source(FIXTURE)
        self.assertNotIn('os.getenv("POKEALERT_INGEST_TOKEN", "legacy")', patched)
        self.assertIn('os.getenv("POKEALERT_INGEST_TOKEN", "")', patched)


if __name__ == "__main__":
    unittest.main()
