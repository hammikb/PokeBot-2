"""
Push Walmart restock drops from the Pi's existing monitor into PokeBot's
Supabase realtime channel via the `drops` table.

The Pi's Walmart monitor (monitor.py) already detects Pokemon card restocks
and pushes them to Discord + drop_log.  This module adds ONE more destination:
the Supabase `drops` table that PokeBot desktop listens to via Realtime.

When a drop lands here, PokeBot's desktop app broadcasts it to every
subscribed Electron instance, which can then trigger auto-checkout.

Usage – import in the main monitor loop:
    from pokebot_drop_pusher import push_to_pokebot
    ...
    await push_to_pokebot(hit, SUPABASE_URL, SUPABASE_KEY)
"""

import json
import urllib.request
import urllib.error


def push_to_pokebot(hit: dict, supabase_url: str, supabase_key: str, dry_run: bool = False):
    """
    Insert a Walmart restock into the PokeBot `drops` table.

    Parameters
    ----------
    hit : dict
        Normalized product dict (same shape the existing monitor uses):
        { "item_id": "...", "name": "...", "price": 19.99,
          "price_string": "$19.99", "availability": "IN_STOCK" }
    supabase_url : str
        Supabase project URL
    supabase_key : str
        Supabase service-role key (required for INSERT)
    dry_run : bool
        If True, log but don't push
    """
    if dry_run or not supabase_key:
        status = "DRY-RUN" if dry_run else "no-key"
        print(f"  [pokebot:{status}] {hit['name'][:45]} @ {hit.get('price_string')}")
        return

    product_key = f"walmart-{hit['item_id']}"

    row = {
        "retailer": "walmart",
        "product_key": product_key,
        "name": hit.get("name"),
        "product_url": f"https://www.walmart.com/ip/{hit['item_id']}",
        "drop_type": "in_stock",
        "price": hit.get("price"),
        "price_text": hit.get("price_string"),
        "raw_payload": json.dumps(hit, default=str),
    }

    data = json.dumps(row).encode("utf-8")
    url = f"{supabase_url}/rest/v1/drops"

    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "apikey": supabase_key,
            "Authorization": f"Bearer {supabase_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            status = resp.status
        if status in (200, 201, 204):
            print(
                f"  [pokebot] OK {hit['name'][:45]} -> PokeBot notified "
                f"({hit.get('price_string')})"
            )
        else:
            print(f"  [pokebot] HTTP {status}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:200]
        print(f"  [pokebot] HTTP {exc.code}: {body}")
    except Exception as exc:
        print(f"  [pokebot] push failed: {exc}")