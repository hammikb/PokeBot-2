#!/usr/bin/env python3
"""Detect Pokemon Center's site-wide waiting room and fan it out to Electron tasks."""

import asyncio
import json
import os
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

import httpx
from patchright.async_api import async_playwright

from pokemon_center_queue_core import (
    Observation,
    ProxyHealthPool,
    QueueTransitionTracker,
    classify_observation,
)

try:
    from config import DISCORD_WEBHOOK_URL as CONFIG_DISCORD_WEBHOOK_URL
except (ImportError, AttributeError):
    CONFIG_DISCORD_WEBHOOK_URL = ""


CHECK_URL = os.getenv("POKEMON_CENTER_CHECK_URL", "https://www.pokemoncenter.com/")
CHECK_SECONDS = max(15, int(os.getenv("POKEMON_CENTER_CHECK_SECONDS", "30")))
OPEN_CHECK_SECONDS = max(
    300, int(os.getenv("POKEMON_CENTER_OPEN_CHECK_SECONDS", "600"))
)
CLOSE_CONFIRMATIONS = max(
    2, int(os.getenv("POKEMON_CENTER_CLOSE_CONFIRMATIONS", "2"))
)
FAILURE_THRESHOLD = max(
    1, int(os.getenv("POKEMON_CENTER_FAILURE_THRESHOLD", "2"))
)
PROXY_COOLDOWN_SECONDS = max(
    60, int(os.getenv("POKEMON_CENTER_PROXY_COOLDOWN_SECONDS", "900"))
)
HEALTH_HEARTBEAT_SECONDS = max(
    60, int(os.getenv("POKEMON_CENTER_HEALTH_HEARTBEAT_SECONDS", "300"))
)
NAVIGATION_TIMEOUT_MS = max(
    5_000, int(os.getenv("POKEMON_CENTER_NAVIGATION_TIMEOUT_MS", "30000"))
)
WATCHLIST_URL = os.getenv("POKEALERT_WATCHLIST_URL", "").strip()
INGEST_URL = os.getenv("POKEALERT_INGEST_URL", "").strip()
INGEST_TOKEN = os.getenv("POKEALERT_INGEST_TOKEN", "").strip()
DISCORD_WEBHOOK_URL = (
    os.getenv("DISCORD_WEBHOOK_URL", "").strip()
    or str(CONFIG_DISCORD_WEBHOOK_URL or "").strip()
)
STATE_FILE = os.getenv(
    "POKEMON_CENTER_STATE_FILE",
    "/home/hammikb/api-monitor-python/.pokemon-center-queue-state.json",
)
BROWSER_EXECUTABLE = os.getenv("MONITOR_BROWSER_EXECUTABLE", "/usr/bin/chromium")
PROXY_FILE = os.getenv(
    "MONITOR_PROXY_FILE", "/home/hammikb/api-monitor-python/proxies.txt"
)

QUEUE_MARKERS = (
    "virtual queue to enter pokémon center",
    "virtual queue to enter pokemon center",
    "estimated wait time",
    "keep this window open",
    "do not refresh the page",
)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def load_queue_open_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as handle:
            return json.load(handle).get("queue_open") is True
    except (FileNotFoundError, OSError, ValueError, TypeError, AttributeError):
        return False


def save_queue_open_state(queue_open):
    temporary = f"{STATE_FILE}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(
            {"queue_open": bool(queue_open), "updated_at": now_iso()},
            handle,
            separators=(",", ":"),
        )
    os.replace(temporary, STATE_FILE)


def load_proxies():
    proxies = []
    with open(PROXY_FILE, encoding="utf-8") as handle:
        for raw in handle:
            value = raw.strip()
            if not value or value.startswith("#"):
                continue
            if "://" not in value:
                value = f"http://{value}"
            parsed = urlsplit(value)
            if parsed.hostname and parsed.port:
                proxies.append(value)
    if not proxies:
        raise RuntimeError(f"No proxies loaded from {PROXY_FILE}")
    return proxies


def playwright_proxy(value):
    parsed = urlsplit(value)
    config = {"server": f"{parsed.scheme or 'http'}://{parsed.hostname}:{parsed.port}"}
    if parsed.username:
        config["username"] = parsed.username
        config["password"] = parsed.password or ""
    return config


def proxy_label(value, index=None):
    parsed = urlsplit(value)
    prefix = f"proxy[{index + 1:02d}] " if index is not None else ""
    return f"{prefix}{parsed.hostname}:{parsed.port}"


