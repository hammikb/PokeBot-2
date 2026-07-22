#!/usr/bin/env python3
"""One-time fail-closed proxy patch for the Pi's Sam's Club monitor."""

from pathlib import Path
import sys


path = Path(sys.argv[1] if len(sys.argv) > 1 else "SamsClubMonitor.py")
text = path.read_text(encoding="utf-8")

replacements = [
    (
        "import signal\nfrom dataclasses import dataclass",
        "import signal\nimport time\nfrom dataclasses import dataclass",
    ),
    (
        'ONE_SHOT_URL = os.getenv("SAMSCLUB_MONITOR_URL", "").strip()\n',
        'ONE_SHOT_URL = os.getenv("SAMSCLUB_MONITOR_URL", "").strip()\n'
        'PROXY_FILE = Path(\n'
        '    os.getenv("SAMSCLUB_PROXY_FILE", "/home/hammikb/api-monitor-python/proxies.txt")\n'
        ')\n',
    ),
    (
        "    product_url: str\n\n\ndef extract_item_id",
        "    product_url: str\n\n\n"
        "def load_proxies() -> list[str]:\n"
        "    proxies: list[str] = []\n"
        "    for raw in PROXY_FILE.read_text(encoding=\"utf-8\").splitlines():\n"
        "        value = raw.strip()\n"
        "        if not value or value.startswith(\"#\"):\n"
        "            continue\n"
        "        if \"://\" not in value:\n"
        "            value = f\"http://{value}\"\n"
        "        proxies.append(value)\n"
        "    if not proxies:\n"
        "        raise RuntimeError(\n"
        "            f\"No proxies loaded from {PROXY_FILE}; refusing direct Sam's Club traffic\"\n"
        "        )\n"
        "    return proxies\n\n\n"
        "def extract_item_id",
    ),
    (
        "        self._load_state()\n"
        "        self.client = httpx.AsyncClient(\n"
        "            headers=HEADERS,\n"
        "            follow_redirects=True,\n"
        "            timeout=httpx.Timeout(20.0),\n"
        "            trust_env=False,\n"
        "        )\n",
        "        self._load_state()\n"
        "        self.proxies = load_proxies()\n"
        "        self.proxy_index = int(time.time()) % len(self.proxies)\n"
        "        self.control_client = httpx.AsyncClient(\n"
        "            headers=HEADERS,\n"
        "            follow_redirects=True,\n"
        "            timeout=httpx.Timeout(20.0),\n"
        "            trust_env=False,\n"
        "        )\n"
        "        self.retail_client = self._new_retail_client()\n\n"
        "    def _new_retail_client(self) -> httpx.AsyncClient:\n"
        "        return httpx.AsyncClient(\n"
        "            headers=HEADERS,\n"
        "            follow_redirects=True,\n"
        "            timeout=httpx.Timeout(20.0),\n"
        "            trust_env=False,\n"
        "            proxy=self.proxies[self.proxy_index],\n"
        "        )\n\n"
        "    async def _rotate_proxy(self) -> None:\n"
        "        await self.retail_client.aclose()\n"
        "        self.proxy_index = (self.proxy_index + 1) % len(self.proxies)\n"
        "        self.retail_client = self._new_retail_client()\n",
    ),
    ("response = await self.client.get(\n            WATCHLIST_URL", "response = await self.control_client.get(\n            WATCHLIST_URL"),
    ("response = await self.client.get(item.product_url, headers=headers)", "response = await self.retail_client.get(item.product_url, headers=headers)"),
    ("        except Exception as exc:\n            self.backoff_until[item.product_key]", "        except Exception as exc:\n            await self._rotate_proxy()\n            self.backoff_until[item.product_key]"),
    ("response = await self.client.post(\n            INGEST_URL", "response = await self.control_client.post(\n            INGEST_URL"),
    ("await self.client.post(\n                    DISCORD_WEBHOOK_URL", "await self.control_client.post(\n                    DISCORD_WEBHOOK_URL"),
    ("        await self.client.aclose()", "        await self.retail_client.aclose()\n        await self.control_client.aclose()"),
    (
        '        f"challenge_backoff={CHALLENGE_BACKOFF:g}s, direct_connection=true",',
        '        f"challenge_backoff={CHALLENGE_BACKOFF:g}s, proxy_required=true, "\n'
        '        f"proxies={len(monitor.proxies)}",',
    ),
]

for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match, found {count}: {old[:80]!r}")
    text = text.replace(old, new, 1)

path.write_text(text, encoding="utf-8")
print(f"Patched {path} for proxy-only Sam's Club retailer traffic")
