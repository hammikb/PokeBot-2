# Scrapling Catalog Lookup

PokeBot can optionally use Scrapling as the first catalog lookup layer for Target and Walmart product URLs.

Scrapling is only used for product metadata:

- Product title
- Current price text
- Main image
- Brand/category when available
- Availability text when available
- Structured page data such as JSON-LD or `__NEXT_DATA__`

It is not used for account login, checkout, CAPTCHA solving, or bypassing retailer protections.

## Install

Use a Python environment with Python 3.10 or newer.

```powershell
python -m pip install "scrapling[fetchers]" curl_cffi browserforge
python -m playwright install chromium
```

Or through npm:

```powershell
npm run scrapling:install
```

## Test One URL

```powershell
npm run scrapling:lookup -- "https://www.target.com/p/guppy/A-95225595"
```

The command prints JSON. A successful response includes:

```json
{
  "ok": true,
  "product": {
    "source": "scrapling"
  }
}
```

If Scrapling is not installed or the retailer returns a block/challenge page, the app falls back to the existing lookup stack where safe.

## Lookup Order

1. Scrapling static fetch and parser
2. Scrapling dynamic render for availability when static data is unclear
3. Retailer-specific API/page fallback
4. Minimal blocked catalog item when the retailer shows a challenge page
