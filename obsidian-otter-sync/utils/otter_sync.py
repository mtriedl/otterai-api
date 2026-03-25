#%%
import argparse
import json
import logging
import tempfile
import time
from pathlib import Path

from otterai.cli import get_authenticated_client

LOGGER = logging.getLogger(__name__)


def _safe_int(value):
    """Convert to int, returning None for booleans, None, or unparseable values."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_str(value):
    """Return stripped string, or empty string for non-string values."""
    return value.strip() if isinstance(value, str) else ""


def _format_timestamp(value):
    """Format a timestamp value as M:SS. Passes through existing string timestamps."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    total_seconds = _safe_int(value) or 0
    minutes, seconds = divmod(total_seconds, 60)
    return f"{minutes}:{seconds:02d}"


def _log_skip(otid, reason):
    LOGGER.warning("Skipping speech %s: %s", otid, reason)


# --- Fetching ---


def get_speeches(client, since):
    """Fetch all speech summaries modified after `since`, handling pagination."""
    speeches = []
    seen_tokens = set()
    last_load_ts = None

    while True:
        kwargs = {"modified_after": since}
        if last_load_ts is not None:
            kwargs["last_load_ts"] = last_load_ts

        result = client.get_speeches(**kwargs)
        if result.get("status") != 200:
            raise RuntimeError(f"Failed to list speeches: {result}")

        data = result.get("data", {})
        speeches.extend(data.get("speeches", []))

        next_token = _safe_int(data.get("last_load_ts"))
        if next_token is None or next_token in seen_tokens:
            break

        seen_tokens.add(next_token)
        last_load_ts = next_token

    return speeches


# --- Filtering ---


def filter_speeches(speeches, since):
    """Keep only speeches with modified_time >= since."""
    filtered = []
    for speech in speeches:
        modified = speech.get("modified_time", 0)
        if modified < since:
            _log_skip(
                speech.get("otid", "<unknown>"),
                f"modified_time {modified} is older than since {since}",
            )
            continue
        filtered.append(speech)
    return filtered


# --- Parsing ---


def _parse_attendees(summary, detail):
    """Extract deduplicated speaker names from detail and summary."""
    attendees = []
    seen = set()
    for source in (detail, summary):
        speakers = source.get("speakers")
        if not isinstance(speakers, list):
            continue
        for speaker in speakers:
            if not isinstance(speaker, dict):
                continue
            name = _safe_str(speaker.get("speaker_name"))
            if name and name not in seen:
                attendees.append(name)
                seen.add(name)
    return attendees


def _render_abstract_summary(data):
    """Render the abstract summary prose from the API response."""
    if not isinstance(data, dict):
        return "*Summary processing...*"
    if data.get("process_status") != "finished":
        return "*Summary processing...*"
    summary = data.get("abstract_summary")
    if not isinstance(summary, dict):
        return "*Summary processing...*"
    text = _safe_str(summary.get("short_summary"))
    if not text:
        return "*Summary processing...*"
    return text


def _render_action_items(data):
    """Render action items as markdown checkboxes from the API response."""
    if not isinstance(data, dict):
        return "*Action items processing...*"
    if data.get("process_status") != "finished":
        return "*Action items processing...*"
    items = data.get("speech_action_items")
    if not isinstance(items, list) or not items:
        return "*Action items processing...*"
    lines = []
    for item in items:
        if not isinstance(item, dict):
            continue
        text = _safe_str(item.get("text"))
        if not text:
            continue
        checkbox = "- [x]" if item.get("completed") else "- [ ]"
        assignee = item.get("assignee")
        if isinstance(assignee, dict) and _safe_str(assignee.get("name")):
            lines.append(f"{checkbox} @{assignee['name']} - {text}")
        else:
            lines.append(f"{checkbox} {text}")
    if not lines:
        return "*Action items processing...*"
    return "\n".join(lines)


def _render_outline(speech_outline):
    """Render the speech outline as markdown headings with bullet children."""
    if not isinstance(speech_outline, list) or not speech_outline:
        return "*Outline processing...*"
    sections = []
    for parent in speech_outline:
        if not isinstance(parent, dict):
            continue
        heading = _safe_str(parent.get("text"))
        if not heading:
            continue
        parts = [f"### {heading}"]
        segments = parent.get("segments")
        if isinstance(segments, list):
            bullets = []
            for seg in segments:
                if not isinstance(seg, dict):
                    continue
                seg_text = _safe_str(seg.get("text"))
                if seg_text:
                    bullets.append(f"- {seg_text}")
            if bullets:
                parts.append("\n".join(bullets))
        sections.append("\n\n".join(parts))
    if not sections:
        return "*Outline processing...*"
    return "\n\n".join(sections)


def _assemble_summary_markdown(abstract_data, action_items_data, speech_outline):
    """Combine all three summary sources into a single markdown string."""
    prose = _render_abstract_summary(abstract_data)
    action_items = _render_action_items(action_items_data)
    outline = _render_outline(speech_outline)
    return f"{prose}\n\n## Action Items\n\n{action_items}\n\n## Outline\n\n{outline}"


