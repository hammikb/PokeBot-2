"""Pure state logic for the Pokemon Center queue detector."""

from dataclasses import dataclass
from urllib.parse import urlsplit, urlparse


QUEUE_MARKERS = (
    "virtual queue to enter pokémon center",
    "virtual queue to enter pokemon center",
    "estimated wait time",
    "keep this window open",
    "do not refresh the page",
)
QUEUE_URL_MARKERS = ("queue", "waitingroom", "queue-it")
BLOCKED_MARKERS = (
    "_incapsula_resource",
    "captcha-delivery.com",
    "verifying the device",
    "verification failed",
    "access is temporarily restricted",
    "unusual activity from your device or network",
    "automated (bot) activity",
)
STOREFRONT_MARKERS = (
    "skip to content",
    "search pikachu",
    "my cart",
    "new releases",
    "trading card game",
)


@dataclass(frozen=True)
class Observation:
    kind: str
    status: int | None = None
    url: str = ""
    detail: str = ""


class QueueTransitionTracker:
    def __init__(self, initial_open=False, close_confirmations=2):
        self.queue_open = bool(initial_open)
        self.close_confirmations = max(1, int(close_confirmations))
        self._storefront_reads = 0

    def observe(self, observation):
        if observation.kind == "queue":
            self._storefront_reads = 0
            if not self.queue_open:
                self.queue_open = True
                return "opened"
            return None
        if observation.kind != "storefront":
            return None
        if not self.queue_open:
            self._storefront_reads = 0
            return None
        self._storefront_reads += 1
        if self._storefront_reads < self.close_confirmations:
            return None
        self.queue_open = False
        self._storefront_reads = 0
        return "closed"


class ChallengeBackoff:
    """Bounded process-wide pause for repeated site security challenges."""

    def __init__(self, threshold=3, base_seconds=60, max_seconds=900):
        self.threshold = max(1, int(threshold))
        self.base_seconds = max(1, int(base_seconds))
        self.max_seconds = max(self.base_seconds, int(max_seconds))
        self.consecutive_challenges = 0
        self.pause_until = 0.0

    def record(self, observation_kind, now=0):
        now = float(now)
        if observation_kind == "blocked":
            self.consecutive_challenges += 1
            if self.consecutive_challenges < self.threshold:
                return 0
            exponent = self.consecutive_challenges - self.threshold
            pause = min(self.max_seconds, self.base_seconds * (2**exponent))
            self.pause_until = max(self.pause_until, now + pause)
            return int(round(self.pause_until - now))
        if observation_kind in ("storefront", "queue"):
            self.consecutive_challenges = 0
            self.pause_until = 0.0
        return 0

    def remaining(self, now=0):
        return max(0, int(round(self.pause_until - float(now))))


class ProxyHealthPool:
    def __init__(self, proxies, failure_threshold=2, cooldown_seconds=1800, start_index=0):
        self.proxies = list(proxies)
        if not self.proxies:
            raise RuntimeError("At least one proxy is required")
        self.failure_threshold = max(1, int(failure_threshold))
        self.cooldown_seconds = max(1, int(cooldown_seconds))
        self.index = int(start_index) % len(self.proxies)
        self._health = [
            {"failures": 0, "quarantined_until": 0.0, "last_success": 0.0}
            for _ in self.proxies
        ]

    def current(self):
        return self.index, self.proxies[self.index]

    def label(self, index=None):
        selected = self.index if index is None else index
        parsed = urlsplit(self.proxies[selected])
        host = parsed.hostname or "proxy"
        port = f":{parsed.port}" if parsed.port else ""
        return f"proxy[{selected + 1:02d}] {host}{port}"

    def state(self, index=None, now=0):
        selected = self.index if index is None else index
        health = self._health[selected]
        return "quarantined" if health["quarantined_until"] > now else "eligible"

    def failure_count(self, index=None):
        selected = self.index if index is None else index
        return self._health[selected]["failures"]

    def record_success(self, index=None, now=0):
        selected = self.index if index is None else index
        health = self._health[selected]
        health["failures"] = 0
        health["quarantined_until"] = 0.0
        health["last_success"] = float(now)

    def record_failure(self, index=None, now=0):
        selected = self.index if index is None else index
        health = self._health[selected]
        health["failures"] += 1
        if health["failures"] < self.failure_threshold:
            return False
        health["failures"] = 0
        health["quarantined_until"] = float(now) + self.cooldown_seconds
        return True

    def rotate(self, now=0):
        eligible = [
            index
            for index, health in enumerate(self._health)
            if health["quarantined_until"] <= now
        ]
        alternatives = [index for index in eligible if index != self.index]
        candidates = alternatives or eligible
        if not candidates:
            raise RuntimeError("No eligible proxy is available; direct connection is disabled")
        self.index = max(candidates, key=lambda index: self._health[index]["last_success"])
        return self.current()


