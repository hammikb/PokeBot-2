#!/usr/bin/env python3
"""Regression checks for Pokemon Center queue classification."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pokemon_center_queue_monitor import (
    is_security_interstitial,
    queue_state_from_text,
)
from pokemon_center_queue_core import (
    Observation,
    ProxyHealthPool,
    QueueTransitionTracker,
    ChallengeBackoff,
    classify_observation,
    route_request_decision,
)

# Same-origin Pokemon Center hosts that may use the proxy.
PC_FIRST_PARTY = "https://www.pokemoncenter.com/product/etb"
PC_API = "https://api.pokemoncenter.com/products/etb"


def main():
    imperva_wrapper = (
        '<script src="/_Incapsula_Resource?SWUDNSAI=31&EDet=12"></script>'
    )
    assert is_security_interstitial(imperva_wrapper)
    assert not queue_state_from_text(
        imperva_wrapper, "https://www.pokemoncenter.com/"
    )
    assert queue_state_from_text(
        "Estimated wait time. Keep this window open.",
        "https://www.pokemoncenter.com/",
    )
    assert queue_state_from_text(
        "Keep this window open.",
        "https://queue.pokemoncenter.com/waitingroom",
    )
    assert not queue_state_from_text(
        "<title>Pokémon Center Official Site</title>",
        "https://www.pokemoncenter.com/",
    )
    assert classify_observation(
        200,
        "https://www.pokemoncenter.com/",
        ["Estimated wait time: 00:12:00", "Keep this window open."],
    ).kind == "queue"
    assert classify_observation(
        200,
        "https://www.pokemoncenter.com/",
        ["Skip to content", "Search Pikachu, plush, t-shirts", "My Cart"],
    ).kind == "storefront"
    assert classify_observation(
        403,
        "https://www.pokemoncenter.com/",
        ["Verifying the device..."],
    ).kind == "blocked"
    assert classify_observation(
        200,
        "https://geo.captcha-delivery.com/captcha/",
        ["Access is temporarily restricted", "automated bot activity"],
    ).kind == "blocked"
    assert classify_observation(200, "https://www.pokemoncenter.com/", [""]).kind == "error"

    # --- Proxy-bandwidth request routing: the core "uses too much proxy data" fix.
    # Cross-origin analytics / telemetry / ad hosts are aborted even when they
    # look like scripts or fetches.
    assert route_request_decision("script", "https://www.google-analytics.com/ga.js") == "abort"
    assert route_request_decision("fetch", "https://api.segment.io/v1/t") == "abort"
    assert route_request_decision("image", "https://assets.pokemoncenter.com/hero.png") == "abort"
    assert route_request_decision("stylesheet", "https://assets.pokemoncenter.com/s.css") == "abort"
    # A third-party host with an empty resource type is still aborted (URL allow-list).
    assert route_request_decision("", "https://tracker.example.com/event") == "abort"
    # First-party document and same-origin API reads are allowed through the proxy.
    assert route_request_decision("document", PC_FIRST_PARTY) == "continue"
    assert route_request_decision("script", PC_FIRST_PARTY) == "continue"
    assert route_request_decision("xhr", PC_API) == "continue"
    assert route_request_decision("script", "https://cdn.pokemoncenter.com/app.js") == "continue"
    assert route_request_decision("script", "https://events.queue-it.net/queue.js") == "continue"
    assert route_request_decision("script", "https://evilpokemoncenter.com/app.js") == "abort"
    # (The probe additionally blocks non-GET; the type/host gate above is what
    # route_request_decision owns, and the GET check is unit-tested separately.)

    # HTTP 200 security interstitials are still blocked, but retain a useful
    # distinction from generic browser failures.
    interstitial = classify_observation(
        200,
        PC_FIRST_PARTY,
        ["Verifying the device before continuing"],
    )
    assert interstitial.kind == "blocked"
    assert "200" in interstitial.detail

    # Repeated challenges trigger a bounded global pause; valid observations
    # reset it so a recovered site is checked normally again.
    backoff = ChallengeBackoff(threshold=2, base_seconds=10, max_seconds=25)
    assert backoff.record("blocked", now=100) == 0
    assert backoff.record("blocked", now=101) == 10
    assert backoff.remaining(now=105) == 6
    assert backoff.record("blocked", now=110) == 20
    assert backoff.remaining(now=129) == 1
    assert backoff.remaining(now=130) == 0
    backoff.record("storefront", now=131)
    assert backoff.remaining(now=131) == 0

    transitions = QueueTransitionTracker(close_confirmations=2)
    assert transitions.observe(Observation("queue")) == "opened"
    assert transitions.observe(Observation("queue")) is None
    assert transitions.observe(Observation("blocked")) is None
    assert transitions.queue_open is True
    assert transitions.observe(Observation("error")) is None
    assert transitions.queue_open is True
    assert transitions.observe(Observation("storefront")) is None
    assert transitions.observe(Observation("storefront")) == "closed"
    assert transitions.queue_open is False

    pool = ProxyHealthPool(
        ["http://user:secret@proxy-one:80", "http://user:secret@proxy-two:80"],
        failure_threshold=2,
        cooldown_seconds=60,
    )
    assert pool.current() == (0, "http://user:secret@proxy-one:80")
    pool.record_success(1, now=90)
    pool.record_failure(0, now=99)
    assert pool.failure_count(0) == 1
    assert pool.record_failure(0, now=100) is True
    assert pool.failure_count(0) == 0
    assert pool.rotate(now=100) == (1, "http://user:secret@proxy-two:80")
    assert pool.label(0) == "proxy[01] proxy-one:80"
    assert "secret" not in pool.label(0)

    single = ProxyHealthPool(["http://user:secret@only-proxy:80"], failure_threshold=1)
    assert single.record_failure(0, now=100) is True
    try:
        single.rotate(now=100)
    except RuntimeError as exc:
        assert "eligible proxy" in str(exc)
    else:
        raise AssertionError("a quarantined pool must not fall back to a direct connection")
    assert single.rotate(now=100 + single.cooldown_seconds + 1)[0] == 0
    print("Pokemon Center queue classifier regression checks passed")


if __name__ == "__main__":
    main()