class BrowserQueueProbe:
    """One persistent browser with one proxy-bound context and page."""

    blocked_resource_types = {"image", "media", "font", "stylesheet"}

    def __init__(
        self,
        browser,
        proxies,
        check_url=CHECK_URL,
        navigation_timeout_ms=30_000,
        proxy_pool=None,
        failure_threshold=2,
        proxy_cooldown_seconds=1800,
        proxy_start_index=0,
    ):
        self.browser = browser
        self.check_url = check_url
        self.navigation_timeout_ms = int(navigation_timeout_ms)
        self.proxy_pool = proxy_pool or ProxyHealthPool(
            proxies,
            failure_threshold=failure_threshold,
            cooldown_seconds=proxy_cooldown_seconds,
            start_index=proxy_start_index,
        )
        self.user_agent = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/138.0.0.0 Safari/537.36"
        )
        self.context = None
        self.page = None
        self.rotation_count = 0
        self.context_restart_count = 0

    async def start(self):
        if self.context is not None:
            return
        _, proxy = self.proxy_pool.current()
        self.context = await self.browser.new_context(
            proxy=playwright_proxy(proxy),
            user_agent=self.user_agent,
        )
        self.context_restart_count += 1
        self.page = await self.context.new_page()
        await self.page.route("**/*", self._route_resource)

    async def _route_resource(self, route):
        if route.request.resource_type in self.blocked_resource_types:
            await route.abort()
        else:
            await route.continue_()

    async def check(self):
        await self.start()
        try:
            response = await self.page.goto(
                self.check_url,
                wait_until="domcontentloaded",
                timeout=self.navigation_timeout_ms,
            )
            texts = []
            for frame in self.page.frames:
                try:
                    text = await frame.locator("body").inner_text(timeout=3_000)
                except Exception:
                    text = ""
                if text:
                    texts.append(text[:20_000])
            status = response.status if response else None
            observation = classify_observation(status, self.page.url, texts)
        except Exception as exc:
            observation = Observation(
                "error",
                detail=f"browser {type(exc).__name__}",
            )

        index, _ = self.proxy_pool.current()
        now = time.monotonic()
        if observation.kind in ("storefront", "queue"):
            self.proxy_pool.record_success(index, now=now)
        elif self.proxy_pool.record_failure(index, now=now):
            await self.rotate(now=now)
        return observation

    async def rotate(self, now=None):
        await self.close()
        self.proxy_pool.rotate(now=time.monotonic() if now is None else now)
        self.rotation_count += 1
        await self.start()

    async def close(self):
        if self.context is not None:
            try:
                await self.context.close()
            except Exception:
                pass
        self.context = None
        self.page = None


class QueueMonitorController:
    """Apply observations to durable queue transitions and alert delivery."""

    def __init__(self, initial_queue_open, close_confirmations, publish, save_state):
        self.tracker = QueueTransitionTracker(initial_queue_open, close_confirmations)
        self.publish = publish
        self.save_state = save_state
        self.delivery = {
            "discord": bool(initial_queue_open),
            "supabase": bool(initial_queue_open),
        }
        self.checks_total = 0
        self.checks_successful = 0
        self.checks_failed = 0
        self.consecutive_failures = 0
        self.last_check_at = None
        self.last_success_at = None
        self.last_state = "queue" if initial_queue_open else "unknown"
        self.last_status = None
        self.last_error = ""

    async def process(self, observation, proxy_label=""):
        checked_at = now_iso()
        self.checks_total += 1
        self.last_check_at = checked_at
        self.last_state = observation.kind
        self.last_status = observation.status
        if observation.kind in ("storefront", "queue"):
            self.checks_successful += 1
            self.consecutive_failures = 0
            self.last_success_at = checked_at
            self.last_error = ""
        else:
            self.checks_failed += 1
            self.consecutive_failures += 1
            self.last_error = str(observation.detail or observation.kind)[:160]

        transition = self.tracker.observe(observation)
        if transition == "opened":
            self.delivery = {"discord": False, "supabase": False}
            self.save_state(True)
        elif transition == "closed":
            self.delivery = {"discord": False, "supabase": False}
            self.save_state(False)

        if observation.kind == "queue" and not all(self.delivery.values()):
            discord_sent, supabase_sent = await self.publish(dict(self.delivery))
            self.delivery["discord"] = self.delivery["discord"] or bool(discord_sent)
            self.delivery["supabase"] = self.delivery["supabase"] or bool(supabase_sent)
        return transition

    def health_snapshot(
        self,
        proxy_label,
        proxy_state,
        rotations,
        browser_restarts,
    ):
        success_percent = (
            round(self.checks_successful * 100 / self.checks_total, 1)
            if self.checks_total
            else 0.0
        )
        return {
            "state": self.last_state,
            "last_check_at": self.last_check_at,
            "last_success_at": self.last_success_at,
            "last_http_status": self.last_status,
            "consecutive_failures": self.consecutive_failures,
            "checks_total": self.checks_total,
            "checks_successful": self.checks_successful,
            "checks_failed": self.checks_failed,
            "success_percent": success_percent,
            "proxy": proxy_label,
            "proxy_state": proxy_state,
            "rotations": rotations,
            "browser_restarts": browser_restarts,
            "last_error": self.last_error,
        }


