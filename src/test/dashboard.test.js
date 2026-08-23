import assert from "node:assert/strict";
import test from "node:test";

import { isAuthorizedIngestRequest } from "../lib/ingest-auth.js";
import {
  isDuplicateSourceEventError,
  normalizeCatalogPayload,
  normalizeDropPayload,
  normalizeProductPayload,
} from "../lib/ingest-payload.js";
import { buildProductUrl, normalizeProductKey, normalizeRetailer, resolveProductUrl } from "../lib/product-url.js";
import {
  countProductsByRetailer,
  productMatchesRetailer,
  sortProductsByMonitoringStatus,
} from "../lib/product-retailers.js";
import {
  demoState,
  deriveAddedProductKeys,
  freshnessState,
  normalizeCatalogEntry,
  normalizeDrop,
  normalizeHealth,
  summarize,
} from "../lib/dashboard.js";
import { formatDashboardTime } from "../lib/time.js";
import { matchSet } from "../lib/pokemon-sets.js";
import {
  ALLOWED_SERVICES,
  DEVICE_SERVICES,
  SERVICE_META,
  SERVICE_LABELS,
  serviceDisplayName,
  serviceGroup,
} from "../lib/pi-services.js";

test("production and experimental Target services have explicit display metadata", () => {
  assert.ok(DEVICE_SERVICES["pokebot-worker"].includes("target-stock-observer-go"));
  assert.equal(serviceDisplayName("target-stock-observer-go"), "Target Stock Monitor (Go)");
  assert.equal(serviceGroup("target-stock-observer-go"), "production");
  assert.equal(serviceGroup("target-stock-observer-go-test"), "experimental");
  assert.equal(SERVICE_META["target-stock-observer-go"].supportsLogs, true);
  assert.ok(ALLOWED_SERVICES.includes("target-stock-observer-go"));
});

test("freshnessState distinguishes fresh, stale, and offline telemetry", () => {
  const now = Date.parse("2026-08-23T20:00:00.000Z");
  assert.equal(freshnessState("2026-08-23T19:59:30.000Z", now), "fresh");
  assert.equal(freshnessState("2026-08-23T19:56:00.000Z", now), "stale");
  assert.equal(freshnessState("2026-08-23T19:50:00.000Z", now), "offline");
  assert.equal(freshnessState("not-a-time", now), "offline");
});

test("Sam's Club monitor is exposed through the protected Pi service controls", () => {
  assert.ok(DEVICE_SERVICES["pokebot-worker"].includes("samsclub-monitor"));
  assert.ok(ALLOWED_SERVICES.includes("samsclub-monitor"));
  assert.equal(SERVICE_LABELS["samsclub-monitor"], "Sam's Club monitor");
});

test("Walmart drop tracker is exposed through protected start and stop controls", () => {
  // walmart-rank-tracker was removed 2026-08-19 along with Docker; the unit no
  // longer exists on the Pi, so exposing a button for it would only ever fail.
  assert.ok(!ALLOWED_SERVICES.includes("walmart-rank-tracker"));
  assert.ok(DEVICE_SERVICES["pokebot-worker"].includes("walmart-monitor"));
  assert.ok(ALLOWED_SERVICES.includes("walmart-monitor"));
  assert.equal(SERVICE_LABELS["walmart-monitor"], "Walmart monitor");
  assert.ok(ALLOWED_SERVICES.includes("target-stock-observer-go-test"));
  assert.equal(
    SERVICE_LABELS["target-stock-observer-go-test"],
    "Target monitor (Go, shadow)"
  );
});

test("Pokemon Center queue detector is an independent protected Pi service", () => {
  assert.ok(DEVICE_SERVICES["pokebot-worker"].includes("pokemon-center-queue"));
  assert.ok(ALLOWED_SERVICES.includes("pokemon-center-queue"));
  assert.equal(
    SERVICE_LABELS["pokemon-center-queue"],
    "Pokémon Center queue detector",
  );
});

test("demo state exposes every dashboard collection", () => {
  for (const key of ["products", "drops", "proxies", "subscriptions", "snapshots", "health", "logs", "catalog"]) {
    assert.ok(Array.isArray(demoState[key]), `${key} should be an array`);
  }
});

