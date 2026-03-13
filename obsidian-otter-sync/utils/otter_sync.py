import argparse
import json
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from otterai.cli import get_authenticated_client


def _coerce_int(value, default=0):
    if isinstance(value, bool) or value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _first_non_empty_string(*values):
    for value in values:
        if isinstance(value, str):
            stripped = value.strip()
            if stripped:
                return stripped
    return ""


def _normalize_title(summary_speech, detail_speech):
    title = _first_non_empty_string(
        detail_speech.get("title"), summary_speech.get("title")
    )
    return title or "Untitled Meeting"


def _normalize_attendees(summary_speech, detail_speech):
    attendees = []
    seen = set()
    for source in (detail_speech, summary_speech):
        speakers = source.get("speakers")
        if not isinstance(speakers, list):
            continue
        for speaker in speakers:
            if not isinstance(speaker, dict):
                continue
            name = _first_non_empty_string(speaker.get("speaker_name"))
            if name and name not in seen:
                attendees.append(name)
                seen.add(name)
    return attendees


def _normalize_summary_markdown(summary_value):
    if isinstance(summary_value, str):
        return summary_value.strip()
    if not isinstance(summary_value, list):
        return ""

    lines = []
    for item in summary_value:
        if isinstance(item, str):
            text = item.strip()
        elif isinstance(item, dict):
            text = _first_non_empty_string(
                item.get("text"), item.get("summary"), item.get("markdown")
            )
        else:
            text = ""
        if text:
            lines.append(f"- {text}")
    return "\n".join(lines)


def _format_segment_timestamp(value):
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            return stripped

    total_seconds = _coerce_int(value, default=0)
    minutes, seconds = divmod(total_seconds, 60)
    return f"{minutes}:{seconds:02d}"


def _normalize_transcript_segments(detail_speech):
    transcripts = detail_speech.get("transcripts")
    if not isinstance(transcripts, list):
        return []

    segments = []
    for transcript in transcripts:
        if not isinstance(transcript, dict):
            continue
        segments.append(
            {
                "speaker_name": _first_non_empty_string(
                    transcript.get("speaker_name"), "Unknown Speaker"
                ),
                "timestamp": _format_segment_timestamp(
                    transcript.get("timestamp", transcript.get("start_time"))
                ),
                "text": transcript.get("transcript", transcript.get("text", "")),
            }
        )
    return segments


def normalize_speech(summary_speech, detail_speech):
    otid = _first_non_empty_string(
        detail_speech.get("otid"), summary_speech.get("otid")
    )
    created_at = _coerce_int(
        detail_speech.get("created_at", summary_speech.get("created_at"))
    )
    modified_time = _coerce_int(
        detail_speech.get("modified_time", summary_speech.get("modified_time"))
    )

    return {
        "otid": otid,
        "source_url": _first_non_empty_string(
            detail_speech.get("share_url"),
            detail_speech.get("source_url"),
            summary_speech.get("share_url"),
            summary_speech.get("source_url"),
        )
        or f"https://otter.ai/u/{otid}",
        "title": _normalize_title(summary_speech, detail_speech),
        "created_at": created_at,
        "modified_time": modified_time,
        "attendees": _normalize_attendees(summary_speech, detail_speech),
        "summary_markdown": _normalize_summary_markdown(
            detail_speech.get("summary", summary_speech.get("summary"))
        ),
        "transcript_segments": _normalize_transcript_segments(detail_speech),
    }


def build_payload(since, fetched_until=None):
    if fetched_until is None:
        fetched_until = int(time.time())

    client = get_authenticated_client()
    speeches_result = client.get_speeches(modified_after=since)
    speeches = speeches_result.get("data", {}).get("speeches", [])

    normalized_speeches = []
    for summary_speech in speeches:
        otid = _first_non_empty_string(summary_speech.get("otid"))
        if not otid:
            continue

        detail_result = client.get_speech(otid)
        if detail_result.get("status") != 200:
            continue

        detail_speech = detail_result.get("data", {}).get("speech", {})
        normalized_speeches.append(normalize_speech(summary_speech, detail_speech))

    return {"fetched_until": fetched_until, "speeches": normalized_speeches}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", required=True, type=int)
    parser.add_argument(
        "--mode", required=True, choices=("scheduled", "manual", "forced")
    )
    parser.add_argument("--output-dir", required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    payload_path = output_dir / "payload.json"
    payload = build_payload(args.since)
    payload_path.write_text(json.dumps(payload))

    envelope = {
        "payload_path": str(payload_path),
        "fetched_until": payload["fetched_until"],
        "speech_count": len(payload["speeches"]),
    }
    print(json.dumps(envelope))


if __name__ == "__main__":
    main()
