#!/usr/bin/env python3
"""Low-bandwidth, proxy-only observer for Target Redsky availability."""

import asyncio
import json
import os
import pathlib
import re
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import httpx

try:
    from config import DISCORD_WEBHOOK_URL as CONFIG_DISCORD_WEBHOOK_URL
except (ImportError, AttributeError):
    CONFIG_DISCORD_WEBHOOK_URL = ""


def parse_clock_minutes(value):
    match = re.fullmatch(r"(\d{1,2}):(\d{2})", str(value or "").strip())
    if not match:
        raise ValueError(f"Invalid clock time {value!r}; expected HH:MM")
    hour, minute = (int(part) for part in match.groups())
    if hour > 23 or minute > 59:
        raise ValueError(f"Invalid clock time {value!r}; expected HH:MM")
    return hour * 60 + minute


REDSKY_URL = (
    "https://redsky.target.com/redsky_aggregations/v1/web/"
    "product_fulfillment_and_variation_hierarchy_v1"
)
DEFAULT_API_KEY = "9f36aeafbe60771e321a7cc95a78140772ab3e96"
DEFAULT_PRODUCT_URL = "https://www.target.com/p/guppy/A-1011483406"

STATIC_PRODUCT_URLS = [
    value.strip()
    for value in os.getenv("TARGET_STOCK_URLS", "").split(",")
    if value.strip()
]
INGEST_URL = os.getenv("POKEALERT_INGEST_URL", "").strip()
INGEST_TOKEN = os.getenv("POKEALERT_INGEST_TOKEN", "").strip()
WATCHLIST_URL = os.getenv(
    "POKEALERT_WATCHLIST_URL",
    INGEST_URL.replace("/api/ingest", "/api/watchlist") if INGEST_URL else "",
).strip()
API_KEY = os.getenv("TARGET_REDSKY_API_KEY", DEFAULT_API_KEY).strip()
STORE_ID = os.getenv("TARGET_STOCK_STORE_ID", "1296").strip()
ZIP_CODE = os.getenv("TARGET_STOCK_ZIP", "90001").strip()
STATE_CODE = os.getenv("TARGET_STOCK_STATE", "CA").strip()
CHECK_SECONDS = max(15, int(os.getenv("TARGET_STOCK_CHECK_SECONDS", "30")))
SLOW_CHECK_SECONDS = max(
    CHECK_SECONDS, int(os.getenv("TARGET_STOCK_SLOW_CHECK_SECONDS", "300"))
)
POLL_TIME_ZONE_NAME = os.getenv(
    "TARGET_STOCK_TIME_ZONE", "America/Los_Angeles"
).strip()
FAST_WINDOW_START_MINUTE = parse_clock_minutes(
    os.getenv("TARGET_STOCK_FAST_WINDOW_START", "23:30")
)
FAST_WINDOW_END_MINUTE = parse_clock_minutes(
    os.getenv("TARGET_STOCK_FAST_WINDOW_END", "03:30")
)
REQUEST_SPACING_SECONDS = max(
    0.0, float(os.getenv("TARGET_STOCK_REQUEST_SPACING_SECONDS", "2"))
)
PRODUCT_REFRESH_SECONDS = max(
    60, int(os.getenv("TARGET_STOCK_PRODUCT_REFRESH_SECONDS", "300"))
)
ERROR_BACKOFF_MAX_SECONDS = max(
    60, int(os.getenv("TARGET_STOCK_ERROR_BACKOFF_MAX_SECONDS", "900"))
)
START_PROXY_INDEX = max(0, int(os.getenv("TARGET_STOCK_PROXY_INDEX", "0")))
PROXY_FILE = pathlib.Path(
    os.getenv(
        "TARGET_STOCK_PROXY_FILE",
        "/home/hammikb/api-monitor-python/proxies.txt",
    )
)
STATE_FILE = pathlib.Path(
    os.getenv(
        "TARGET_STOCK_STATE_FILE",
        "/home/hammikb/api-monitor-python/.target-stock-observer-state.json",
    )
)
DISCORD_WEBHOOK_URL = (
    os.getenv("DISCORD_WEBHOOK_URL", "").strip()
    or str(CONFIG_DISCORD_WEBHOOK_URL or "").strip()
)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/138.0.0.0 Safari/537.36"
)


class TargetBlockedError(RuntimeError):
    """Target rejected the current proxy session with a block/rate-limit response."""


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def is_fast_poll_window(local_datetime):
    minute_of_day = local_datetime.hour * 60 + local_datetime.minute
    if FAST_WINDOW_START_MINUTE < FAST_WINDOW_END_MINUTE:
        return FAST_WINDOW_START_MINUTE <= minute_of_day < FAST_WINDOW_END_MINUTE
    return (
        minute_of_day >= FAST_WINDOW_START_MINUTE
        or minute_of_day < FAST_WINDOW_END_MINUTE
    )


