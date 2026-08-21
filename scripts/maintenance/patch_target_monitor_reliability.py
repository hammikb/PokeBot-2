"""Idempotently add durable Target delivery to the production Pi monitor."""

from __future__ import annotations

import argparse
import ast
import os
import re
import tempfile
from pathlib import Path
from textwrap import dedent


MARKER = "# TARGET_RELIABILITY_PATCH_V1"


def _replace_callable(source: str, name: str, replacement: str) -> str:
    tree = ast.parse(source)
    matches = [
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name
    ]
    if len(matches) != 1:
        raise ValueError(f"expected one callable named {name}, found {len(matches)}")
    node = matches[0]
    lines = source.splitlines(keepends=True)
    start = sum(len(line) for line in lines[: node.lineno - 1])
    end = sum(len(line) for line in lines[: node.end_lineno])
    normalized = replacement.rstrip() + "\n"
    return source[:start] + normalized + source[end:]


def _replace_once(source: str, old: str, new: str, label: str) -> str:
    if source.count(old) != 1:
        raise ValueError(f"expected one {label} anchor, found {source.count(old)}")
    return source.replace(old, new, 1)


LOAD_SCHEDULE = dedent('''
def load_schedule(path=SCHEDULE_FILE):
    """Return one fully validated recurring/release schedule, or None."""
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        return parse_schedule_config(
            payload,
            datetime.now(),
            ZoneInfo("America/Los_Angeles"),
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
''').strip()


CURRENT_INTERVAL = dedent('''
def current_schedule_decision():
    now_ts = time()
    if now_ts - _SCHEDULE_CACHE["loaded_at"] >= SCHEDULE_CACHE_TTL_SECONDS:
        _SCHEDULE_CACHE["value"] = load_schedule()
        _SCHEDULE_CACHE["loaded_at"] = now_ts
    schedule = _SCHEDULE_CACHE["value"]
    if schedule:
        return schedule_decision(
            schedule,
            datetime.now(),
            ZoneInfo("America/Los_Angeles"),
        )
    now = datetime.now()
    minutes = now.hour * 60 + now.minute
    interval = CHECK_INTERVAL_DAY if 240 <= minutes <= 1320 else CHECK_INTERVAL_NIGHT
    profile = "legacy-day" if interval == CHECK_INTERVAL_DAY else "legacy-night"
    return ScheduleDecision(interval, profile, None)


def current_check_interval():
    return current_schedule_decision().interval
''').strip()


POST_INGEST = '''    async def _post_ingest(self, event_type, payload):
        if not POKEALERT_INGEST_URL or not POKEALERT_INGEST_TOKEN:
            raise RuntimeError("PokeAlert ingest is not configured")
        headers = {"authorization": f"Bearer {POKEALERT_INGEST_TOKEN}"}
        body = {"type": event_type, "payload": payload}
        last_error = None
        for attempt in range(3):
            try:
                response = await asyncio.to_thread(
                    httpx.post,
                    POKEALERT_INGEST_URL,
                    json=body,
                    headers=headers,
                    timeout=15,
                )
                response.raise_for_status()
                return response.status_code
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    await asyncio.sleep(0.5 * (attempt + 1))
        print(f"ingest {event_type} failed after 3 tries: {last_error}")
        raise RuntimeError(f"ingest {event_type} failed after 3 tries") from last_error
'''


PUBLISH_WORKER_HEALTH = '''    async def _publish_worker_health(self):
        current = read_cpu_times()
        cpu_value = cpu_percent(self._last_cpu_times, current)
        self._last_cpu_times = current or self._last_cpu_times
        payload = build_worker_health(cpu_value)
        payload.update(self.alert_state.delivery_health())
        decision = current_schedule_decision()
        payload.update({
            "watchlist_product_count": self.watchlist_product_count,
            "watchlist_last_success_at": self.watchlist_last_success_at,
            "active_schedule_profile": decision.profile,
            "schedule_next_transition_at": (
                decision.next_transition_at.astimezone(timezone.utc).isoformat()
                if decision.next_transition_at else None
            ),
        })
        if not DISCORD_WEBHOOK_URL and not payload.get("last_discord_status"):
            payload["last_discord_status"] = "disabled"
        await self._post_ingest("worker_health", payload)
'''


