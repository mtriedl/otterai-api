"""Smoke test for otter_sync against the live Otter API.

Requires saved credentials (run `uv run otter login` first).

Usage:
    uv run pytest tests/test_otter_sync_smoke.py -v -s
    SMOKE_DAYS=30 uv run pytest tests/test_otter_sync_smoke.py -v -s
"""

import importlib.util
import os
import time
from pathlib import Path

import pytest

SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "obsidian-otter-sync"
    / "utils"
    / "otter_sync.py"
)

DAYS = int(os.environ.get("SMOKE_DAYS", "7"))


def load_bridge_module():
    spec = importlib.util.spec_from_file_location("test_otter_sync", SCRIPT_PATH)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _has_credentials():
    try:
        from otterai.config import load_credentials
        username, password = load_credentials()
        return bool(username and password)
    except Exception:
        return False


def _validate_segment(segment, path):
    assert isinstance(segment, dict), f"{path} must be an object"
    assert isinstance(segment["speaker_name"], str) and segment["speaker_name"].strip(), (
        f"{path}.speaker_name must be a non-empty string, got {segment['speaker_name']!r}"
    )
    assert isinstance(segment["timestamp"], str) and segment["timestamp"].strip(), (
        f"{path}.timestamp must be a non-empty string, got {segment['timestamp']!r}"
    )
    assert isinstance(segment["text"], str), (
        f"{path}.text must be a string, got {type(segment['text'])}"
    )


def _validate_speech(speech, index):
    prefix = f"speeches[{index}]"

    # Non-empty strings
    for field in ("otid", "source_url", "title"):
        value = speech.get(field)
        assert isinstance(value, str) and value.strip(), (
            f"{prefix}.{field} must be a non-empty string, got {value!r}"
        )

    # Integers
    for field in ("created_at", "modified_time"):
        value = speech.get(field)
        assert isinstance(value, int), (
            f"{prefix}.{field} must be an integer, got {value!r} ({type(value).__name__})"
        )

    # Attendees: list of strings
    attendees = speech.get("attendees")
    assert isinstance(attendees, list), f"{prefix}.attendees must be a list"
    for i, attendee in enumerate(attendees):
        assert isinstance(attendee, str), (
            f"{prefix}.attendees[{i}] must be a string, got {type(attendee).__name__}"
        )

    # Summary markdown: string (can be empty)
    assert isinstance(speech.get("summary_markdown"), str), (
        f"{prefix}.summary_markdown must be a string"
    )

    # Transcript segments
    segments = speech.get("transcript_segments")
    assert isinstance(segments, list), f"{prefix}.transcript_segments must be a list"
    for i, segment in enumerate(segments):
        _validate_segment(segment, f"{prefix}.transcript_segments[{i}]")


@pytest.mark.skipif(not _has_credentials(), reason="No Otter credentials. Run 'uv run otter login' first.")
def test_build_payload_against_live_api():
    bridge = load_bridge_module()
    since = int(time.time()) - DAYS * 86400

    payload = bridge.build_payload(since)

    # Payload-level checks
    assert isinstance(payload, dict)
    assert isinstance(payload["fetched_until"], int)
    assert payload["fetched_until"] >= since

    speeches = payload["speeches"]
    assert isinstance(speeches, list)

    for i, speech in enumerate(speeches):
        _validate_speech(speech, i)
        assert speech["modified_time"] >= since, (
            f"speeches[{i}] modified_time {speech['modified_time']} is older than since {since}"
        )

    # Print summary
    print(f"\n{'=' * 60}")
    print(f"Fetched {len(speeches)} speeches from the last {DAYS} days")
    print(f"{'=' * 60}")
    for i, speech in enumerate(speeches):
        seg_count = len(speech["transcript_segments"])
        attendee_count = len(speech["attendees"])
        summary_len = len(speech["summary_markdown"])
        print(
            f"  [{i}] {speech['title']}"
            f"\n      otid={speech['otid']}"
            f"  attendees={attendee_count}"
            f"  segments={seg_count}"
            f"  summary={summary_len} chars"
        )