test("normalizeDrop preserves its product image and Target inventory signal", () => {
  const drop = normalizeDrop({
    id: "d1",
    product_id: "p1",
    product_key: "123",
    retailer: "target",
    name: "Booster bundle",
    image: "https://example.com/booster.png",
    availability_status: "OUT_OF_STOCK",
    available_to_promise_quantity: "50000",
  });

  assert.equal(drop.product_id, "p1");
  assert.equal(drop.product_key, "123");
  assert.equal(drop.image, "https://example.com/booster.png");
  assert.equal(drop.availability_status, "OUT_OF_STOCK");
  assert.equal(drop.available_to_promise_quantity, 50000);
});

test("summarize includes latest monitor snapshot and history", () => {
  const state = summarize({
    products: [
      {
        id: "p1",
        retailer: "target",
        product_key: "123",
        name: "Box",
        active: true,
      },
    ],
    drops: [],
    proxies: [],
    subscriptions: [],
    snapshots: [
      {
        id: "s1",
        status: "ok",
        checks: 25,
        bytes_used: 12000,
        total_products: 1,
        active_contexts: 2,
        blocked_rate: 0.1,
        captured_at: "2026-06-29T08:00:00.000Z",
      },
    ],
    health: [
      {
        worker_name: "pokebot-worker",
        cpu_percent: 12.5,
        temp_c: 49.2,
        mem_percent: 44.1,
        disk_percent: 62.8,
        updated_at: "2026-06-29T08:00:00.000Z",
      },
    ],
    logs: [
      {
        worker_name: "pokebot-worker",
        level: "info",
        message: "Context warmed",
        created_at: "2026-06-29T08:00:00.000Z",
      },
    ],
  });

  assert.equal(state.summary.checks, 25);
  assert.equal(state.summary.bytesUsed, 12000);
  assert.equal(state.summary.activeContexts, 2);
  assert.equal(state.snapshots.length, 1);
  assert.equal(state.snapshots[0].blocked_rate, 0.1);
  assert.equal(state.summary.cpuPercent, 12.5);
  assert.equal(state.summary.tempC, 49.2);
  assert.equal(state.logs[0].message, "Context warmed");
});

test("worker health preserves bounded delivery and schedule evidence", () => {
  const row = normalizeHealth({
    worker_name: "pokebot-worker",
    watchlist_product_count: "24",
    watchlist_last_success_at: "2026-08-11T20:00:00.000Z",
    alert_outbox_pending: "2",
    last_drop_delivery_at: "2026-08-11T20:01:00.000Z",
    last_discord_delivery_at: "2026-08-11T20:01:01.000Z",
    last_discord_status: "confirmed",
    last_discord_message_id: "123456789",
    active_schedule_profile: "release:2026-08-14",
    schedule_next_transition_at: "2026-08-15T13:00:00.000Z",
  });

  assert.equal(row.watchlist_product_count, 24);
  assert.equal(row.alert_outbox_pending, 2);
  assert.equal(row.last_discord_status, "confirmed");
  assert.equal(row.active_schedule_profile, "release:2026-08-14");
});

test("normalizeCatalogEntry maps a target_catalog row to display shape", () => {
  const entry = normalizeCatalogEntry({
    id: "c1",
    product_key: "95267143",
    name: "Chaos Rising ETB",
    image: "https://img/etb.jpg",
    category: "Category · pokemon trading cards (direct-sold)",
    is_marketplace: false,
    last_seen_at: "2026-07-04T00:00:00.000Z",
    sort_order: 3,
    upc: "196214112568",
  });

  assert.deepEqual(entry, {
    id: "c1",
    product_key: "95267143",
    name: "Chaos Rising ETB",
    image: "https://img/etb.jpg",
    category: "Category · pokemon trading cards (direct-sold)",
    is_marketplace: false,
    last_seen_at: "2026-07-04T00:00:00.000Z",
    sort_order: 3,
    upc: "196214112568",
    listings: [],
    target_listing: null,
    walmart_listing: null,
  });
});

test("deriveAddedProductKeys returns only matching-retailer product keys", () => {
  const products = [
    { retailer: "target", product_key: "95267143" },
    { retailer: "walmart", product_key: "999" },
    { retailer: "target", product_key: "93803457" },
  ];

  const keys = deriveAddedProductKeys(products, "target");
  assert.deepEqual([...keys].sort(), ["93803457", "95267143"]);
});