PUBLISH_DROP_AND_DISPATCH = '''    async def _publish_drop(self, event):
        payload = dict(event.payload)
        payload.update({
            "source_event_id": event.source_event_id,
            "retailer": "target",
            "product_key": event.tcin,
            "product_url": f"https://www.target.com/p/-/A-{event.tcin}",
            "name": payload.get("name") or event.tcin,
            "drop_type": "in_stock",
            "created_at": event.created_at,
        })
        return await self._post_ingest("drop", payload)

    async def _deliver_cloud(self, event):
        status = await self._publish_drop(event)
        self.alert_state.mark_destination(event.source_event_id, "cloud", status=status)

    async def _deliver_discord(self, event):
        if not DISCORD_WEBHOOK_URL:
            self.alert_state.mark_destination(event.source_event_id, "discord", status="disabled")
            return
        url = f"https://www.target.com/p/-/A-{event.tcin}"
        payload = event.payload
        embed = {
            "title": f"🚨 RESTOCK: {payload.get('name') or event.tcin}"[:250],
            "url": url,
            "color": 0x2ECC71,
            "fields": [
                {"name": "Retailer", "value": "Target", "inline": True},
                {"name": "Detected", "value": event.created_at, "inline": True},
            ],
            "footer": {"text": "PokeAlert · Target"},
            "timestamp": event.created_at,
        }
        if payload.get("available_to_promise_quantity") is not None:
            embed["fields"].append({
                "name": "ATP quantity",
                "value": str(payload["available_to_promise_quantity"]),
                "inline": True,
            })
        if payload.get("availability_status"):
            embed["fields"].append({
                "name": "Availability",
                "value": str(payload["availability_status"])[:100],
                "inline": True,
            })
        parts = urlsplit(DISCORD_WEBHOOK_URL)
        query = dict(parse_qsl(parts.query, keep_blank_values=True))
        query["wait"] = "true"
        webhook_url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))
        response = await asyncio.to_thread(
            httpx.post,
            webhook_url,
            json={"embeds": [embed]},
            timeout=15,
        )
        response.raise_for_status()
        message_id = str(response.json().get("id") or "").strip()
        if not message_id:
            raise RuntimeError("Discord did not return a message id")
        self.alert_state.mark_destination(
            event.source_event_id,
            "discord",
            status=response.status_code,
            message_id=message_id,
        )

    async def dispatch_alerts_forever(self):
        while True:
            pending = self.alert_state.pending()
            if not pending:
                self._delivery_wakeup.clear()
                try:
                    await asyncio.wait_for(self._delivery_wakeup.wait(), timeout=5)
                except asyncio.TimeoutError:
                    pass
                continue

            retry_delay = 300.0
            had_failure = False
            for event in pending:
                for destination in self.alert_state.pending():
                    if destination.source_event_id == event.source_event_id:
                        event = destination
                        break
                for destination in ("cloud", "discord"):
                    state = event.destinations.get(destination)
                    if not state or state.get("confirmed_at"):
                        continue
                    try:
                        if destination == "cloud":
                            await self._deliver_cloud(event)
                        else:
                            await self._deliver_discord(event)
                    except Exception as exc:
                        had_failure = True
                        self.alert_state.mark_attempt(event.source_event_id, destination, error=exc)
                        failures = int(state.get("attempts") or 0) + 1
                        retry_delay = min(
                            retry_delay,
                            max(0.25, random.uniform(0, min(300, 2 ** min(failures, 9)))),
                        )
                        print(f"{destination} delivery retry scheduled for {event.tcin}")
                        break
                await asyncio.sleep(0)
            if not had_failure:
                continue
            try:
                self._delivery_wakeup.clear()
                await asyncio.wait_for(self._delivery_wakeup.wait(), timeout=retry_delay)
            except asyncio.TimeoutError:
                pass
'''


ALERT = '''    async def _alert(self, name, tcin, price=None, image=None, quantity=None, status=None):
        """Log/enrich after the durable cloud/Discord fan-out has been queued."""
        url = f"https://www.target.com/p/-/A-{tcin}"
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"\\n🚨 STOCK ALERT: {name}  ({ts})\\n   {url}")
        await self._record_drop_log(name, tcin, price, quantity)
'''