def current_poll_schedule(now=None, monitor_timezone=None):
    zone = monitor_timezone or ZoneInfo(POLL_TIME_ZONE_NAME)
    current = (now or datetime.now(timezone.utc)).astimezone(zone)
    if is_fast_poll_window(current):
        return "fast", CHECK_SECONDS, current
    return "slow", SLOW_CHECK_SECONDS, current


def extract_tcin(product_url):
    match = re.search(r"(?:^|/)A-(\d+)(?:[/?#]|$)", product_url)
    if not match:
        raise ValueError(f"Cannot extract a TCIN from {product_url!r}")
    return match.group(1)


def load_proxies(path=PROXY_FILE):
    proxies = []
    with path.open(encoding="utf-8") as handle:
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
        raise RuntimeError(
            f"No proxies loaded from {path}; refusing a direct Target connection"
        )
    return proxies


def proxy_label(proxy, index):
    parsed = urlsplit(proxy)
    return f"proxy[{index + 1:02d}] {parsed.hostname}:{parsed.port}"


def is_retryable_proxy_error(exc):
    if isinstance(exc, (httpx.ProxyError, httpx.ConnectError, httpx.ConnectTimeout)):
        return True
    message = str(exc).lower()
    return any(
        marker in message
        for marker in (
            "502 bad gateway",
            "503 service unavailable",
            "504 gateway timeout",
            "proxy error",
        )
    )


def is_target_block(exc):
    return isinstance(exc, TargetBlockedError)


async def load_product_urls():
    urls = list(STATIC_PRODUCT_URLS)
    if WATCHLIST_URL and INGEST_TOKEN:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(
                WATCHLIST_URL,
                headers={"authorization": f"Bearer {INGEST_TOKEN}"},
            )
            response.raise_for_status()
            items = response.json().get("items") or []
        urls.extend(
            str(item.get("product_url") or "").strip()
            for item in items
            if str(item.get("retailer") or "").lower() == "target"
        )

    valid = {}
    for product_url in urls:
        try:
            valid[extract_tcin(product_url)] = product_url
        except ValueError:
            continue
    if not valid:
        # Keep the service testable before the dashboard watchlist is populated.
        valid[extract_tcin(DEFAULT_PRODUCT_URL)] = DEFAULT_PRODUCT_URL
    return list(valid.values())


async def post_ingest(event_type, payload):
    if not INGEST_URL or not INGEST_TOKEN:
        raise RuntimeError(
            "POKEALERT_INGEST_URL/POKEALERT_INGEST_TOKEN are not configured"
        )
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(
            INGEST_URL,
            headers={"authorization": f"Bearer {INGEST_TOKEN}"},
            json={"type": event_type, "payload": payload},
        )
        response.raise_for_status()


async def publish_inventory_observation(current):
    await post_ingest(
        "target_inventory",
        {
            "tcin": current["tcin"],
            "product_url": current["product_url"],
            "availability_status": current.get("availability_status"),
            "available_to_promise_quantity": current.get(
                "available_to_promise_quantity"
            ),
            "reason_code": current.get("reason_code"),
            "available": bool(current.get("available")),
            "observed_at": current["observed_at"],
        },
    )


async def publish_early_drop(current):
    await post_ingest(
        "drop",
        {
            "retailer": "target",
            "product_key": current["tcin"],
            "product_url": current["product_url"],
            "name": f"Target TCIN {current['tcin']}",
            "drop_type": "inventory_quantity",
        },
    )


def find_shipping_options(root):
    stack = [root]
    seen = set()
    while stack:
        value = stack.pop()
        if not isinstance(value, (dict, list)):
            continue
        marker = id(value)
        if marker in seen:
            continue
        seen.add(marker)
        if isinstance(value, dict):
            options = value.get("shipping_options")
            if isinstance(options, dict):
                return {
                    "availability_status": options.get("availability_status"),
                    "available_to_promise_quantity": options.get(
                        "available_to_promise_quantity"
                    ),
                    "reason_code": options.get("reason_code"),
                }
            stack.extend(value.values())
        else:
            stack.extend(value)
    return None


def is_available(observation):
    status = str(observation.get("availability_status") or "").upper()
    quantity = observation.get("available_to_promise_quantity")
    try:
        positive_quantity = quantity is not None and float(quantity) > 0
    except (TypeError, ValueError):
        positive_quantity = False
    return status in {
        "IN_STOCK",
        "LIMITED_STOCK",
        "PREORDER",
        "PRE_ORDER",
        "PRE_ORDER_SELLABLE",
    } or positive_quantity


