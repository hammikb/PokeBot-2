"""Durable Target alert state, schedule decisions, and stable batch identities."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone, tzinfo
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from zoneinfo import ZoneInfo


STATE_VERSION = 2
MIN_INTERVAL_SECONDS = 15
MAX_INTERVAL_SECONDS = 3600
_CLOCK = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


class CorruptAlertStateError(RuntimeError):
    """Raised when existing state cannot be trusted or safely replaced."""


@dataclass(frozen=True)
class PendingAlert:
    source_event_id: str
    tcin: str
    payload: dict[str, Any]
    destinations: dict[str, dict[str, Any]]
    created_at: str


def _utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _destination_state() -> dict[str, Any]:
    return {
        "status": "pending",
        "attempts": 0,
        "last_attempt_at": None,
        "last_error": None,
        "confirmed_at": None,
        "message_id": None,
    }


class AtomicAlertState:
    """Persist transition intent before delivery and reuse it after restarts."""

    def __init__(self, path: str | os.PathLike[str], destinations: Iterable[str] = ("cloud",)):
        self.path = Path(path)
        self.destinations = tuple(dict.fromkeys(str(item) for item in destinations if item))
        if "cloud" not in self.destinations:
            raise ValueError("cloud must be a configured destination")
        self._lock = threading.RLock()
        self._data = self._load()

    @property
    def in_stock(self) -> set[str]:
        with self._lock:
            return set(self._data["in_stock"])

    def pending(self) -> list[PendingAlert]:
        with self._lock:
            return [
                PendingAlert(
                    source_event_id=row["source_event_id"],
                    tcin=row["tcin"],
                    payload=dict(row.get("payload") or {}),
                    destinations={key: dict(value) for key, value in row["destinations"].items()},
                    created_at=row["created_at"],
                )
                for row in self._data["outbox"]
            ]

    def ensure_transition(self, tcin: str, payload: Mapping[str, Any]) -> PendingAlert | None:
        normalized_tcin = str(tcin).strip()
        if not normalized_tcin:
            raise ValueError("tcin is required")
        with self._lock:
            for row in self._data["outbox"]:
                if row["tcin"] == normalized_tcin:
                    return self._as_pending(row)
            if normalized_tcin in self._data["in_stock"]:
                return None

            row = {
                "source_event_id": str(uuid.uuid4()),
                "tcin": normalized_tcin,
                "payload": dict(payload),
                "created_at": _utc_now(),
                "destinations": {name: _destination_state() for name in self.destinations},
            }
            self._data["outbox"].append(row)
            self._write()
            return self._as_pending(row)

    def mark_attempt(self, source_event_id: str, destination: str, error: Any = None) -> None:
        with self._lock:
            row = self._find(source_event_id)
            state = self._destination(row, destination)
            state["attempts"] = int(state.get("attempts") or 0) + 1
            state["status"] = "retrying" if error is not None else "pending"
            state["last_attempt_at"] = _utc_now()
            state["last_error"] = None if error is None else str(error)[:500]
            self._write()

    def mark_destination(
        self,
        source_event_id: str,
        destination: str,
        *,
        status: int | str,
        message_id: str | None = None,
    ) -> None:
        with self._lock:
            row = self._find(source_event_id)
            state = self._destination(row, destination)
            confirmed = (
                isinstance(status, int) and 200 <= status < 300
            ) or str(status).lower() in {"confirmed", "disabled"}
            state["status"] = "disabled" if str(status).lower() == "disabled" else (
                "confirmed" if confirmed else str(status)[:100]
            )
            state["last_attempt_at"] = _utc_now()
            state["last_error"] = None
            if message_id is not None:
                state["message_id"] = str(message_id)[:100]
            if confirmed:
                state["confirmed_at"] = _utc_now()

            self._data["last_results"][destination] = {
                "status": state["status"],
                "confirmed_at": state["confirmed_at"],
                "message_id": state["message_id"],
            }
            if destination == "cloud" and confirmed:
                self._data["in_stock"] = sorted(set(self._data["in_stock"]) | {row["tcin"]})
            if all(value.get("confirmed_at") for value in row["destinations"].values()):
                self._data["outbox"] = [
                    candidate
                    for candidate in self._data["outbox"]
                    if candidate["source_event_id"] != source_event_id
                ]
            self._write()

    def clear_in_stock(self, tcin: str) -> None:
        with self._lock:
            normalized = str(tcin).strip()
            self._data["in_stock"] = [item for item in self._data["in_stock"] if item != normalized]
            self._write()

    def delivery_health(self) -> dict[str, Any]:
        with self._lock:
            cloud = self._data["last_results"].get("cloud") or {}
            discord = self._data["last_results"].get("discord") or {}
            return {
                "alert_outbox_pending": len(self._data["outbox"]),
                "last_drop_delivery_at": cloud.get("confirmed_at"),
                "last_discord_delivery_at": discord.get("confirmed_at"),
                "last_discord_status": discord.get("status"),
                "last_discord_message_id": discord.get("message_id"),
            }

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"version": STATE_VERSION, "in_stock": [], "outbox": [], "last_results": {}}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ValueError("state root is not an object")
            in_stock = sorted({str(item) for item in raw.get("in_stock", []) if str(item).strip()})
            outbox = raw.get("outbox", [])
            if not isinstance(outbox, list):
                raise ValueError("outbox is not a list")
            normalized_outbox = []
            for row in outbox:
                if not isinstance(row, dict) or not row.get("source_event_id") or not row.get("tcin"):
                    raise ValueError("invalid outbox row")
                destinations = row.get("destinations") or {}
                for name in self.destinations:
                    destinations.setdefault(name, _destination_state())
                normalized_outbox.append({
                    "source_event_id": str(row["source_event_id"]),
                    "tcin": str(row["tcin"]),
                    "payload": dict(row.get("payload") or {}),
                    "created_at": str(row.get("created_at") or _utc_now()),
                    "destinations": destinations,
                })
            return {
                "version": STATE_VERSION,
                "in_stock": in_stock,
                "outbox": normalized_outbox,
                "last_results": dict(raw.get("last_results") or {}),
            }
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
            raise CorruptAlertStateError(f"Refusing to replace corrupt alert state: {error}") from error

    def _write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary_path = Path(handle.name)
                json.dump(self._data, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.path)
        finally:
            if temporary_path is not None and temporary_path.exists():
                temporary_path.unlink()

    def _find(self, source_event_id: str) -> dict[str, Any]:
        for row in self._data["outbox"]:
            if row["source_event_id"] == source_event_id:
                return row
        raise KeyError(f"unknown source_event_id: {source_event_id}")

    @staticmethod
    def _destination(row: dict[str, Any], destination: str) -> dict[str, Any]:
        try:
            return row["destinations"][destination]
        except KeyError as error:
            raise KeyError(f"unconfigured destination: {destination}") from error

    @staticmethod
    def _as_pending(row: dict[str, Any]) -> PendingAlert:
        return PendingAlert(
            source_event_id=row["source_event_id"],
            tcin=row["tcin"],
            payload=dict(row["payload"]),
            destinations={key: dict(value) for key, value in row["destinations"].items()},
            created_at=row["created_at"],
        )


@dataclass(frozen=True)
class ScheduleWindow:
    start: time
    end: time
    interval: int


@dataclass(frozen=True)
class ReleaseOverride:
    date: date
    window: ScheduleWindow


@dataclass(frozen=True)
class ScheduleConfig:
    default_interval: int
    windows: tuple[ScheduleWindow, ...]
    release_overrides: tuple[ReleaseOverride, ...]


@dataclass(frozen=True)
class ScheduleDecision:
    interval: int
    profile: str
    next_transition_at: datetime | None


def _zone(zone: str | tzinfo) -> tzinfo:
    return zone if isinstance(zone, tzinfo) else ZoneInfo(zone)


def _interval(value: Any) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("schedule interval must be an integer") from error
    if normalized < MIN_INTERVAL_SECONDS:
        raise ValueError("schedule interval must be at least 15 seconds")
    if normalized > MAX_INTERVAL_SECONDS:
        raise ValueError(f"schedule interval must be at most {MAX_INTERVAL_SECONDS} seconds")
    return normalized


def _clock(value: Any) -> time:
    text = str(value or "")
    if not _CLOCK.fullmatch(text):
        raise ValueError("schedule clocks must use HH:MM")
    return time.fromisoformat(text)


def _window(raw: Mapping[str, Any]) -> ScheduleWindow:
    return ScheduleWindow(
        start=_clock(raw.get("start")),
        end=_clock(raw.get("end")),
        interval=_interval(raw.get("interval")),
    )


def parse_schedule_config(raw: Mapping[str, Any], now: datetime, zone: str | tzinfo) -> ScheduleConfig:
    if not isinstance(raw, Mapping):
        raise ValueError("schedule must be an object")
    tz = _zone(zone)
    if now.tzinfo is None:
        now = now.replace(tzinfo=tz)
    windows = tuple(_window(item) for item in raw.get("windows", []))
    overrides = []
    seen_dates = set()
    for item in raw.get("release_overrides", []):
        try:
            override_date = date.fromisoformat(str(item.get("date")))
        except (TypeError, ValueError) as error:
            raise ValueError("release override dates must use YYYY-MM-DD") from error
        if override_date in seen_dates:
            raise ValueError("release override dates must be unique")
        seen_dates.add(override_date)
        overrides.append(ReleaseOverride(override_date, _window(item)))
    return ScheduleConfig(
        default_interval=_interval(raw.get("default_interval", 300)),
        windows=windows,
        release_overrides=tuple(sorted(overrides, key=lambda item: item.date)),
    )


def _bounds(anchor: date, window: ScheduleWindow, zone: tzinfo) -> tuple[datetime, datetime]:
    start_at = datetime.combine(anchor, window.start, tzinfo=zone)
    end_date = anchor if window.end > window.start else anchor + timedelta(days=1)
    end_at = datetime.combine(end_date, window.end, tzinfo=zone)
    return start_at, end_at


def schedule_decision(
    config: ScheduleConfig,
    now: datetime,
    zone: str | tzinfo,
) -> ScheduleDecision:
    tz = _zone(zone)
    localized = now.replace(tzinfo=tz) if now.tzinfo is None else now.astimezone(tz)
    candidates: list[tuple[datetime, datetime, int, str, int]] = []

    for override in config.release_overrides:
        start_at, end_at = _bounds(override.date, override.window, tz)
        candidates.append((start_at, end_at, override.window.interval, f"release:{override.date.isoformat()}", 2))

    for offset in range(-1, 8):
        anchor = localized.date() + timedelta(days=offset)
        for window in config.windows:
            start_at, end_at = _bounds(anchor, window, tz)
            profile = f"window:{window.start.strftime('%H:%M')}-{window.end.strftime('%H:%M')}"
            candidates.append((start_at, end_at, window.interval, profile, 1))

    active = [item for item in candidates if item[0] <= localized < item[1]]
    chosen = max(active, key=lambda item: (item[4], item[0])) if active else None
    boundaries = [boundary for item in candidates for boundary in item[:2] if boundary > localized]
    next_transition = min(boundaries) if boundaries else None
    if chosen:
        return ScheduleDecision(chosen[2], chosen[3], next_transition)
    return ScheduleDecision(config.default_interval, "default", next_transition)


def batch_signatures(products: Sequence[Mapping[str, Any]], size: int) -> list[str]:
    if size < 1:
        raise ValueError("batch size must be positive")
    signatures = []
    for index in range(0, len(products), size):
        batch = products[index:index + size]
        encoded = json.dumps(batch, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        signatures.append(hashlib.sha256(encoded).hexdigest())
    return signatures
