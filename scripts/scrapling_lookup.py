import json
import re
import sys
from html import unescape
from urllib.parse import urlparse


BLOCK_PATTERNS = [
    re.compile(pattern, re.I)
    for pattern in (
        "captcha",
        "robot or human",
        "verify you are",
        "access denied",
        "sorry, this request",
    )
]


def main():
    if len(sys.argv) < 2:
        emit_error("product URL is required")
        return 2

    product_url = sys.argv[1]
    try:
        from scrapling.fetchers import Fetcher
    except Exception as exc:
        emit_error(f"Scrapling is not installed: {exc}", code="missing_dependency")
        return 3

    try:
        page = Fetcher.get(product_url)
        html = get_html(page)
        text = collapse_text(first_text(page, ["body::text"]) or visible_text(html))
        if is_blocked(html, text):
            emit_error("Retailer page is showing a CAPTCHA or robot check", code="blocked", status=403)
            return 4

        result = normalize_product(product_url, page, html, text)
        if not result.get("availability"):
            dynamic_availability = lookup_dynamic_availability(product_url)
            if dynamic_availability:
                result["availability"] = dynamic_availability
        print(json.dumps({"ok": True, "product": result}, ensure_ascii=False))
        return 0
    except Exception as exc:
        emit_error(str(exc))
        return 1


def normalize_product(product_url, page, html, text):
    retailer = detect_retailer(product_url)
    if not retailer:
        raise ValueError("Scrapling lookup supports Target and Walmart URLs only")

    structured = find_structured_product(page, html)
    next_product = find_next_product(html)
    product_data = structured or next_product or {}

    title = clean_title(
        first_value(
            product_data.get("name"),
            first_text(page, ["h1::text"]),
            attr(page, 'meta[property="og:title"]::attr(content)'),
            first_text(page, ["title::text"]),
        ),
        retailer,
    )
    image = first_value(
        first_from_maybe_list(product_data.get("image")),
        nested(product_data, "imageInfo", "thumbnailUrl"),
        attr(page, 'meta[property="og:image"]::attr(content)'),
    )
    price = parse_price(
        first_value(
            nested(product_data, "offers", "price"),
            nested(product_data, "priceInfo", "currentPrice", "price"),
            first_text(page, ['[data-test*="price"]::text', '[class*="price"]::text']),
        )
    )
    formatted_price = first_value(
        nested(product_data, "priceInfo", "currentPrice", "priceString"),
        f"${price:.2f}" if price is not None else None,
    )
    canonical = attr(page, 'link[rel="canonical"]::attr(href)') or product_url

    return {
        "retailer": retailer,
        "productUrl": product_url,
        "canonicalUrl": canonical,
        "productName": title or f"{'Target' if retailer == 'target' else 'Walmart'} Product",
        "price": price,
        "formattedPrice": formatted_price,
        "imageUrl": image,
        "images": [image] if image else [],
        "availability": normalize_availability(
            first_value(
                nested(product_data, "offers", "availability"),
                product_data.get("availabilityStatus"),
                nested(product_data, "fulfillment", "shipping_options", "availability_status"),
            )
        ),
        "brand": normalize_brand(product_data.get("brand")),
        "category": first_value(
            nested(product_data, "category", "path", 0, "name"),
            nested(product_data, "categoryPath", 0, "name"),
        ),
        "bullets": [attr(page, 'meta[name="description"]::attr(content)')]
        if attr(page, 'meta[name="description"]::attr(content)')
        else [],
        "source": "scrapling",
    }


def find_structured_product(page, html):
    scripts = all_text(page, ['script[type="application/ld+json"]::text'])
    if not scripts:
        scripts = re.findall(
            r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
            html,
            flags=re.I | re.S,
        )
    for raw in scripts:
        found = find_product_json(safe_json(unescape(raw).strip()))
        if found:
            return found
    return None


def find_product_json(value):
    if isinstance(value, list):
        for item in value:
            found = find_product_json(item)
            if found:
                return found
        return None
    if not isinstance(value, dict):
        return None
    if str(value.get("@type", "")).lower() == "product":
        return value
    if "@graph" in value:
        return find_product_json(value["@graph"])
    return None