def load_state():
    try:
        value = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_FILE.with_suffix(f"{STATE_FILE.suffix}.tmp")
    temporary.write_text(
        json.dumps(state, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary, STATE_FILE)


def make_client(proxy):
    if not proxy:
        raise RuntimeError("Refusing direct Target connection: proxy is required")
    return httpx.AsyncClient(
        proxy=proxy,
        timeout=25,
        follow_redirects=False,
        headers={
            "accept": "application/json",
            "accept-encoding": "gzip, deflate",
            "referer": "https://www.target.com/",
            "user-agent": USER_AGENT,
        },
    )


async def fetch_observation(client, product_url):
    tcin = extract_tcin(product_url)
    response = await client.get(
        REDSKY_URL,
        params={
            "key": API_KEY,
            "tcin": tcin,
            "store_id": STORE_ID,
            "pricing_store_id": STORE_ID,
            "zip": ZIP_CODE,
            "state": STATE_CODE,
            "has_pricing_store_id": "true",
            "visitor_id": "0",
            "channel": "WEB",
            "page": f"/p/A-{tcin}",
        },
    )
    if response.status_code in (403, 429):
        raise TargetBlockedError(
            f"Target blocked the request with HTTP {response.status_code}"
        )
    response.raise_for_status()
    options = find_shipping_options(response.json())
    if not options:
        raise RuntimeError("Target response did not contain shipping_options")
    return {
        "tcin": tcin,
        "product_url": product_url,
        **options,
        "available": is_available(options),
        "response_bytes": len(response.content),
        "observed_at": now_iso(),
    }


async def send_discord_alert(previous, current):
    if not DISCORD_WEBHOOK_URL:
        print("[WARNING] Discord webhook is not configured; alert skipped", flush=True)
        return
    old_quantity = previous.get("available_to_promise_quantity", 0)
    new_quantity = current.get("available_to_promise_quantity")
    message = (
        f"Target TCIN {current['tcin']} changed to "
        f"{current.get('availability_status') or 'UNKNOWN'} "
        f"(ATP {old_quantity} -> {new_quantity})."
    )
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            DISCORD_WEBHOOK_URL,
            json={
                "content": current["product_url"],
                "embeds": [
                    {
                        "title": "Target stock change detected",
                        "description": message,
                        "url": current["product_url"],
                        "color": 0xCC0000,
                        "timestamp": current["observed_at"],
                    }
                ],
            },
        )
        response.raise_for_status()


def changed_to_available(previous, current):
    return bool(current.get("available")) and not bool(previous.get("available"))


def inventory_changed(previous, current):
    if not previous:
        return True
    keys = (
        "availability_status",
        "available_to_promise_quantity",
        "reason_code",
        "available",
    )
    return any(previous.get(key) != current.get(key) for key in keys)