async def ingest(event_type, payload):
    if not INGEST_URL or not INGEST_TOKEN:
        raise RuntimeError("POKEALERT_INGEST_URL/POKEALERT_INGEST_TOKEN are not configured")
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(
            INGEST_URL,
            headers={"authorization": f"Bearer {INGEST_TOKEN}"},
            json={"type": event_type, "payload": payload},
        )
        response.raise_for_status()


async def remote_log(message, level="info"):
    print(f"[{level.upper()}] {message}", flush=True)
    try:
        await ingest(
            "log",
            {
                "worker_name": "pokemon-center-queue",
                "level": level,
                "message": message,
                "created_at": now_iso(),
            },
        )
    except Exception as exc:
        print(f"[WARNING] Could not publish monitor log: {exc}", flush=True)


async def load_products():
    products = []
    if WATCHLIST_URL and INGEST_TOKEN:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(
                WATCHLIST_URL,
                headers={"authorization": f"Bearer {INGEST_TOKEN}"},
            )
            response.raise_for_status()
            items = response.json().get("items") or []
            products = [row for row in items if row.get("retailer") == "pokemon-center"]

    # The stable homepage task receives the signal even when no product-specific
    # Pokemon Center listings exist yet.
    sentinel = {
        "retailer": "pokemon-center",
        "product_key": "site-queue",
        "product_url": CHECK_URL,
        "name": "Pokemon Center Queue",
    }
    by_key = {str(row.get("product_key")): row for row in products if row.get("product_key")}
    by_key.setdefault("site-queue", sentinel)
    return list(by_key.values())


async def send_discord_queue_alert():
    if not DISCORD_WEBHOOK_URL:
        print("[WARNING] Discord queue alert skipped: webhook is not configured", flush=True)
        return False

    for attempt in range(1, 4):
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                response = await client.post(
                    DISCORD_WEBHOOK_URL,
                    json={
                        "content": CHECK_URL,
                        "embeds": [
                            {
                                "title": "Pokemon Center Queue Detected",
                                "description": (
                                    "The Pokemon Center waiting room is active. "
                                    "Open PokeBot or the link now to join the queue."
                                ),
                                "url": CHECK_URL,
                                "color": 0xF5A623,
                                "timestamp": now_iso(),
                            }
                        ],
                    },
                )
                response.raise_for_status()
            print("[INFO] Discord accepted the first queue-detection alert", flush=True)
            return True
        except Exception as exc:
            print(
                f"[WARNING] Discord queue alert attempt {attempt}/3 failed: {exc}",
                flush=True,
            )
            if attempt < 3:
                await asyncio.sleep(attempt)
    return False


async def send_supabase_queue_signal():
    try:
        products = await load_products()
        payload = []
        for row in products:
            payload.append(
                {
                    "retailer": "pokemon-center",
                    "name": row.get("name") or "Pokemon Center Queue",
                    "product_key": str(row.get("product_key") or "site-queue"),
                    "product_url": row.get("product_url") or CHECK_URL,
                    "price": None,
                    "drop_type": "queue_open",
                    "created_at": now_iso(),
                }
            )
        await ingest("drop", payload)
        return True
    except Exception as exc:
        print(f"[WARNING] Could not publish Supabase queue signal: {exc}", flush=True)
        return False


async def deliver_queue_open(delivery, send_discord, send_supabase):
    discord_sent = bool(delivery.get("discord"))
    supabase_sent = bool(delivery.get("supabase"))
    if not discord_sent:
        discord_sent = bool(await send_discord())
    if not supabase_sent:
        supabase_sent = bool(await send_supabase())
    return discord_sent, supabase_sent


async def publish_queue_open(delivery=None):
    # Retry only failed destinations so a Supabase outage cannot duplicate a
    # Discord alert, and vice versa.
    discord_sent, supabase_sent = await deliver_queue_open(
        delivery or {"discord": False, "supabase": False},
        send_discord=send_discord_queue_alert,
        send_supabase=send_supabase_queue_signal,
    )

    await remote_log(
        "Queue open alert completed "
        f"(discord={'sent' if discord_sent else 'failed'}, "
        f"supabase={'published' if supabase_sent else 'failed'})"
    )
    return discord_sent, supabase_sent


