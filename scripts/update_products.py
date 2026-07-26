"""Add real Pokemon product IDs to walmart_restock_scanner.py"""
import re

path = "walmart_restock_scanner.py"
text = open(path).read()

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
open(path, "w").write(text)
print("Products updated!")
print(open(path).read()[:500])