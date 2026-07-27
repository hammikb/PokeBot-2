# Test Layout

- `main/` mirrors the corresponding domain under `src/main/`.
- `fixtures/retailers/` contains sanitized retailer page-state fixtures.
- `main/automation/flows/` covers checkout-flow behavior.
- `main/monitor/` covers monitoring and durable Supabase delivery.
- `main/tasks/` covers orchestration and irreversible-submit safety.

New tests should be placed beside the domain they verify. Standalone Pi script
checks belong in [`scripts/tests/`](../scripts/tests/), not in this Vitest tree.
