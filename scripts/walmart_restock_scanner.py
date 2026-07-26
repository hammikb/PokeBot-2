"""
Ultra-efficient Walmart Pokemon RESTOCK scanner — proxy-only, HTTP-based.

Proxy data: 3-8 KB per poll vs 300-500 KB for browser-based (95%+ reduction).
Pushes detected restocks to Supabase `drops` table → PokeBot auto-checkout.

REQUIREMENTS: Python 3.8+ (stdlib only — no pip installs)
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://jbnnouwhesexfllninwb.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

PROXIES_FILE = Path(os.getenv("PROXIES_PATH", str(Path(__file__).parent / "walmart-proxies.txt")))
PROXY_LIST_URL = os.getenv("PROXY_LIST_URL", "")
PROXY_BACKOFF_MS = int(os.getenv("PROXY_BACKOFF_MS", "120000"))

PRODUCTS: list[dict] = [
    {"item_id": "110256827", "name": "Surging Sparks ETB"},
    {"item_id": "2920743936", "name": "Paldea Evolved Booster Bundle"},
    {"item_id": "5179418611", "name": "Scarlet Violet 151 Booster Bundle"},
]

FAST_INTERVAL = int(os.getenv("FAST_INTERVAL", "30"))
SLOW_INTERVAL = int(os.getenv("SLOW_INTERVAL", "180"))
FAST_WEEKDAY = int(os.getenv("FAST_WEEKDAY", "2"))
FAST_START_H = int(os.getenv("FAST_START_H", "17"))
FAST_END_H = int(os.getenv("FAST_END_H", "20"))

# ── State ───────────────────────────────────────────────────────────────
last_state: dict[str, bool] = {}
proxy_cooldown: dict[str, float] = {}

def _parse_proxy_lines(lines: list[str]) -> list[str]:
    out: list[str] = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("http://") or line.startswith("https://"):
            out.append(line)
            continue
        parts = line.split(":")
        if len(parts) >= 4 and "." in parts[0]:
            host, port, user, pwd = parts[0], parts[1], parts[2], parts[3]
            out.append(f"http://{user}:{pwd}@{host}:{port}")
    return out

def _download_webshare_proxies() -> list[str]:
    if not PROXY_LIST_URL:
        return []
    print("[setup] downloading proxies from Webshare...")
    try:
        req = urllib.request.Request(PROXY_LIST_URL)
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read().decode("utf-8", errors="replace")
        PROXIES_FILE.write_text(data)
        print(f"[setup] saved to {PROXIES_FILE}")
    except Exception as exc:
        print(f"[setup] proxy download failed: {exc}")
        return []
    return _parse_proxy_lines(data.splitlines())

def load_proxies() -> list[str]:
    if PROXY_LIST_URL and (not PROXIES_FILE.exists() or PROXIES_FILE.stat().st_size < 100):
        return _download_webshare_proxies()
    if not PROXIES_FILE.exists():
        print(f"[setup] no proxies file: {PROXIES_FILE}")
        return []
    proxies = _parse_proxy_lines(PROXIES_FILE.read_text().splitlines())
    if not proxies and PROXY_LIST_URL:
        return _download_webshare_proxies()
    print(f"[setup] loaded {len(proxies)} proxies from {PROXIES_FILE}")
    return proxies

def get_healthy_proxies(proxies: list[str]) -> list[str]:
    now = time.time()
    return [p for p in proxies if proxy_cooldown.get(p, 0) < now]

def cooldown_proxy(proxy: str):
    proxy_cooldown[proxy] = time.time() + PROXY_BACKOFF_MS / 1000

def poll_item(item_id: str, proxy: str) -> dict | None:
    url = f"https://www.walmart.com/ip/{item_id}"
    proxy_handler = urllib.request.ProxyHandler({"https": proxy, "http": proxy})
    opener = urllib.request.build_opener(proxy_handler)
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
    })
    try:
        with opener.open(req, timeout=15) as resp:
            raw = resp.read()
        if not raw or len(raw) < 10:
            return None
        data = json.loads(raw.decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        if exc.code in (403, 429, 412, 503):
            return None
        return {"name": None, "price": None, "in_stock": False}
    except Exception:
        return None

    prod = data.get("item", data).get("product", data.get("item", data))
    name = prod.get("name") or data.get("name")
    pi = prod.get("priceInfo") or data.get("priceInfo") or {}
    price = pi.get("currentPrice", {}).get("price") or pi.get("wasPrice", {}).get("price")
    avail = prod.get("availabilityStatus") or data.get("availabilityStatus") or ""
    return {
        "name": name,
        "price": float(price) if price is not None else None,
        "in_stock": avail.upper() in ("IN_STOCK", "AVAILABLE"),
    }

def push_to_supabase(item_id: str, name: str, price, in_stock: bool):
    if not SUPABASE_KEY:
        return
    row = {
        "retailer": "walmart", "product_key": f"walmart-{item_id}",
        "name": name or item_id, "product_url": f"https://www.walmart.com/ip/{item_id}",
        "drop_type": "in_stock" if in_stock else "out_of_stock", "price": price,
    }
    data = json.dumps(row).encode("utf-8")
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/drops", data=data, method="POST", headers={
        "apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json", "Prefer": "return=minimal",
    })
    try:
        urllib.request.urlopen(req, timeout=10)
        print(f"  [supabase] {'IN' if in_stock else 'OUT'}_OF_STOCK {name[:50]}")
    except Exception as exc:
        print(f"  [supabase] push failed: {exc}")

def current_interval() -> int:
    now = datetime.now()
    if now.weekday() == FAST_WEEKDAY and FAST_START_H <= now.hour < FAST_END_H:
        return FAST_INTERVAL
    return SLOW_INTERVAL

def main():
    if not PRODUCTS:
        print("No products configured.")
        sys.exit(1)
    proxies = load_proxies()
    if not proxies:
        print("No proxies available.")
        sys.exit(1)
    print(f"Watching {len(PRODUCTS)} products through {len(proxies)} proxies")
    print(f"Schedule: {FAST_INTERVAL}s Wed {FAST_START_H}:00-{FAST_END_H}:00, {SLOW_INTERVAL}s otherwise")

    cycles = 0
    while True:
        t0 = time.time()
        healthy = get_healthy_proxies(proxies)
        if not healthy:
            time.sleep(30)
            cycles += 1
            continue
        pi = 0
        for product in PRODUCTS:
            iid = product["item_id"]
            label = product.get("name", iid)
            for _ in range(len(healthy)):
                proxy = healthy[pi % len(healthy)]
                pi += 1
                result = poll_item(iid, proxy)
                if result is None:
                    cooldown_proxy(proxy)
                    continue
                was = last_state.get(iid)
                now = result["in_stock"]
                if was is None or was != now:
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] "
                          f"{'IN_STOCK' if now else 'OUT_OF_STOCK'} "
                          f"{result.get('name') or label[:40]} ${result['price'] or '?'}")
                    push_to_supabase(iid, result.get("name") or label, result["price"], now)
                    last_state[iid] = now
                break
            else:
                print(f"  [blocked] {label} — all proxies blocked")
        cycles += 1
        if cycles % 10 == 0:
            ins = sum(1 for v in last_state.values() if v)
            print(f"[{datetime.now().strftime('%H:%M:%S')}] heartbeat #{cycles} — "
                  f"{ins}/{len(PRODUCTS)} in stock, "
                  f"{len(get_healthy_proxies(proxies))}/{len(proxies)} proxies healthy")
        time.sleep(max(1, current_interval() - (time.time() - t0)))

if __name__ == "__main__":
    main()