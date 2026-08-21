---
type: "query"
date: "2026-08-20T22:44:18.850581+00:00"
question: "review Walmart monitoring on the Pi for problems and improvements"
contributor: "graphify"
outcome: "useful"
source_nodes: ["walmart_restock_scanner.py", "monitor_walmart_pokemon.mjs", "walmart_queue_rank_tracker.mjs", "push_to_supabase()", "pushDrop()"]
---

# Q: review Walmart monitoring on the Pi for problems and improvements

## Answer

Expanded from original query via vocab: [walmart, monitor, monitoring, restock, stock, price, product, alert, notification, poll, playwright, proxy, worker, retry, heartbeat]. Review found three overlapping Pi paths: walmart_restock_scanner.py, legacy monitor_walmart_pokemon.mjs, and a rank tracker intended for a separate server-side-alert-bot checkout. Highest risks are inconsistent Walmart product_key formats (prefixed walmart-ID in the Python and legacy scripts versus raw item ID in the app and rank tracker), non-durable in-memory state and lost Supabase delivery failures, direct non-proxy traffic in the legacy service, and missing local dependencies for the rank tracker. Tests passed, but the scanner has only an import smoke test.

## Outcome

- Signal: useful

## Source Nodes

- walmart_restock_scanner.py
- monitor_walmart_pokemon.mjs
- walmart_queue_rank_tracker.mjs
- push_to_supabase()
- pushDrop()