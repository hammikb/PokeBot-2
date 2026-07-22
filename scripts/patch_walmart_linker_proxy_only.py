#!/usr/bin/env python3
"""One-time fail-closed proxy patch for the Pi's Walmart link finder."""

from pathlib import Path
import sys


path = Path(sys.argv[1] if len(sys.argv) > 1 else "walmart_link_finder.py")
text = path.read_text(encoding="utf-8")
old = "PROXIES = load_proxies()\n\nclass WalmartBrowser:"
new = (
    "PROXIES = load_proxies()\n"
    "if not PROXIES:\n"
    "    raise RuntimeError(f'No proxies loaded from {PROXY_FILE}; refusing direct Walmart traffic')\n\n"
    "class WalmartBrowser:"
)
count = text.count(old)
if count != 1:
    raise RuntimeError(f"Expected exactly one proxy initialization block, found {count}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print(f"Patched {path} for proxy-only Walmart traffic")