APPLY = '''    async def _apply(self, name, tcin, state, page=None, visitor_id=None):
        if state is None:
            return
        inventory_key = (
            state.get("buyable"),
            state.get("quantity"),
            state.get("status"),
            state.get("reason_code"),
        )
        if self._last_inventory.get(tcin) != inventory_key:
            self._last_inventory[tcin] = inventory_key
            self._side_effect(self._publish_inventory(tcin, state))
            print(
                f"📦 {name}: status={state.get('status') or 'unknown'} "
                f"atp={state.get('quantity')} buyable={state.get('buyable')}"
            )

        if state["buyable"] and tcin not in self.alert_state.in_stock:
            event = self.alert_state.ensure_transition(tcin, {
                "name": name,
                "price": None,
                "available_to_promise_quantity": state.get("quantity"),
                "availability_status": state.get("status"),
            })
            if event is not None:
                try:
                    await self._deliver_cloud(event)
                except Exception as exc:
                    self.alert_state.mark_attempt(event.source_event_id, "cloud", error=exc)
                    print(f"cloud delivery queued for retry: {tcin}")
                self._delivery_wakeup.set()
                self._side_effect(self._enrich_and_alert(name, tcin, state, page, visitor_id))
        elif not state["buyable"] and tcin in self.alert_state.in_stock:
            self.alert_state.clear_in_stock(tcin)
            print(f"📦 {name} went out of stock")
'''


WATCHLIST_REFRESH = '''    async def watchlist_refresh_forever(self, sync_watchers, interval=POKEALERT_WATCHLIST_REFRESH):
        """Refresh authenticated membership without rebuilding unchanged batches."""
        if not interval or not POKEALERT_WATCHLIST_URL:
            return
        while True:
            await asyncio.sleep(interval)
            products = await asyncio.to_thread(load_remote_products)
            if products:
                self.watchlist_product_count = len(set(products.values()))
                self.watchlist_last_success_at = datetime.now(timezone.utc).isoformat()
            if products and products != dict(PRODUCTS):
                PRODUCTS.clear()
                PRODUCTS.update(products)
                print(f"🔄 Watchlist changed → {len(PRODUCTS)} products; reconciling contexts")
                await self._seed_catalog()
                await sync_watchers()
'''


RUN = '''    async def run(self):
        print(f"\\n🎯 Target API Monitor — {len(PRODUCTS)} products")
        schedule = load_schedule()
        if schedule:
            windows = ", ".join(
                f"{window.start.strftime('%H:%M')}-{window.end.strftime('%H:%M')} @ {window.interval}s"
                for window in schedule.windows
            ) or "none"
            print(f"   Schedule (Pi local time): {windows}; "
                  f"otherwise {schedule.default_interval}s. Ctrl+C to stop.\\n")
        else:
            print(f"   Polling redsky fulfillment every ~{CHECK_INTERVAL_DAY // 60}min (4am–10pm) / "
                  f"~{CHECK_INTERVAL_NIGHT}s (10pm–4am), Pi local time. Ctrl+C to stop.\\n")
        async with async_playwright() as p:
            browser = await launch_browser(p)
            watch_tasks = {}

            async def sync_watchers():
                items = unique_product_items(PRODUCTS)
                batches = [
                    items[index:index + PRODUCTS_PER_CONTEXT]
                    for index in range(0, len(items), PRODUCTS_PER_CONTEXT)
                ]
                signatures = batch_signatures(
                    [{"name": name, "product_key": tcin} for name, tcin in items],
                    PRODUCTS_PER_CONTEXT,
                )
                desired = dict(zip(signatures, batches))

                for signature, batch in desired.items():
                    task = watch_tasks.get(signature)
                    if task is None or task.done():
                        watch_tasks[signature] = asyncio.create_task(
                            self.watch_batch_forever(browser, batch)
                        )
                        await asyncio.sleep(0)

                obsolete = [signature for signature in watch_tasks if signature not in desired]
                obsolete_tasks = [watch_tasks.pop(signature) for signature in obsolete]
                for task in obsolete_tasks:
                    task.cancel()
                if obsolete_tasks:
                    await asyncio.gather(*obsolete_tasks, return_exceptions=True)

                self.active_contexts = len(desired)
                print(f"🧩 Running {len(desired)} context(s) for {len(items)} products")

            await sync_watchers()
            background = [
                asyncio.create_task(self.report_forever()),
                asyncio.create_task(self.publish_forever()),
                asyncio.create_task(self.watchlist_refresh_forever(sync_watchers)),
                asyncio.create_task(self.dispatch_alerts_forever()),
            ]
            try:
                await asyncio.gather(*background, return_exceptions=True)
            except KeyboardInterrupt:
                print("\\n⏹️ Shutting down...")
            finally:
                for task in [*watch_tasks.values(), *background]:
                    task.cancel()
                await asyncio.gather(*watch_tasks.values(), *background, return_exceptions=True)
                if self._side_effects:
                    await asyncio.wait(self._side_effects, timeout=5)
                print(f"📊 Session: {self.checks} checks, {self.bytes_used / 1_000_000:.2f} MB total")
                await browser.close()
'''


