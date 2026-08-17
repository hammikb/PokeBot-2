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

from pokemon_center_queue_core import Observation, ProxyHealthPool, classify_observation

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
    ):
        self.browser = browser
        self.check_url = check_url
        self.navigation_timeout_ms = int(navigation_timeout_ms)
        self.proxy_pool = proxy_pool or ProxyHealthPool(
            proxies,
            failure_threshold=failure_threshold,
            cooldown_seconds=proxy_cooldown_seconds,
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


def is_proxy_gateway_error(exc):
    message = str(exc).lower()
    return isinstance(exc, httpx.ProxyError) or any(
        marker in message
        for marker in (
            "502 bad gateway",
            "503 service unavailable",
            "504 gateway timeout",
            "http 502",
            "http 503",
            "http 504",
            "proxy error",
        )
    )


def pokemon_center_client(proxy, headers):
    if not proxy:
        raise RuntimeError("Refusing direct Pokemon Center connection: proxy is required")
    return httpx.AsyncClient(
        timeout=20,
        follow_redirects=True,
        headers=headers,
        proxy=proxy,
    )


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


async def publish_queue_open():
    # Discord is attempted first and independently. A watchlist or Supabase
    # outage must never suppress the time-sensitive queue alert.
    discord_sent = await send_discord_queue_alert()
    supabase_sent = False
    product_count = 0
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
        product_count = len(payload)
        await ingest("drop", payload)
        supabase_sent = True
    except Exception as exc:
        print(f"[WARNING] Could not publish Supabase queue signal: {exc}", flush=True)

    await remote_log(
        "Queue open alert completed "
        f"(discord={'sent' if discord_sent else 'failed'}, "
        f"supabase={'published' if supabase_sent else 'failed'}, "
        f"products={product_count})"
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
    proxy_index = int(time.time()) % len(proxies)
    await remote_log(
        "Pokemon Center queue detector started "
        f"(every {CHECK_SECONDS}s normally, every {OPEN_CHECK_SECONDS}s while open, "
        f"proxy required, {len(proxies)} available)"
    )

    headers = {
        "user-agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/138.0.0.0 Safari/537.36"
        ),
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
    }
    client = pokemon_center_client(proxies[proxy_index], headers)
    try:
        queue_was_open = load_queue_open_state()
        consecutive_closed = 0
        consecutive_errors = 0
        bytes_used = 0
        last_bandwidth_log = time.monotonic()
        first_success_logged = False

        while True:
            started = time.monotonic()
            check_succeeded = False
            try:
                gateway_failovers = 0
                while True:
                    try:
                        # Read no more than 64 KiB of the decoded response. The active
                        # Imperva wrapper is about 1 KiB; a normal storefront response is
                        # closed early instead of downloading megabytes of HTML.
                        chunks = []
                        decoded_bytes = 0
                        async with client.stream("GET", CHECK_URL) as response:
                            status = response.status_code
                            async for chunk in response.aiter_bytes():
                                remaining = 65_536 - decoded_bytes
                                if remaining <= 0:
                                    break
                                chunks.append(chunk[:remaining])
                                decoded_bytes += min(len(chunk), remaining)
                                if decoded_bytes >= 65_536:
                                    break
                            final_url = str(response.url)

                        body = b"".join(chunks).decode("utf-8", errors="ignore")
                        if is_security_interstitial(body):
                            raise RuntimeError(
                                "Pokemon Center returned an Imperva security interstitial"
                            )
                        queue_open = queue_state_from_text(body, final_url)
                        if (
                            status not in (200, 301, 302, 303, 307, 308)
                            and not queue_open
                        ):
                            raise RuntimeError(f"Pokemon Center returned HTTP {status}")
                        bytes_used += decoded_bytes
                        break
                    except Exception as exc:
                        max_failovers = min(2, len(proxies) - 1)
                        if (
                            not is_proxy_gateway_error(exc)
                            or gateway_failovers >= max_failovers
                        ):
                            raise

                        previous_proxy = proxy_label(
                            proxies[proxy_index], proxy_index
                        )
                        await client.aclose()
                        proxy_index = (proxy_index + 1) % len(proxies)
                        client = pokemon_center_client(
                            proxies[proxy_index], headers
                        )
                        gateway_failovers += 1
                        print(
                            "[WARNING] Pokemon Center proxy gateway failed; "
                            f"immediate failover {previous_proxy} -> "
                            f"{proxy_label(proxies[proxy_index], proxy_index)} "
                            f"(retry {gateway_failovers}/{max_failovers})",
                            flush=True,
                        )

                consecutive_errors = 0
                check_succeeded = True
                if not first_success_logged:
                    await remote_log(
                        "Pokemon Center proxied check succeeded "
                        f"(HTTP {status}, queue_open={str(queue_open).lower()}, "
                        f"{proxy_label(proxies[proxy_index], proxy_index)})"
                    )
                    first_success_logged = True
                if queue_open:
                    consecutive_closed = 0
                    if not queue_was_open:
                        await remote_log(
                            "Pokemon Center queue/interstitial detected "
                            f"(HTTP {status}, {decoded_bytes} bytes)"
                        )
                        # One transition produces one Supabase event and one Pi-side
                        # Discord alert. Electron only handles desktop notifications.
                        await publish_queue_open()
                        save_queue_open_state(True)
                    queue_was_open = True
                elif queue_was_open:
                    consecutive_closed += 1
                    if consecutive_closed >= CLOSE_CONFIRMATIONS:
                        queue_was_open = False
                        consecutive_closed = 0
                        save_queue_open_state(False)
                        await remote_log(
                            "Pokemon Center queue is no longer active; normal detection resumed"
                        )
                else:
                    consecutive_closed = 0
            except Exception as exc:
                consecutive_errors += 1
                print(f"[WARNING] Check failed ({consecutive_errors}): {exc}", flush=True)
                blocked_response = any(
                    marker in str(exc)
                    for marker in (
                        "HTTP 403",
                        "HTTP 429",
                        "Imperva security interstitial",
                    )
                )
                gateway_error = is_proxy_gateway_error(exc)
                if blocked_response or gateway_error or consecutive_errors % 3 == 0:
                    previous_proxy = proxy_label(proxies[proxy_index], proxy_index)
                    await client.aclose()
                    proxy_index = (proxy_index + 1) % len(proxies)
                    client = pokemon_center_client(proxies[proxy_index], headers)
                    await remote_log(
                        "Pokemon Center proxy rotated after repeated errors "
                        f"({previous_proxy} -> "
                        f"{proxy_label(proxies[proxy_index], proxy_index)})",
                        "warning",
                    )
                if consecutive_errors in (1, 5, 20):
                    await remote_log(
                        f"Pokemon Center check error x{consecutive_errors}: {str(exc)[:300]}",
                        "warning",
                    )

            if time.monotonic() - last_bandwidth_log >= 3600:
                await remote_log(
                    f"Pokemon Center detector downloaded at most {bytes_used / 1_000_000:.2f} MB of response bodies since startup"
                )
                last_bandwidth_log = time.monotonic()

            interval = OPEN_CHECK_SECONDS if queue_was_open else CHECK_SECONDS
            if queue_was_open and consecutive_closed:
                # Once the queue appears closed, confirm promptly rather than
                # waiting the full queue-open interval between confirmations.
                interval = CHECK_SECONDS
            if not check_succeeded:
                # Avoid repeating the old tight 403 loop. Errors back off from
                # one minute to at most fifteen minutes; a successful proxied
                # response resets the counter and normal cadence immediately.
                interval = max(
                    interval,
                    min(900, max(60, CHECK_SECONDS * (2 ** min(consecutive_errors, 5)))),
                )
            delay = max(1.0, interval - (time.monotonic() - started))
            await asyncio.sleep(delay)
    finally:
        await client.aclose()


if __name__ == "__main__":
    asyncio.run(run())