test("summarize includes normalized catalog rows", () => {
  const state = summarize({
    products: [],
    drops: [],
    proxies: [],
    subscriptions: [],
    snapshots: [],
    health: [],
    logs: [],
    catalog: [
      {
        id: "c1",
        product_key: "111",
        name: "Card A",
        image: null,
        category: "cat",
        is_marketplace: false,
        last_seen_at: "2026-07-04T00:00:00.000Z",
      },
    ],
  });

  assert.equal(state.catalog.length, 1);
  assert.equal(state.catalog[0].product_key, "111");
});

test("ingest auth accepts bearer token and rejects missing token", () => {
  const request = {
    headers: new Headers({ authorization: "Bearer shared-secret" }),
  };

  assert.equal(isAuthorizedIngestRequest(request, "shared-secret"), true);
  assert.equal(
    isAuthorizedIngestRequest({ headers: new Headers() }, "shared-secret"),
    false,
  );
});

test("product ingest payload dedupes rows by retailer and product key", () => {
  const payload = normalizeProductPayload([
    { retailer: "target", product_key: "95120834", name: "First name" },
    { retailer: "target", product_key: "95120834", name: "Latest name" },
    { retailer: "target", product_key: "93803457", name: "Poster Collection" },
  ]);

  assert.equal(payload.length, 2);
  assert.deepEqual(
    payload.find((row) => row.product_key === "95120834"),
    {
      retailer: "target",
      product_key: "95120834",
      product_url: null,
      name: "Latest name",
      active: true,
    },
  );
});

test("drop ingest preserves a valid source event UUID", () => {
  const [row] = normalizeDropPayload({
    source_event_id: "11111111-1111-4111-8111-111111111111",
    product_key: "95163306",
  });

  assert.equal(
    row.source_event_id,
    "11111111-1111-4111-8111-111111111111",
  );
  assert.equal(row.retailer, "target");
  assert.equal(row.name, "95163306");
});

test("drop ingest rejects a malformed source event ID", () => {
  assert.throws(
    () =>
      normalizeDropPayload({
        source_event_id: "same-drop",
        product_key: "95163306",
      }),
    /Invalid source_event_id/,
  );
});

test("drop ingest rejects invalid quantities and batches over 100", () => {
  assert.throws(
    () =>
      normalizeDropPayload({
        source_event_id: "11111111-1111-4111-8111-111111111111",
        product_key: "95163306",
        available_to_promise_quantity: "many",
      }),
    /drop quantity must be numeric/,
  );
  assert.throws(
    () =>
      normalizeDropPayload(
        Array.from({ length: 101 }, (_, index) => ({
          source_event_id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
          product_key: String(95163306 + index),
        })),
      ),
    /maximum batch size is 100/,
  );
});

test("only a source-event uniqueness collision is an idempotent success", () => {
  assert.equal(
    isDuplicateSourceEventError(
      { code: "23505" },
      "11111111-1111-4111-8111-111111111111",
    ),
    true,
  );
  assert.equal(isDuplicateSourceEventError({ code: "23505" }, null), false);
  assert.equal(
    isDuplicateSourceEventError(
      { code: "42501" },
      "11111111-1111-4111-8111-111111111111",
    ),
    false,
  );
});

test("catalog ingest payload dedupes rows by product key and drops rows without one", () => {
  const payload = normalizeCatalogPayload([
    {
      product_key: "111",
      name: "First name",
      category: "cat",
      is_marketplace: false,
      image: "https://img/a.jpg",
      sort_order: 5,
    },
    {
      product_key: "111",
      name: "Latest name",
      category: "cat",
      is_marketplace: false,
      image: "https://img/a.jpg",
      sort_order: 9,
    },
    { name: "No key, dropped" },
  ]);

  assert.equal(payload.length, 1);
  assert.deepEqual(payload[0], {
    product_key: "111",
    name: "Latest name",
    category: "cat",
    is_marketplace: false,
    image: "https://img/a.jpg",
    sort_order: 9,
    upc: null,
    regular_price: null,
    current_price: null,
    price_checked_at: payload[0].price_checked_at,
  });
});

test("catalog ingest payload defaults sort_order to null when missing or invalid", () => {
  const payload = normalizeCatalogPayload([
    { product_key: "222", name: "No sort order given" },
  ]);

  assert.equal(payload[0].sort_order, null);
});

