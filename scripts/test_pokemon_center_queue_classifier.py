#!/usr/bin/env python3
"""Regression checks for Pokemon Center queue classification."""

from pokemon_center_queue_monitor import (
    is_security_interstitial,
    queue_state_from_text,
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
    print("Pokemon Center queue classifier regression checks passed")


if __name__ == "__main__":
    main()
