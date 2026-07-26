import sys
print("Python", sys.version)
import pokebot_drop_pusher
print("import OK")
hit = {"item_id":"t","name":"Test","price":4.99,"price_string":"$4.99"}
pokebot_drop_pusher.push_to_pokebot(hit, "url", "key", dry_run=True)
print("done")