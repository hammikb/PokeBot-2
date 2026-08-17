#!/usr/bin/env python3
"""Regression checks for the persistent Pokemon Center browser boundary."""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pokemon_center_queue_core import Observation
from pokemon_center_queue_monitor import (
    BrowserQueueProbe,
    QueueMonitorController,
    calculate_check_interval,
    deliver_queue_open,
)


class FakeLocator:
    def __init__(self, text):
        self.text = text

    async def inner_text(self, timeout=None):
        return self.text


class FakeFrame:
    def __init__(self, url, text):
        self.url = url
        self.text = text

    def locator(self, selector):
        assert selector == "body"
        return FakeLocator(self.text)


class FakeResponse:
    def __init__(self, status=200):
        self.status = status


class FakePage:
    def __init__(self, status=200, text=None, error=None):
        self.url = "https://www.pokemoncenter.com/"
        self.status = status
        self.error = error
        self.frames = [
            FakeFrame(
                self.url,
                text
                or "Skip to content Search Pikachu, plush, t-shirts New Releases My Cart",
            )
        ]
        self.goto_calls = []
        self.wait_calls = []
        self.route_handler = None
        self.closed = False
        self.response_handlers = []

    def on(self, event, handler):
        if event == "response":
            self.response_handlers.append(handler)

    async def route(self, pattern, handler):
        assert pattern == "**/*"
        self.route_handler = handler

    async def goto(self, url, wait_until, timeout):
        self.goto_calls.append((url, wait_until, timeout))
        if self.error:
            raise RuntimeError(self.error)
        self.url = url
        return FakeResponse(self.status)

    async def wait_for_timeout(self, milliseconds):
        self.wait_calls.append(milliseconds)

    async def close(self):
        self.closed = True


class FakeContext:
    def __init__(self, page=None):
        self.page = page or FakePage()
        self.new_page_calls = 0
        self.closed = False

    async def new_page(self):
        self.new_page_calls += 1
        return self.page

    async def close(self):
        self.closed = True


class FakeBrowser:
    def __init__(self, pages=None):
        self.contexts = []
        self.context_options = []
        self.pages = list(pages or [])

    async def new_context(self, **options):
        self.context_options.append(options)
        page = self.pages.pop(0) if self.pages else FakePage()
        context = FakeContext(page)
        self.contexts.append(context)
        return context


class FakeRoute:
    def __init__(self, resource_type, method="GET", url=""):
        self.request = type(
            "Request", (), {"resource_type": resource_type, "method": method, "url": url}
        )()
        self.action = None

    async def abort(self):
        self.action = "abort"

    async def continue_(self):
        self.action = "continue"