def _parse_summary(value):
    """Convert an API summary value (str, dict, or list) to markdown."""
    if isinstance(value, str):
        return value.strip()

    if isinstance(value, dict):
        sections = []
        for key, heading in (("outline", "Outline"), ("action_items", "Action Items")):
            section_md = _parse_summary(value.get(key))
            if section_md:
                sections.append(f"## {heading}\n{section_md}")
        return "\n\n".join(sections)

    if isinstance(value, list):
        lines = []
        for item in value:
            if isinstance(item, str):
                text = item.strip()
            elif isinstance(item, dict):
                text = (
                    _safe_str(item.get("text"))
                    or _safe_str(item.get("summary"))
                    or _safe_str(item.get("markdown"))
                )
            else:
                text = ""
            if text:
                lines.append(f"- {text}")
        return "\n".join(lines)

    return ""


def _build_speaker_map(detail, summary):
    """Build a speaker_id -> speaker_name mapping from the speakers list."""
    speaker_map = {}
    for source in (detail, summary):
        speakers = source.get("speakers")
        if not isinstance(speakers, list):
            continue
        for speaker in speakers:
            if not isinstance(speaker, dict):
                continue
            sid = speaker.get("id") or speaker.get("speaker_id")
            name = _safe_str(speaker.get("speaker_name"))
            if sid is not None and name:
                speaker_map.setdefault(sid, name)
    return speaker_map


def _parse_transcript(transcripts, speaker_map=None):
    """Convert API transcript list to segment dicts."""
    if not isinstance(transcripts, list):
        return []
    if speaker_map is None:
        speaker_map = {}

    segments = []
    for t in transcripts:
        if not isinstance(t, dict):
            continue
        name = _safe_str(t.get("speaker_name"))
        if not name:
            sid = t.get("speaker_id")
            if sid is not None:
                name = speaker_map.get(sid, "")
        start_samples = _safe_int(t.get("start_offset"))
        start_seconds = start_samples // 16000 if start_samples is not None else None
        raw_ts = start_seconds if start_seconds is not None else t.get("start_time")
        segments.append({
            "speaker_name": name or "Unknown Speaker",
            "timestamp": _format_timestamp(raw_ts),
            "text": _safe_str(t.get("transcript")) or _safe_str(t.get("text")),
        })
    return segments


def parse_speech(summary, detail):
    """Parse raw API summary + detail into the plugin schema.

    Prefers detail values, falls back to summary for missing/invalid fields.
    """
    otid = _safe_str(detail.get("otid")) or _safe_str(summary.get("otid"))
    source_url = (
        _safe_str(detail.get("share_url"))
        or _safe_str(detail.get("source_url"))
        or _safe_str(summary.get("share_url"))
        or _safe_str(summary.get("source_url"))
        or f"https://otter.ai/u/{otid}"
    )

    return {
        "otid": otid,
        "source_url": source_url,
        "title": (
            _safe_str(detail.get("title"))
            or _safe_str(summary.get("title"))
            or "Untitled Meeting"
        ),
        "created_at": _safe_int(detail.get("created_at")) or _safe_int(summary.get("created_at")) or 0,
        "modified_time": _safe_int(detail.get("modified_time")) or _safe_int(summary.get("modified_time")) or 0,
        "attendees": _parse_attendees(summary, detail),
        "summary_markdown": _parse_summary(detail.get("summary")) or _parse_summary(summary.get("summary")),
        "transcript_segments": _parse_transcript(
            detail.get("transcripts"), _build_speaker_map(detail, summary)
        ),
    }


# --- Orchestration ---


def build_payload(since, fetched_until=None):
    """Fetch, parse, and filter all speeches modified after `since`."""
    if fetched_until is None:
        fetched_until = int(time.time())

    client = get_authenticated_client()
    summaries = get_speeches(client, since)

    parsed = []
    for summary in summaries:
        otid = _safe_str(summary.get("otid"))
        if not otid:
            _log_skip("<missing otid>", "missing speech identifier")
            continue

        try:
            detail_result = client.get_speech(otid)
        except Exception as exc:
            _log_skip(otid, exc)
            continue

        if detail_result.get("status") != 200:
            _log_skip(otid, f"detail fetch failed: {detail_result}")
            continue

        detail = detail_result.get("data", {}).get("speech", {})
        try:
            speech = parse_speech(summary, detail)
        except Exception as exc:
            _log_skip(otid, exc)
            continue

        parsed.append(speech)

    return {"fetched_until": fetched_until, "speeches": filter_speeches(parsed, since)}


# --- CLI ---


def _write_payload_atomically(payload_path, payload):
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=payload_path.parent, delete=False
        ) as temp_file:
            json.dump(payload, temp_file)
            temp_path = Path(temp_file.name)
        temp_path.replace(payload_path)
    except Exception:
        if temp_path is not None and temp_path.exists():
            temp_path.unlink()
        raise


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", required=True, type=int)
    parser.add_argument("--mode", required=True, choices=("scheduled", "manual", "forced"))
    parser.add_argument("--output-dir", required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    payload_path = output_dir / "payload.json"
    payload = build_payload(args.since)
    _write_payload_atomically(payload_path, payload)

    envelope = {
        "payload_path": str(payload_path),
        "fetched_until": payload["fetched_until"],
        "speech_count": len(payload["speeches"]),
    }
    print(json.dumps(envelope))


#%%
if __name__ == "__main__":
    main()
