#!/usr/bin/env python3
"""Test monitor proxies without exposing credentials or using the Pi's home IP."""

import asyncio
import os
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pokemon_center_queue_monitor import load_proxies, proxy_label


TESTS = (
    ("generic HTTPS", "https://api.ipify.org?format=json"),
    ("Pokemon Center", "https://www.pokemoncenter.com/"),
)


async def check(proxy, proxy_number):
    results = []
    async with httpx.AsyncClient(
        proxy=proxy,
        follow_redirects=False,
        timeout=15,
        headers={"user-agent": "Mozilla/5.0"},
    ) as client:
        for label, url in TESTS:
            try:
                async with client.stream("GET", url) as response:
                    results.append(f"{label}=HTTP {response.status_code}")
            except Exception as exc:
                name = type(exc).__name__
                detail = str(exc).strip().splitlines()[0] if str(exc).strip() else "no detail"
                results.append(f"{label}={name}: {detail[:120]}")
    print(f"{proxy_label(proxy, proxy_number)} | " + " | ".join(results), flush=True)


async def main():
    proxies = load_proxies()
    limit = max(1, int(os.getenv("PROXY_TEST_LIMIT", "5")))
    for index, proxy in enumerate(proxies[:limit], start=0):
        await check(proxy, index)


if __name__ == "__main__":
    asyncio.run(main())
