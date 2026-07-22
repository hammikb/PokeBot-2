#!/usr/bin/env python3
"""One-shot, low-bandwidth Pokemon Center queue response diagnostic."""

import asyncio
import json

from patchright.async_api import async_playwright

from pokemon_center_queue_monitor import (
    BROWSER_EXECUTABLE,
    CHECK_URL,
    QUEUE_MARKERS,
    load_proxies,
    playwright_proxy,
)


async def main():
    proxies = load_proxies()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=True,
            executable_path=BROWSER_EXECUTABLE,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking"],
        )
        try:
            for proxy_number, proxy in enumerate([None, *proxies[:4]], start=0):
                context_options = dict(
                    user_agent=(
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/138.0.0.0 Safari/537.36"
                    ),
                )
                if proxy:
                    context_options["proxy"] = playwright_proxy(proxy)
                context = await browser.new_context(**context_options)
                try:
                    page = await context.new_page()

                    async def lightweight(route):
                        if route.request.resource_type in {"image", "media", "font", "stylesheet"}:
                            await route.abort()
                        else:
                            await route.continue_()

                    await page.route("**/*", lightweight)
                    response = await page.goto(CHECK_URL, wait_until="domcontentloaded", timeout=30_000)
                    await page.wait_for_timeout(5_000)
                    frames = []
                    for frame in page.frames:
                        try:
                            text = (await frame.locator("body").inner_text(timeout=3_000)).lower()
                        except Exception:
                            text = ""
                        frames.append(
                            {
                                "url": frame.url[:500],
                                "text_length": len(text),
                                "markers": [marker for marker in QUEUE_MARKERS if marker in text],
                                "sample": " ".join(text.split())[:300],
                            }
                        )
                    print(
                        json.dumps(
                            {
                                "proxy_number": proxy_number,
                                "connection": "proxy" if proxy else "direct",
                                "status": response.status if response else None,
                                "final_url": page.url,
                                "title": await page.title(),
                                "frames": frames,
                            },
                            indent=2,
                        ),
                        flush=True,
                    )
                    if any(frame["markers"] for frame in frames):
                        break
                except Exception as exc:
                    print(json.dumps({"proxy_number": proxy_number, "error": str(exc)[:500]}))
                finally:
                    await context.close()
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
