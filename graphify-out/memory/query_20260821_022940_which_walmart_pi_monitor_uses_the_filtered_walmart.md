---
type: "query"
date: "2026-08-21T02:29:40.203083+00:00"
question: "Which Walmart Pi monitor uses the filtered Walmart listing link for Walmart-owned or GT Collectibles items?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["walmart_queue_rank_tracker.mjs", "walmartHeaders()", "WalmartQueueHost", "parseListingItemIds()"]
---

# Q: Which Walmart Pi monitor uses the filtered Walmart listing link for Walmart-owned or GT Collectibles items?

## Answer

Expanded from original query via vocab: [walmart, browse, search, stock, rank, retailer, product]. The monitor using the filtered Walmart browse link is scripts/walmart_queue_rank_tracker.mjs. Its default URL filters the Pokemon collectibles browse page with retailer_type:Walmart and product-type facets, then candidates are restricted by item.soldByWalmart. GT Collectibles is not explicitly named or allowlisted in this repository. The legacy monitor_walmart_pokemon.mjs and walmart_restock_scanner.py only poll fixed item IDs; WalmartQueueHost can accept a listing URL but parses all item IDs and does not apply a seller filter.

## Outcome

- Signal: useful

## Source Nodes

- walmart_queue_rank_tracker.mjs
- walmartHeaders()
- WalmartQueueHost
- parseListingItemIds()