def find_next_product(html):
    match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.I | re.S)
    if not match:
        return None
    data = safe_json(unescape(match.group(1)).strip())
    return first_value(
        nested(data, "props", "pageProps", "initialData", "data", "product"),
        nested(data, "props", "pageProps", "initialData", "product"),
        nested(data, "props", "pageProps", "initialData", "item"),
    )


def get_html(page):
    for name in ("html_content", "html", "body", "text"):
        value = getattr(page, name, None)
        if callable(value):
            try:
                value = value()
            except TypeError:
                value = None
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="ignore")
        if isinstance(value, str):
            return value
    return str(page)


def lookup_dynamic_availability(product_url):
    try:
        from scrapling.fetchers import DynamicFetcher

        page = DynamicFetcher.fetch(
            product_url,
            headless=True,
            wait=5000,
            network_idle=True,
            timeout=45000,
        )
        html = get_html(page)
        text = collapse_text(visible_text(html))
        if is_blocked(html, text):
            return None
        return normalize_availability(f"{html}\n{text}")
    except Exception:
        return None


def first_text(page, selectors):
    values = all_text(page, selectors)
    return values[0] if values else None


def all_text(page, selectors):
    for selector in selectors:
        try:
            selected = page.css(selector)
            values = selector_values(selected)
            values = [collapse_text(value) for value in values if collapse_text(value)]
            if values:
                return values
        except Exception:
            continue
    return []


def attr(page, selector):
    return first_text(page, [selector])


def selector_values(selected):
    if selected is None:
        return []
    for method_name in ("getall", "extract"):
        method = getattr(selected, method_name, None)
        if callable(method):
            value = method()
            return value if isinstance(value, list) else [value]
    method = getattr(selected, "get", None)
    if callable(method):
        return [method()]
    if isinstance(selected, list):
        return [str(item) for item in selected]
    return [str(selected)]


def detect_retailer(product_url):
    hostname = urlparse(product_url).hostname or ""
    if "target.com" in hostname:
        return "target"
    if "walmart.com" in hostname:
        return "walmart"
    return None


def is_blocked(html, text):
    title = first_value(
        re.search(r"<title[^>]*>(.*?)</title>", html or "", re.I | re.S).group(1)
        if re.search(r"<title[^>]*>(.*?)</title>", html or "", re.I | re.S)
        else None,
        "",
    )
    combined = f"{title}\n{text[:4000]}"
    return any(pattern.search(combined) for pattern in BLOCK_PATTERNS)


def clean_title(value, retailer):
    value = collapse_text(value or "")
    if retailer == "target":
        value = re.sub(r"\s*:\s*Target\s*$", "", value, flags=re.I)
    if retailer == "walmart":
        value = re.sub(r"\s*-\s*Walmart\.com\s*$", "", value, flags=re.I)
    return value


def parse_price(value):
    if isinstance(value, (int, float)):
        return float(value)
    match = re.search(r"\$?\s*(\d+(?:\.\d{2})?)", str(value or ""))
    return float(match.group(1)) if match else None


def normalize_availability(value):
    text = str(value or "")
    if re.search(r"OutOfStock|out of stock|sold out|currently unavailable", text, re.I):
        return "OUT_OF_STOCK"
    if re.search(r"InStock|in stock|add to cart|sign in to buy now", text, re.I):
        return "IN_STOCK"
    return None


def normalize_brand(value):
    if isinstance(value, dict):
        return value.get("name")
    return value


def first_from_maybe_list(value):
    if isinstance(value, list):
        return next((item for item in value if item), None)
    return value


def first_value(*values):
    for value in values:
        if value is not None and value != "":
            return value
    return None


def nested(value, *keys):
    current = value
    for key in keys:
        if isinstance(current, dict):
            current = current.get(key)
        elif isinstance(current, list) and isinstance(key, int) and key < len(current):
            current = current[key]
        else:
            return None
    return current


def safe_json(value):
    if not value:
        return None
    try:
        return json.loads(value)
    except Exception:
        return None


def strip_tags(value):
    return re.sub(r"<[^>]+>", " ", value or "")


def visible_text(value):
    without_scripts = re.sub(
        r"<(script|style|noscript|template)[^>]*>.*?</\1>",
        " ",
        value or "",
        flags=re.I | re.S,
    )
    return strip_tags(without_scripts)


def collapse_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def emit_error(message, code="lookup_failed", status=None):
    payload = {"ok": False, "error": message, "code": code}
    if status:
        payload["status"] = status
    print(json.dumps(payload), file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