async def main():
    browser = FakeBrowser()
    probe = BrowserQueueProbe(
        browser=browser,
        proxies=["http://user:secret@proxy-one:80"],
        check_url="https://www.pokemoncenter.com/",
        navigation_timeout_ms=12_000,
    )
    await probe.start()
    first = await probe.check()
    second = await probe.check()

    assert first.kind == "storefront"
    assert second.kind == "storefront"
    assert len(browser.contexts) == 1
    assert browser.contexts[0].new_page_calls == 1
    assert browser.contexts[0].page.goto_calls == [
        ("https://www.pokemoncenter.com/", "domcontentloaded", 12_000),
        ("about:blank", "commit", 5_000),
        ("https://www.pokemoncenter.com/", "domcontentloaded", 12_000),
        ("about:blank", "commit", 5_000),
    ]
    assert browser.contexts[0].page.wait_calls == [3_000, 3_000]
    assert browser.context_options == [
        {
            "proxy": {
                "server": "http://proxy-one:80",
                "username": "user",
                "password": "secret",
            },
            "user_agent": probe.user_agent,
        }
    ]

    image = FakeRoute("image")
    document = FakeRoute("document")
    await browser.contexts[0].page.route_handler(image)
    await browser.contexts[0].page.route_handler(document)
    assert image.action == "abort"
    assert document.action == "continue"

    await probe.close()
    assert browser.contexts[0].closed is True

    blocked_browser = FakeBrowser(
        pages=[
            FakePage(status=403, text="Verifying the device..."),
            FakePage(),
        ]
    )
    blocked_probe = BrowserQueueProbe(
        browser=blocked_browser,
        proxies=[
            "http://user:secret@blocked-proxy:80",
            "http://user:secret@working-proxy:80",
        ],
        failure_threshold=1,
    )
    blocked = await blocked_probe.check()
    assert blocked.kind == "blocked"
    assert blocked_browser.contexts[0].closed is True
    assert len(blocked_browser.contexts) == 2
    assert blocked_probe.rotation_count == 1
    assert blocked_probe.proxy_pool.failure_count() == 0
    recovered = await blocked_probe.check()
    assert recovered.kind == "storefront"
    await blocked_probe.close()

    crash_browser = FakeBrowser(
        pages=[
            FakePage(error="page destroyed at http://user:secret@proxy-one:80"),
            FakePage(),
        ]
    )
    crash_probe = BrowserQueueProbe(
        browser=crash_browser,
        proxies=["http://user:secret@proxy-one:80", "http://user:secret@proxy-two:80"],
        failure_threshold=1,
    )
    crashed = await crash_probe.check()
    assert crashed.kind == "error"
    assert "secret" not in crashed.detail
    assert len(crash_browser.contexts) == 2
    assert (await crash_probe.check()).kind == "storefront"
    await crash_probe.close()

    exhausted_browser = FakeBrowser(pages=[FakePage(status=403)])
    exhausted_probe = BrowserQueueProbe(
        browser=exhausted_browser,
        proxies=["http://user:secret@only-proxy:80"],
        failure_threshold=1,
    )
    try:
        await exhausted_probe.check()
    except RuntimeError as exc:
        assert "eligible proxy" in str(exc)
    else:
        raise AssertionError("proxy exhaustion must fail closed")
    assert len(exhausted_browser.contexts) == 1
    assert exhausted_browser.contexts[0].closed is True

    deliveries = []
    saved_states = []

    async def publish(delivery):
        deliveries.append(dict(delivery))
        return True, True

    controller = QueueMonitorController(
        initial_queue_open=False,
        close_confirmations=2,
        publish=publish,
        save_state=saved_states.append,
    )
    await controller.process(Observation("storefront", 200), proxy_label="proxy[01]")
    await controller.process(Observation("queue", 200), proxy_label="proxy[01]")
    await controller.process(Observation("queue", 200), proxy_label="proxy[01]")
    assert deliveries == [{"discord": False, "supabase": False}]
    assert saved_states == [True]

    await controller.process(Observation("blocked", 403), proxy_label="proxy[02]")
    await controller.process(Observation("error", None), proxy_label="proxy[02]")
    assert controller.tracker.queue_open is True
    assert saved_states == [True]
    await controller.process(Observation("storefront", 200), proxy_label="proxy[02]")
    assert controller.tracker.queue_open is True
    await controller.process(Observation("storefront", 200), proxy_label="proxy[02]")
    assert controller.tracker.queue_open is False
    assert saved_states == [True, False]

    retry_deliveries = []

    async def retry_publish(delivery):
        retry_deliveries.append(dict(delivery))
        if len(retry_deliveries) == 1:
            return True, False
        return True, True

    retry_controller = QueueMonitorController(
        initial_queue_open=False,
        close_confirmations=2,
        publish=retry_publish,
        save_state=lambda value: None,
    )
    await retry_controller.process(Observation("queue", 200), proxy_label="proxy[01]")
    await retry_controller.process(Observation("queue", 200), proxy_label="proxy[01]")
    assert retry_deliveries == [
        {"discord": False, "supabase": False},
        {"discord": True, "supabase": False},
    ]

    health = retry_controller.health_snapshot(
        proxy_label="proxy[01] proxy-one:80",
        proxy_state="eligible",
        rotations=1,
        browser_restarts=2,
    )
    assert health["state"] == "queue"
    assert health["checks_total"] == 2
    assert health["checks_successful"] == 2
    assert health["checks_failed"] == 0
    assert health["success_percent"] == 100.0
    assert health["proxy"] == "proxy[01] proxy-one:80"
    assert health["rotations"] == 1
    assert health["browser_restarts"] == 2

    channel_calls = []

    async def already_sent_discord():
        channel_calls.append("discord")
        return True

    async def pending_supabase():
        channel_calls.append("supabase")
        return True

    delivered = await deliver_queue_open(
        {"discord": True, "supabase": False},
        send_discord=already_sent_discord,
        send_supabase=pending_supabase,
    )
    assert delivered == (True, True)
    assert channel_calls == ["supabase"]
    assert calculate_check_interval("storefront", False, 0, False, 30, 600, 900) == 30
    assert calculate_check_interval("queue", True, 0, False, 30, 600, 900) == 600
    assert calculate_check_interval("storefront", True, 0, False, 30, 600, 900) == 30
    assert calculate_check_interval("blocked", False, 1, False, 30, 600, 900) == 60
    assert calculate_check_interval("blocked", False, 0, True, 30, 600, 900) == 5

    # --- Proxy-bandwidth routing: abort third-party and non-GET requests, and
    # account for what was proxied vs aborted.
    class ProbeRequest:
        def __init__(self, method, resource_type, url):
            self.method = method
            self.resource_type = resource_type
            self.url = url

    class ProbeRoute:
        def __init__(self, request):
            self.request = request
            self.action = None

        async def abort(self):
            self.action = "abort"

        async def continue_(self):
            self.action = "continue"

    routing_browser = FakeBrowser()
    routing_probe = BrowserQueueProbe(
        browser=routing_browser,
        proxies=["http://user:secret@proxy-one:80"],
        check_url="https://www.pokemoncenter.com/",
    )
    await routing_probe.start()
    cases = [
        ("GET", "document", "https://www.pokemoncenter.com/", "continue"),
        ("GET", "xhr", "https://api.pokemoncenter.com/products/etb", "continue"),
        ("GET", "script", "https://www.google-analytics.com/ga.js", "abort"),
        ("GET", "script", "https://www.pokemoncenter.com/app.js", "continue"),
        ("GET", "image", "https://assets.pokemoncenter.com/x.png", "abort"),
        ("POST", "xhr", "https://www.pokemoncenter.com/notify", "abort"),
        ("GET", "fetch", "https://cdn.thirdparty.com/beacon", "abort"),
    ]
    for method, rtype, url, expected in cases:
        route = ProbeRoute(ProbeRequest(method, rtype, url))
        await routing_probe._route_resource(route)
        assert route.action == expected, f"{method} {rtype} {url} -> {route.action}"
    assert routing_probe.proxied_requests == 3
    assert routing_probe.aborted_requests == 4
    # A 4MB proxied response is included in best-effort data accounting.
    routing_probe._on_response(type("R", (), {"headers": {"content-length": "4194304"}})())
    assert routing_probe.proxied_bytes == 4194304
    await routing_probe.close()

    print("Pokemon Center persistent browser regression checks passed")


if __name__ == "__main__":
    asyncio.run(main())