test("catalog ingest payload passes through upc when given", () => {
  const payload = normalizeCatalogPayload([
    { product_key: "333", name: "Has a UPC", upc: "196214112568" },
  ]);

  assert.equal(payload[0].upc, "196214112568");
});

test("catalog ingest payload normalizes Target prices", () => {
  const payload = normalizeCatalogPayload([
    {
      product_key: "444",
      name: "Priced item",
      regular_price: "49.99",
      current_price: 44.99,
    },
  ]);

  assert.equal(payload[0].regular_price, 49.99);
  assert.equal(payload[0].current_price, 44.99);
  assert.ok(payload[0].price_checked_at);
});

test("product URL helper supports Target TCINs and Walmart item URLs", () => {
  assert.equal(
    normalizeProductKey("target", "https://www.target.com/p/-/A-95120834"),
    "95120834",
  );
  assert.equal(
    buildProductUrl("target", "95120834"),
    "https://www.target.com/p/-/A-95120834",
  );
  assert.equal(
    normalizeProductKey(
      "walmart",
      "https://www.walmart.com/ip/Pokemon-TCG-Booster-Bundle/123456789?classType=REGULAR",
    ),
    "123456789",
  );
  assert.equal(
    buildProductUrl("walmart", "123456789"),
    "https://www.walmart.com/ip/123456789",
  );
});

test("product URL helper supports Sam's Club and Pokémon Center", () => {
  assert.equal(normalizeRetailer("Sam's Club"), "samsclub");
  assert.equal(
    normalizeProductKey("samsclub", "https://www.samsclub.com/ip/product-name/19170800669"),
    "19170800669",
  );
  assert.equal(buildProductUrl("samsclub", "19170800669"), "https://www.samsclub.com/ip/19170800669");
  assert.equal(normalizeRetailer("pokemoncenter"), "pokemon-center");
  assert.equal(normalizeProductKey("pokemon-center", "https://www.pokemoncenter.com/"), "site-queue");
  assert.equal(buildProductUrl("pokemon-center", "site-queue"), "https://www.pokemoncenter.com/");
  assert.equal(
    resolveProductUrl("pokemon-center", "https://www.pokemoncenter.com/product/123-456", "123-456"),
    "https://www.pokemoncenter.com/product/123-456",
  );
});

test("retailer filters count combined listings under each retailer", () => {
  const products = [
    { retailer: "target + walmart", target_url: "https://target", walmart_url: "https://walmart" },
    { retailer: "samsclub", product_url: "https://samsclub" },
    { retailer: "pokemon-center", product_url: "https://pokemoncenter" },
  ];
  assert.deepEqual(countProductsByRetailer(products), {
    all: 3,
    target: 1,
    walmart: 1,
    samsclub: 1,
    "pokemon-center": 1,
  });
  assert.equal(productMatchesRetailer(products[0], "walmart"), true);
  assert.equal(productMatchesRetailer(products[1], "target"), false);
});

test("products with monitoring on are sorted first without changing group order", () => {
  const products = [
    { id: "off-1", active: false },
    { id: "on-1", active: true },
    { id: "off-2", active: false },
    { id: "on-2", active: true },
  ];

  assert.deepEqual(
    sortProductsByMonitoringStatus(products).map((product) => product.id),
    ["on-1", "on-2", "off-1", "off-2"],
  );
  assert.deepEqual(products.map((product) => product.id), [
    "off-1",
    "on-1",
    "off-2",
    "on-2",
  ]);
});

test("dashboard timestamps render in Pacific time", () => {
  assert.equal(
    formatDashboardTime("2026-06-29T17:21:58.000Z"),
    "Jun 29, 2026, 10:21:58 AM PDT",
  );
});

test("matchSet finds a specific sub-set before its generic parent series", () => {
  assert.equal(
    matchSet(
      "Pokémon Trading Card Game: Mega Evolution Chaos Rising Elite Trainer Box",
    ),
    "Mega Evolution Chaos Rising",
  );
  assert.equal(
    matchSet("Pokémon Trading Card Game: Mega Evolution Booster Bundle"),
    "Mega Evolution",
  );
  assert.equal(
    matchSet(
      "Pokémon Trading Card Game: Scarlet & Violet—Prismatic Evolutions Poster Collection",
    ),
    "Prismatic Evolutions",
  );
});

test("matchSet returns null for names with no known set", () => {
  assert.equal(matchSet("Ultra Pro 9 Pocket Pro-Binder"), null);
});
