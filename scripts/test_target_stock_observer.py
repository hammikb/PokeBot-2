#!/usr/bin/env python3
"""Small dependency-free regression checks for the Target stock observer."""

from target_stock_observer import (
    TargetBlockedError,
    changed_to_available,
    extract_tcin,
    find_shipping_options,
    inventory_changed,
    is_available,
    is_retryable_proxy_error,
    is_target_block,
)


def main():
    assert (
        extract_tcin("https://www.target.com/p/guppy/A-1011483406")
        == "1011483406"
    )
    assert (
        extract_tcin("https://www.target.com/p/name/-/A-12345678?preselect=1")
        == "12345678"
    )
    payload = {
        "data": {
            "product": {
                "fulfillment": {
                    "shipping_options": {
                        "availability_status": "OUT_OF_STOCK",
                        "available_to_promise_quantity": 0.0,
                        "reason_code": "INVENTORY_UNAVAILABLE",
                    }
                }
            }
        }
    }
    observation = find_shipping_options(payload)
    assert observation["availability_status"] == "OUT_OF_STOCK"
    assert observation["available_to_promise_quantity"] == 0.0
    assert not is_available(observation)
    assert is_available(
        {
            "availability_status": "PREORDER",
            "available_to_promise_quantity": None,
        }
    )
    assert is_available(
        {
            "availability_status": "OUT_OF_STOCK",
            "available_to_promise_quantity": 3,
        }
    )
    assert changed_to_available({"available": False}, {"available": True})
    assert not changed_to_available({"available": True}, {"available": True})
    assert inventory_changed({}, observation)
    assert inventory_changed(
        {"available_to_promise_quantity": 0},
        {"available_to_promise_quantity": 10},
    )
    assert not inventory_changed(observation, dict(observation))
    assert is_target_block(TargetBlockedError("Target blocked with HTTP 403"))
    assert not is_retryable_proxy_error(TargetBlockedError("Target blocked with HTTP 403"))
    assert not is_retryable_proxy_error(RuntimeError("invalid JSON"))
    print("Target stock observer regression checks passed")


if __name__ == "__main__":
    main()