def patch_source(source: str) -> str:
    if MARKER in source:
        return source

    source = _replace_once(
        source,
        "from urllib.parse import urlencode, urlsplit",
        "from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit\nfrom zoneinfo import ZoneInfo\n\nfrom target_reliability import (\n    AtomicAlertState,\n    ScheduleDecision,\n    batch_signatures,\n    parse_schedule_config,\n    schedule_decision,\n)",
        "URL imports",
    )
    source = source.replace(
        "MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS = 5, 3600",
        "MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS = 15, 3600",
        1,
    )
    source, token_replacements = re.subn(
        r'POKEALERT_INGEST_TOKEN = os\.getenv\("POKEALERT_INGEST_TOKEN",\s*"[^"]*"\)\.strip\(\)',
        'POKEALERT_INGEST_TOKEN = os.getenv("POKEALERT_INGEST_TOKEN", "").strip()',
        source,
        count=1,
    )
    if token_replacements != 1:
        raise ValueError("expected one ingest token assignment")
    source, refresh_replacements = re.subn(
        r'POKEALERT_WATCHLIST_REFRESH = int\(os\.getenv\("POKEALERT_WATCHLIST_REFRESH",\s*"\d+"\)\)',
        'POKEALERT_WATCHLIST_REFRESH = int(os.getenv("POKEALERT_WATCHLIST_REFRESH", "15"))',
        source,
        count=1,
    )
    if refresh_replacements != 1:
        raise ValueError("expected one watchlist refresh assignment")

    source = _replace_callable(source, "load_schedule", LOAD_SCHEDULE)
    source = _replace_callable(source, "current_check_interval", CURRENT_INTERVAL)
    source = _replace_once(
        source,
        "        self._load_state()",
        "        self._load_state()\n"
        "        destinations = (\"cloud\", \"discord\") if DISCORD_WEBHOOK_URL else (\"cloud\",)\n"
        "        self.alert_state = AtomicAlertState(self.state_file, destinations=destinations)\n"
        "        self.in_stock = self.alert_state.in_stock\n"
        "        self.watchlist_product_count = len(set(PRODUCTS.values()))\n"
        "        self.watchlist_last_success_at = None\n"
        "        self._delivery_wakeup = asyncio.Event()",
        "monitor initialization",
    )
    source = _replace_callable(source, "_post_ingest", POST_INGEST)
    source = _replace_callable(source, "_publish_worker_health", PUBLISH_WORKER_HEALTH)
    source = _replace_callable(source, "_publish_drop", PUBLISH_DROP_AND_DISPATCH)
    source = _replace_callable(source, "_alert", ALERT)
    source = _replace_callable(source, "_apply", APPLY)
    source = _replace_callable(source, "watchlist_refresh_forever", WATCHLIST_REFRESH)
    source = _replace_callable(source, "run", RUN)
    return f"{MARKER}\n{source}"


def patch_file(source_path: Path, destination_path: Path) -> None:
    patched = patch_source(source_path.read_text(encoding="utf-8"))
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=destination_path.parent,
            prefix=f".{destination_path.name}.",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(patched)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination_path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    patch_file(args.source, args.destination)


if __name__ == "__main__":
    main()
