import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

print("Python", sys.version)
import pokebot_drop_pusher
print("import OK")
hit = {"item_id":"t","name":"Test","price":4.99,"price_string":"$4.99"}
pokebot_drop_pusher.push_to_pokebot(hit, "url", "key", dry_run=True)
print("done")