def queue_state_from_text(text, url=""):
    text = text.lower()
    marker_count = sum(marker in text for marker in QUEUE_MARKERS)
    url = url.lower()
    # Incapsula/Imperva wrappers are bot-protection responses, not proof that a
    # waiting room is open. Only explicit queue copy (or a queue URL plus queue
    # copy) may trigger the time-sensitive alert.
    return marker_count >= 2 or (
        any(token in url for token in ("queue", "waitingroom", "queue-it")) and marker_count >= 1
    )


def is_security_interstitial(text):
    text = text.lower()
    return len(text) < 20_000 and "_incapsula_resource" in text


async def run():
    if not INGEST_URL or not INGEST_TOKEN:
        raise RuntimeError("Missing PokeAlert ingest configuration")
    # Fail closed. A missing or malformed proxy file must stop the service
    # instead of allowing a Pokemon Center request through the Pi's home IP.
    proxies = load_proxies()
    initial_queue_open = load_queue_open_state()
    controller = QueueMonitorController(
        initial_queue_open=initial_queue_open,
        close_confirmations=CLOSE_CONFIRMATIONS,
        publish=publish_queue_open,
        save_state=save_queue_open_state,
    )

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=True,
            executable_path=BROWSER_EXECUTABLE,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"],
        )
        probe = BrowserQueueProbe(
            browser=browser,
            proxies=proxies,
            check_url=CHECK_URL,
            navigation_timeout_ms=NAVIGATION_TIMEOUT_MS,
            failure_threshold=FAILURE_THRESHOLD,
            proxy_cooldown_seconds=PROXY_COOLDOWN_SECONDS,
            proxy_start_index=int(time.time()) % len(proxies),
        )
        await remote_log(
            "Pokemon Center browser detector started "
            f"(every {CHECK_SECONDS}s normally, every {OPEN_CHECK_SECONDS}s while open, "
            f"proxy-only, {len(proxies)} available)"
        )
        last_health_log = 0.0
        previous_state = None
        previous_rotations = 0

        try:
            while True:
                started = time.monotonic()
                try:
                    observation = await probe.check()
                except Exception as exc:
                    observation = Observation(
                        "error",
                        detail=f"browser recovery {type(exc).__name__}",
                    )

                proxy_index, _ = probe.proxy_pool.current()
                label = probe.proxy_pool.label(proxy_index)
                transition = await controller.process(observation, proxy_label=label)
                now = time.monotonic()
                state_changed = observation.kind != previous_state
                rotated = probe.rotation_count != previous_rotations
                threshold_failure = controller.consecutive_failures in (1, 5, 20)
                heartbeat_due = now - last_health_log >= HEALTH_HEARTBEAT_SECONDS

                if transition == "opened":
                    await remote_log("Pokemon Center virtual queue detected")
                elif transition == "closed":
                    await remote_log(
                        "Pokemon Center queue is no longer active; normal detection resumed"
                    )

                if state_changed or rotated or threshold_failure or heartbeat_due or transition:
                    health = controller.health_snapshot(
                        proxy_label=label,
                        proxy_state=probe.proxy_pool.state(proxy_index, now=now),
                        rotations=probe.rotation_count,
                        browser_restarts=probe.context_restart_count,
                    )
                    await remote_log(
                        "Pokemon Center detector health "
                        + json.dumps(health, separators=(",", ":"), sort_keys=True),
                        "warning" if observation.kind in ("blocked", "error") else "info",
                    )
                    last_health_log = now

                previous_state = observation.kind
                previous_rotations = probe.rotation_count
                interval = OPEN_CHECK_SECONDS if controller.tracker.queue_open else CHECK_SECONDS
                if controller.tracker.queue_open and observation.kind == "storefront":
                    interval = CHECK_SECONDS
                if observation.kind in ("blocked", "error"):
                    interval = max(
                        interval,
                        min(
                            PROXY_COOLDOWN_SECONDS,
                            max(
                                60,
                                CHECK_SECONDS
                                * (2 ** min(controller.consecutive_failures, 5)),
                            ),
                        ),
                    )
                delay = max(1.0, interval - (time.monotonic() - started))
                await asyncio.sleep(delay)
        finally:
            await probe.close()
            await browser.close()


if __name__ == "__main__":
    asyncio.run(run())
