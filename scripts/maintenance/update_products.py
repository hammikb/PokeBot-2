"""Maintenance helper for updating the checked-in Walmart scanner product examples."""
import re
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "walmart_restock_scanner.py"
text = path.read_text(encoding="utf-8")

new_products = """PRODUCTS: list[dict] = [
    {"item_id": "110256827", "name": "Surging Sparks ETB"},
    {"item_id": "2920743936", "name": "Paldea Evolved Booster Bundle"},
    {"item_id": "5179418611", "name": "Scarlet Violet 151 Booster Bundle"},
]"""

text = re.sub(
    r'PRODUCTS: list\[dict\] = \[\s*\n\s*# .*?\n(?:\s*# .*?\n)*\s*\]',
    new_products,
    text,
    flags=re.DOTALL
)
path.write_text(text, encoding="utf-8")
print("Products updated!")
print(path.read_text(encoding="utf-8")[:500])