def classify_observation(status, url, frame_texts):
    """Classify bounded browser evidence without retaining page content."""
    normalized_url = str(url or "").lower()
    text = "\n".join(str(item or "") for item in (frame_texts or ())).lower()

    challenge_detected = status in (403, 429) or any(
        marker in normalized_url or marker in text for marker in BLOCKED_MARKERS
    )
    if challenge_detected:
        detail = "site security challenge"
        if status not in (403, 429) and status is not None:
            detail += f" (HTTP {status})"
        return Observation("blocked", status, str(url or ""), detail)

    queue_markers = sum(marker in text for marker in QUEUE_MARKERS)
    queue_url = any(marker in normalized_url for marker in QUEUE_URL_MARKERS)
    if queue_markers >= 2 or (queue_url and queue_markers >= 1):
        return Observation("queue", status, str(url or ""), "explicit queue evidence")

    storefront_markers = sum(marker in text for marker in STOREFRONT_MARKERS)
    if status is not None and 200 <= status < 400 and storefront_markers >= 2:
        return Observation("storefront", status, str(url or ""), "valid storefront")

    if status is not None and not 200 <= status < 400:
        return Observation("error", status, str(url or ""), f"unexpected HTTP {status}")
    if not text.strip():
        return Observation("error", status, str(url or ""), "empty browser document")
    return Observation("error", status, str(url or ""), "unrecognized browser document")


# Request route boundaries. The detector needs first-party scripts to render
# the storefront/queue text, but does not need static media or third-party
# telemetry. Blocking those requests reduces proxy usage without returning a
# half-hydrated application shell.
# Some drivers report an empty resource type for third-party beacons; the URL
# allow-list below is the second layer of defense. Root domains are matched by
# safe subdomain suffix, so queue/CDN subdomains continue to work.
ALLOWED_REQUEST_HOSTS = frozenset(
    {
        "pokemoncenter.com",
        "queue-it.net",
        "queue-it.com",
    }
)
ALLOWED_RESOURCE_TYPES = frozenset({"document", "script", "xhr", "fetch"})


def _host_of(url):
    try:
        return (urlparse(str(url or "")).hostname or "").lower()
    except ValueError:
        return ""


def _allowed_host(host):
    return any(host == root or host.endswith(f".{root}") for root in ALLOWED_REQUEST_HOSTS)


def route_request_decision(resource_type, url):
    """Return ``"abort"`` or ``"continue"`` for a pending request.

    Pure decision logic so it can be unit-tested without a browser. The policy:
    abort static/unsupported resource types and any cross-origin (third-party)
    request. First-party scripts remain available for client-side rendering.
    """
    resource_type = (resource_type or "").lower()
    if resource_type and resource_type not in ALLOWED_RESOURCE_TYPES:
        return "abort"
    host = _host_of(url)
    if host and not _allowed_host(host):
        return "abort"
    return "continue"
