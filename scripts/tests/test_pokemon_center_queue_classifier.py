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
    classify_observation,
)


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
