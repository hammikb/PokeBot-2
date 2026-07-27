"""Test the PokeBot drop pusher with a dry-run. Run on the Pi."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pokebot_drop_pusher import push_to_pokebot

hit = {
    "item_id": "test123",
    "name": "Test Pokemon Booster Bundle",
    "price": 4.99,
    "price_string": "$4.99",
}

print("Import OK — testing dry-run push...")
push_to_pokebot(hit, "https://supabase.example.com", "fake-key", dry_run=True)
print("Dry-run passed!")
