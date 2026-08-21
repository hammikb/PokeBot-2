"""Idempotently add validated dated Target schedules to the Pi control agent."""

from __future__ import annotations

import argparse
import ast
import os
import re
import tempfile
from pathlib import Path


MARKER = "# TARGET_RELEASE_SCHEDULE_PATCH_V1"


def _replace_callable(source: str, name: str, replacement: str) -> str:
    tree = ast.parse(source)
    matches = [
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name
    ]
    if len(matches) != 1:
        raise ValueError(f"expected one callable named {name}, found {len(matches)}")
    node = matches[0]
    lines = source.splitlines(keepends=True)
    start = sum(len(line) for line in lines[: node.lineno - 1])
    end = sum(len(line) for line in lines[: node.end_lineno])
    return source[:start] + replacement.rstrip() + "\n" + source[end:]


VALID_CLOCK = '''def _valid_hhmm(value):
    return bool(re.fullmatch(r"(?:[01]\\d|2[0-3]):[0-5]\\d", str(value or "")))
'''


SET_SCHEDULE = '''def set_target_schedule(payload):
    """Validate and atomically replace recurring and dated Target cadence."""
    payload = payload or {}
    if payload.get("enabled") is False:
        try:
            SCHEDULE_FILE.unlink(missing_ok=True)
        except OSError as exc:
            return False, f"Could not clear Target schedule: {exc}"
        return True, "Target schedule cleared; falling back to env day/night defaults"

    try:
        default_interval = int(payload["default_interval"])
    except (TypeError, ValueError, KeyError):
        return False, "Schedule needs an integer default_interval"
    if not MIN_INTERVAL_SECONDS <= default_interval <= MAX_INTERVAL_SECONDS:
        return False, f"default_interval must be {MIN_INTERVAL_SECONDS}-{MAX_INTERVAL_SECONDS}s"

    raw_windows = payload.get("windows") or []
    if not isinstance(raw_windows, list) or len(raw_windows) > MAX_WINDOWS:
        return False, f"Schedule accepts at most {MAX_WINDOWS} windows"
    windows = []
    for window in raw_windows:
        if not isinstance(window, dict):
            return False, "Each window must be an object"
        if not _valid_hhmm(window.get("start")) or not _valid_hhmm(window.get("end")):
            return False, "Window start/end must be HH:MM"
        try:
            interval = int(window["interval"])
        except (TypeError, ValueError, KeyError):
            return False, "Window interval must be an integer"
        if not MIN_INTERVAL_SECONDS <= interval <= MAX_INTERVAL_SECONDS:
            return False, f"Window interval must be {MIN_INTERVAL_SECONDS}-{MAX_INTERVAL_SECONDS}s"
        windows.append({"start": window["start"], "end": window["end"], "interval": interval})

    raw_overrides = payload.get("release_overrides") or []
    if not isinstance(raw_overrides, list) or len(raw_overrides) > MAX_RELEASE_OVERRIDES:
        return False, f"Schedule accepts at most {MAX_RELEASE_OVERRIDES} release overrides"
    release_overrides = []
    seen_dates = set()
    local_now = datetime.now()
    for override in raw_overrides:
        if not isinstance(override, dict):
            return False, "Each release override must be an object"
        date_text = str(override.get("date") or "")
        try:
            override_date = datetime.strptime(date_text, "%Y-%m-%d").date()
        except ValueError:
            return False, "Release override dates must be YYYY-MM-DD"
        if override_date.isoformat() != date_text:
            return False, "Release override dates must be YYYY-MM-DD"
        if date_text in seen_dates:
            return False, "Release override dates must be unique"
        seen_dates.add(date_text)
        start = override.get("start")
        end = override.get("end")
        if not _valid_hhmm(start) or not _valid_hhmm(end):
            return False, "Release override start/end must be HH:MM"
        try:
            interval = int(override["interval"])
        except (TypeError, ValueError, KeyError):
            return False, "Release override interval must be an integer"
        if not MIN_INTERVAL_SECONDS <= interval <= MAX_INTERVAL_SECONDS:
            return False, f"Release override interval must be {MIN_INTERVAL_SECONDS}-{MAX_INTERVAL_SECONDS}s"

        start_at = datetime.strptime(f"{date_text}T{start}", "%Y-%m-%dT%H:%M")
        end_at = datetime.strptime(f"{date_text}T{end}", "%Y-%m-%dT%H:%M")
        if end_at <= start_at:
            end_at += timedelta(days=1)
        if end_at <= local_now:
            continue
        release_overrides.append({
            "date": date_text,
            "start": start,
            "end": end,
            "interval": interval,
        })

    release_overrides.sort(key=lambda item: item["date"])
    config = {
        "default_interval": default_interval,
        "windows": windows,
        "release_overrides": release_overrides,
        "updated_at": now(),
    }
    temporary = None
    try:
        SCHEDULE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=SCHEDULE_FILE.parent,
            prefix=f".{SCHEDULE_FILE.name}.",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            json.dump(config, handle, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, SCHEDULE_FILE)
    except OSError as exc:
        return False, f"Could not save Target schedule: {exc}"
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    count = len(release_overrides)
    noun = "override" if count == 1 else "overrides"
    return True, (
        f"Target schedule saved: {len(windows)} window(s), default {default_interval}s, "
        f"{count} release {noun}"
    )
'''


def patch_source(source: str) -> str:
    if MARKER in source:
        return source
    if source.count("import os\n") != 1:
        raise ValueError("expected one os import")
    source = source.replace("import os\n", "import os\nimport tempfile\n", 1)
    source, replacements = re.subn(
        r"MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, MAX_WINDOWS = \d+, 3600, 12",
        "MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, MAX_WINDOWS = 15, 3600, 12\nMAX_RELEASE_OVERRIDES = 32",
        source,
        count=1,
    )
    if replacements != 1:
        raise ValueError("expected one schedule constants assignment")
    source = _replace_callable(source, "_valid_hhmm", VALID_CLOCK)
    source = _replace_callable(source, "set_target_schedule", SET_SCHEDULE)
    return f"{MARKER}\n{source}"


def patch_file(source_path: Path, destination_path: Path) -> None:
    patched = patch_source(source_path.read_text(encoding="utf-8"))
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=destination_path.parent,
            prefix=f".{destination_path.name}.",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(patched)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination_path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    patch_file(args.source, args.destination)


if __name__ == "__main__":
    main()