async def run():
    if not INGEST_URL or not INGEST_TOKEN:
        raise RuntimeError(
            "POKEALERT_INGEST_URL/POKEALERT_INGEST_TOKEN are required"
        )
    product_urls = await load_product_urls()

    # Loading this file is deliberately mandatory. There is no direct-network
    # code path for Target requests in this service.
    proxies = load_proxies()
    proxy_index = START_PROXY_INDEX % len(proxies)
    client = make_client(proxies[proxy_index])
    state = load_state()
    consecutive_errors = 0
    downloaded_bytes = 0
    last_bandwidth_log = time.monotonic()
    last_product_refresh = time.monotonic()
    schedule_mode, scheduled_interval, local_now = current_poll_schedule()
    last_schedule_mode = schedule_mode

    print(
        "[INFO] Target stock observer started "
        f"(products={len(product_urls)}, fast={CHECK_SECONDS}s "
        f"from 23:30-03:30 {POLL_TIME_ZONE_NAME}, "
        f"slow={SLOW_CHECK_SECONDS}s, current={schedule_mode} "
        f"at {local_now.strftime('%Y-%m-%d %H:%M:%S %Z')}, "
        f"proxy_required=true, {proxy_label(proxies[proxy_index], proxy_index)})",
        flush=True,
    )

    try:
        while True:
            cycle_started = time.monotonic()
            schedule_mode, scheduled_interval, local_now = current_poll_schedule()
            if schedule_mode != last_schedule_mode:
                print(
                    "[INFO] Target polling schedule changed "
                    f"(mode={schedule_mode}, interval={scheduled_interval}s, "
                    f"local_time={local_now.strftime('%Y-%m-%d %H:%M:%S %Z')})",
                    flush=True,
                )
                last_schedule_mode = schedule_mode
            cycle_succeeded = True
            cycle_target_blocked = False
            if time.monotonic() - last_product_refresh >= PRODUCT_REFRESH_SECONDS:
                try:
                    refreshed_urls = await load_product_urls()
                    if refreshed_urls != product_urls:
                        product_urls = refreshed_urls
                        print(
                            f"[INFO] Refreshed Target watchlist (products={len(product_urls)})",
                            flush=True,
                        )
                    last_product_refresh = time.monotonic()
                except Exception as exc:
                    print(f"[WARNING] Target watchlist refresh failed: {exc}", flush=True)

            for position, product_url in enumerate(product_urls):
                tcin = extract_tcin(product_url)
                try:
                    failovers = 0
                    while True:
                        try:
                            current = await fetch_observation(client, product_url)
                            break
                        except Exception as exc:
                            max_failovers = min(2, len(proxies) - 1)
                            if (
                                not is_retryable_proxy_error(exc)
                                or failovers >= max_failovers
                            ):
                                raise
                            old_label = proxy_label(proxies[proxy_index], proxy_index)
                            await client.aclose()
                            proxy_index = (proxy_index + 1) % len(proxies)
                            client = make_client(proxies[proxy_index])
                            failovers += 1
                            print(
                                "[WARNING] Target proxy failed; immediate failover "
                                f"({old_label} -> "
                                f"{proxy_label(proxies[proxy_index], proxy_index)}, "
                                f"retry={failovers}/{max_failovers})",
                                flush=True,
                            )

                    downloaded_bytes += current["response_bytes"]
                    previous = state.get(tcin, {})
                    print(
                        "[INFO] "
                        f"tcin={tcin} status={current['availability_status']} "
                        f"atp={current['available_to_promise_quantity']} "
                        f"reason={current['reason_code']} "
                        f"bytes={current['response_bytes']}",
                        flush=True,
                    )
                    if inventory_changed(previous, current):
                        try:
                            await publish_inventory_observation(current)
                            print(
                                f"[INFO] Inventory change published for tcin={tcin}",
                                flush=True,
                            )
                        except Exception as exc:
                            print(
                                f"[WARNING] Inventory publish failed for tcin={tcin}: {exc}",
                                flush=True,
                            )
                    if previous and changed_to_available(previous, current):
                        try:
                            await asyncio.gather(
                                send_discord_alert(previous, current),
                                publish_early_drop(current),
                            )
                            print(
                                f"[INFO] Early inventory alert published for tcin={tcin}",
                                flush=True,
                            )
                        except Exception as exc:
                            print(
                                f"[WARNING] Early inventory alert failed for tcin={tcin}: {exc}",
                                flush=True,
                            )
                    state[tcin] = current
                    save_state(state)
                except Exception as exc:
                    cycle_succeeded = False
                    print(f"[WARNING] tcin={tcin} check failed: {exc}", flush=True)
                    if is_target_block(exc):
                        cycle_target_blocked = True
                        # One block applies to the current proxy session. Stop
                        # this cycle instead of spending the remaining products
                        # and proxy identities on requests that will also fail.
                        break
                if position + 1 < len(product_urls) and REQUEST_SPACING_SECONDS:
                    await asyncio.sleep(REQUEST_SPACING_SECONDS)

            if cycle_succeeded:
                consecutive_errors = 0
            else:
                consecutive_errors += 1
                if cycle_target_blocked or consecutive_errors in (2, 5):
                    old_label = proxy_label(proxies[proxy_index], proxy_index)
                    await client.aclose()
                    proxy_index = (proxy_index + 1) % len(proxies)
                    client = make_client(proxies[proxy_index])
                    print(
                        "[WARNING] Switching proxy after repeated failures "
                        f"({old_label} -> {proxy_label(proxies[proxy_index], proxy_index)})",
                        flush=True,
                    )

            if time.monotonic() - last_bandwidth_log >= 3600:
                print(
                    "[INFO] Target response bodies downloaded since startup: "
                    f"{downloaded_bytes / 1_000_000:.3f} MB",
                    flush=True,
                )
                last_bandwidth_log = time.monotonic()

            interval = scheduled_interval
            if cycle_target_blocked:
                # A 15-minute circuit breaker avoids burning all residential
                # proxy identities while Target is denying the pool.
                interval = max(900, scheduled_interval)
            elif consecutive_errors:
                interval = min(
                    ERROR_BACKOFF_MAX_SECONDS,
                    max(
                        60,
                        scheduled_interval * (2 ** min(consecutive_errors, 5)),
                    ),
                )
            await asyncio.sleep(
                max(1, interval - (time.monotonic() - cycle_started))
            )
    finally:
        await client.aclose()


if __name__ == "__main__":
    asyncio.run(run())
