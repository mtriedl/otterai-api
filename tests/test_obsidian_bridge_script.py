import json
import logging
import importlib.util
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, call


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "obsidian-otter-sync"
    / "utils"
    / "otter_sync.py"
)


def load_bridge_module():
    spec = importlib.util.spec_from_file_location("test_otter_sync", SCRIPT_PATH)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def run_bridge(*args):
    return subprocess.run(
        [sys.executable, str(SCRIPT_PATH), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def test_cli_requires_args_and_restricts_mode_choices(tmp_path):
    missing_args = run_bridge()

    assert missing_args.returncode != 0
    assert "--since" in missing_args.stderr
    assert "--mode" in missing_args.stderr
    assert "--output-dir" in missing_args.stderr

    invalid_mode = run_bridge(
        "--since",
        "1710000001",
        "--mode",
        "invalid",
        "--output-dir",
        str(tmp_path),
    )

    assert invalid_mode.returncode != 0
    assert "invalid choice" in invalid_mode.stderr
    assert invalid_mode.stdout == ""


def test_cli_writes_payload_and_prints_stdout_envelope(tmp_path, monkeypatch, capsys):
    bridge = load_bridge_module()
    output_dir = tmp_path / "bridge-output"
    payload = {
        "fetched_until": 1710003601,
        "speeches": [
            {
                "otid": "otter-123",
                "source_url": "https://otter.ai/u/example",
                "title": "Weekly Sync",
                "created_at": 1710000001,
                "modified_time": 1710001801,
                "attendees": ["Ada"],
                "summary_markdown": "",
                "transcript_segments": [],
            }
        ],
    }

    monkeypatch.setattr(
        bridge,
        "parse_args",
        lambda: SimpleNamespace(
            since=1710000001, mode="manual", output_dir=str(output_dir)
        ),
    )
    monkeypatch.setattr(bridge, "build_payload", lambda since: payload)

    bridge.main()

    captured = capsys.readouterr()
    assert captured.err == ""

    envelope = json.loads(captured.out)
    assert envelope["fetched_until"] == payload["fetched_until"]
    assert envelope["speech_count"] == 1

    payload_path = Path(envelope["payload_path"])
    assert payload_path.parent == output_dir
    assert payload_path.exists()

    written_payload = json.loads(payload_path.read_text())
    assert written_payload == payload


def test_cli_keeps_existing_payload_when_atomic_rename_fails(tmp_path, monkeypatch):
    bridge = load_bridge_module()
    output_dir = tmp_path / "bridge-output"
    output_dir.mkdir(parents=True)
    payload_path = output_dir / "payload.json"
    payload_path.write_text('{"fetched_until": 1, "speeches": []}')

    payload = {
        "fetched_until": 1710003601,
        "speeches": [
            {
                "otid": "otter-123",
                "source_url": "https://otter.ai/u/example",
                "title": "Weekly Sync",
                "created_at": 1710000001,
                "modified_time": 1710001801,
                "attendees": ["Ada"],
                "summary_markdown": "",
                "transcript_segments": [],
            }
        ],
    }

    monkeypatch.setattr(
        bridge,
        "parse_args",
        lambda: SimpleNamespace(
            since=1710000001, mode="manual", output_dir=str(output_dir)
        ),
    )
    monkeypatch.setattr(bridge, "build_payload", lambda since: payload)

    def fake_replace(source, destination):
        raise OSError("rename failed")

    monkeypatch.setattr(bridge.Path, "replace", fake_replace)

    try:
        bridge.main()
        assert False, "expected main to fail when atomic rename fails"
    except OSError as exc:
        assert str(exc) == "rename failed"

    assert json.loads(payload_path.read_text()) == {"fetched_until": 1, "speeches": []}


def test_build_payload_fetches_incremental_speeches(monkeypatch):
    bridge = load_bridge_module()
    mock_client = MagicMock()
    mock_client.get_speeches.return_value = {"status": 200, "data": {"speeches": []}}

    monkeypatch.setattr(
        bridge, "get_authenticated_client", lambda: mock_client, raising=False
    )

    payload = bridge.build_payload(1710000001)

    assert payload["speeches"] == []
    mock_client.get_speeches.assert_called_once_with(modified_after=1710000001)


def test_build_payload_normalizes_speech_detail_into_plugin_schema(monkeypatch):
    bridge = load_bridge_module()
    mock_client = MagicMock()
    mock_client.get_speeches.return_value = {
        "status": 200,
        "data": {
            "speeches": [
                {
                    "otid": "otter-123",
                    "title": "Weekly Sync",
                    "created_at": 1710000001,
                    "modified_time": 1710001801,
                }
            ]
        },
    }
    mock_client.get_speech.return_value = {
        "status": 200,
        "data": {
            "speech": {
                "otid": "otter-123",
                "share_url": "https://otter.ai/u/example",
                "speakers": [
                    {"id": 201, "speaker_name": "Ada"},
                    {"id": 202, "speaker_name": "Linus"},
                ],
                "summary": [
                    {"text": "Reviewed action items"},
                    {"text": "Confirmed next steps"},
                ],
                "transcripts": [
                    {
                        "speaker_id": 201,
                        "start_offset": 0,
                        "transcript": "Welcome back everyone.",
                    }
                ],
            }
        },
    }

    monkeypatch.setattr(
        bridge, "get_authenticated_client", lambda: mock_client, raising=False
    )

    payload = bridge.build_payload(1710000001)

    assert payload["speeches"] == [
        {
            "otid": "otter-123",
            "source_url": "https://otter.ai/u/example",
            "title": "Weekly Sync",
            "created_at": 1710000001,
            "modified_time": 1710001801,
            "attendees": ["Ada", "Linus"],
            "summary_markdown": "- Reviewed action items\n- Confirmed next steps",
            "transcript_segments": [
                {
                    "speaker_name": "Ada",
                    "timestamp": "0:00",
                    "text": "Welcome back everyone.",
                }
            ],
        }
    ]
    mock_client.get_speech.assert_called_once_with("otter-123")


def test_build_payload_resolves_speaker_names_from_speaker_id(monkeypatch):
    bridge = load_bridge_module()
    mock_client = MagicMock()
    mock_client.get_speeches.return_value = {
        "status": 200,
        "data": {
            "speeches": [
                {
                    "otid": "otter-speaker-id",
                    "title": "Speaker ID Meeting",
                    "created_at": 1710000001,
                    "modified_time": 1710001801,
                }
            ]
        },
    }
    mock_client.get_speech.return_value = {
        "status": 200,
        "data": {
            "speech": {
                "otid": "otter-speaker-id",
                "share_url": "https://otter.ai/u/speaker-id",
                "speakers": [
                    {"id": 101, "speaker_name": "Ada"},
                    {"id": 102, "speaker_name": "Linus"},
                ],
                "summary": [],
                "transcripts": [
                    {
                        "speaker_id": 101,
                        "start_offset": 284160,
                        "transcript": "Hey, your response? Attacking the week.",
                    },
                    {
                        "speaker_id": 102,
                        "start_offset": 440959,
                        "transcript": "Hey, strong Monday energy, you know,",
                    },
                    {
                        "start_offset": 513919,
                        "transcript": "No speaker at all.",
                    },
                ],
            }
        },
    }

    monkeypatch.setattr(
        bridge, "get_authenticated_client", lambda: mock_client, raising=False
    )

    payload = bridge.build_payload(1710000001)

    segments = payload["speeches"][0]["transcript_segments"]
    assert segments[0]["speaker_name"] == "Ada"
    assert segments[0]["timestamp"] == "0:17"
    assert segments[1]["speaker_name"] == "Linus"
    assert segments[1]["timestamp"] == "0:27"
    assert segments[2]["speaker_name"] == "Unknown Speaker"
    assert segments[2]["timestamp"] == "0:32"


def test_build_payload_falls_back_from_invalid_detail_values(monkeypatch):
    bridge = load_bridge_module()
    mock_client = MagicMock()
    mock_client.get_speeches.return_value = {
        "status": 200,
        "data": {
            "speeches": [
                {
                    "otid": "otter-456",
                    "title": "Fallback Meeting",
                    "created_at": 1710000100,
                    "modified_time": 1710000200,
                    "summary": [{"text": "Summary from list data"}],
                }
            ]
        },
    }
    mock_client.get_speech.return_value = {
        "status": 200,
        "data": {
            "speech": {
                "otid": "otter-456",
                "created_at": None,
                "modified_time": None,
                "summary": None,
                "transcripts": [
                    {
                        "speaker_name": "Ada",
                        "start_time": 5,
                        "transcript": None,
                    }
                ],
            }
        },
    }

    monkeypatch.setattr(
        bridge, "get_authenticated_client", lambda: mock_client, raising=False
    )

    payload = bridge.build_payload(1710000001)

    assert payload["speeches"][0]["created_at"] == 1710000100
    assert payload["speeches"][0]["modified_time"] == 1710000200
    assert payload["speeches"][0]["summary_markdown"] == "- Summary from list data"
    assert payload["speeches"][0]["transcript_segments"] == [
        {
            "speaker_name": "Ada",
            "timestamp": "0:05",
            "text": "",
        }
    ]


def test_build_payload_raises_on_speeches_list_failure(monkeypatch):
    bridge = load_bridge_module()
    mock_client = MagicMock()
    mock_client.get_speeches.return_value = {
        "status": 503,
        "data": {"error": "temporarily unavailable"},
    }

    monkeypatch.setattr(
        bridge, "get_authenticated_client", lambda: mock_client, raising=False
    )

    try:
        bridge.build_payload(1710000001)
        assert False, "expected build_payload to fail when speeches listing fails"
    except RuntimeError as exc:
        assert "Failed to list speeches" in str(exc)


def test_build_payload_fetches_all_incremental_pages(monkeypatch):
    bridge = load_bridge_module()
    mock_client = MagicMock()
    mock_client.get_speeches.side_effect = [
        {
            "status": 200,
            "data": {
                "speeches": [{"otid": "otter-1", "title": "Page One"}],
                "last_load_ts": 1710000100,
            },
        },
        {
            "status": 200,
            "data": {
                "speeches": [{"otid": "otter-2", "title": "Page Two"}],
            },
        },
    ]
    mock_client.get_speech.side_effect = [
        {
            "status": 200,
            "data": {
                "speech": {
                    "otid": "otter-1",
                    "title": "Page One",
                    "created_at": 1710000001,
                    "modified_time": 1710000002,
                    "summary": [],
                    "transcripts": [],
                }
            },
        },
        {
            "status": 200,
            "data": {
                "speech": {
                    "otid": "otter-2",
                    "title": "Page Two",
                    "created_at": 1710000003,
                    "modified_time": 1710000004,
                    "summary": [],
                    "transcripts": [],
                }
            },
        },
    ]

    monkeypatch.setattr(
        bridge, "get_authenticated_client", lambda: mock_client, raising=False
    )

    payload = bridge.build_payload(1710000001)

    assert [speech["otid"] for speech in payload["speeches"]] == ["otter-1", "otter-2"]
    assert mock_client.get_speeches.call_args_list == [
        call(modified_after=1710000001),
        call(modified_after=1710000001, last_load_ts=1710000100),
    ]


def test_build_payload_logs_and_skips_per_speech_failures_without_stdout_pollution(
    monkeypatch, caplog, capsys
):
    bridge = load_bridge_module()
    mock_client = MagicMock()
    mock_client.get_speeches.return_value = {
        "status": 200,
        "data": {
            "speeches": [
                {"otid": "otter-fetch-bad", "title": "Bad Fetch Speech"},
                {"otid": "otter-normalize-bad", "title": "Bad Normalize Speech"},
                {"otid": "otter-good", "title": "Good Speech"},
            ]
        },
    }
    mock_client.get_speech.side_effect = [
        RuntimeError("detail exploded"),
        {"status": 200, "data": {"speech": {"otid": "otter-normalize-bad"}}},
        {
            "status": 200,
            "data": {
                "speech": {
                    "otid": "otter-good",
                    "title": "Good Speech",
                    "created_at": 1710000003,
                    "modified_time": 1710000004,
                    "summary": [],
                    "transcripts": [],
                }
            },
        },
    ]

    def fake_normalize(summary_speech, detail_speech):
        if detail_speech.get("otid") == "otter-normalize-bad":
            raise ValueError("bad detail shape")
        return {
            "otid": summary_speech["otid"],
            "source_url": f"https://otter.ai/u/{summary_speech['otid']}",
            "title": summary_speech["title"],
            "created_at": detail_speech["created_at"],
            "modified_time": detail_speech["modified_time"],
            "attendees": [],
            "summary_markdown": "",
            "transcript_segments": [],
        }

    monkeypatch.setattr(
        bridge, "get_authenticated_client", lambda: mock_client, raising=False
    )
    monkeypatch.setattr(bridge, "parse_speech", fake_normalize)

    with caplog.at_level(logging.WARNING):
        payload = bridge.build_payload(1710000001)

    assert [speech["otid"] for speech in payload["speeches"]] == ["otter-good"]
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""
    assert caplog.messages == [
        "Skipping speech otter-fetch-bad: detail exploded",
        "Skipping speech otter-normalize-bad: bad detail shape",
    ]


def test_build_payload_converts_structured_summary_content_to_markdown(monkeypatch):
    bridge = load_bridge_module()
    mock_client = MagicMock()
    mock_client.get_speeches.return_value = {
        "status": 200,
        "data": {
            "speeches": [
                {
                    "otid": "otter-structured",
                    "title": "Structured Summary",
                    "created_at": 1710000001,
                    "modified_time": 1710001801,
                }
            ]
        },
    }
    mock_client.get_speech.return_value = {
        "status": 200,
        "data": {
            "speech": {
                "otid": "otter-structured",
                "created_at": 1710000001,
                "modified_time": 1710001801,
                "summary": {
                    "outline": [
                        {"text": "Reviewed roadmap"},
                        {"text": "Confirmed launch plan"},
                    ],
                    "action_items": [
                        {"text": "Ada to publish notes"},
                        {"text": "Linus to confirm owners"},
                    ],
                },
                "transcripts": [],
            }
        },
    }

    monkeypatch.setattr(
        bridge, "get_authenticated_client", lambda: mock_client, raising=False
    )

    payload = bridge.build_payload(1710000001)

    assert payload["speeches"][0]["summary_markdown"] == (
        "## Outline\n"
        "- Reviewed roadmap\n"
        "- Confirmed launch plan\n\n"
        "## Action Items\n"
        "- Ada to publish notes\n"
        "- Linus to confirm owners"
    )


def test_build_payload_filters_out_speeches_older_than_since_after_fetch(
    monkeypatch, caplog, capsys
):
    bridge = load_bridge_module()
    mock_client = MagicMock()
    mock_client.get_speeches.return_value = {
        "status": 200,
        "data": {
            "speeches": [
                {"otid": "otter-old", "title": "Old Speech"},
                {"otid": "otter-new", "title": "New Speech"},
            ]
        },
    }
    mock_client.get_speech.side_effect = [
        {
            "status": 200,
            "data": {
                "speech": {
                    "otid": "otter-old",
                    "title": "Old Speech",
                    "created_at": 1710000001,
                    "modified_time": 1709999999,
                    "summary": [],
                    "transcripts": [],
                }
            },
        },
        {
            "status": 200,
            "data": {
                "speech": {
                    "otid": "otter-new",
                    "title": "New Speech",
                    "created_at": 1710000002,
                    "modified_time": 1710000001,
                    "summary": [],
                    "transcripts": [],
                }
            },
        },
    ]

    monkeypatch.setattr(
        bridge, "get_authenticated_client", lambda: mock_client, raising=False
    )

    with caplog.at_level(logging.WARNING):
        payload = bridge.build_payload(1710000001)

    assert [speech["otid"] for speech in payload["speeches"]] == ["otter-new"]
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""
    assert caplog.messages == [
        "Skipping speech otter-old: modified_time 1709999999 is older than since 1710000001"
    ]


def test_render_abstract_summary_returns_prose_when_finished():
    bridge = load_bridge_module()
    data = {
        "process_status": "finished",
        "abstract_summary": {
            "short_summary": "The team discussed project timelines and deliverables."
        },
    }
    assert bridge._render_abstract_summary(data) == "The team discussed project timelines and deliverables."


def test_render_abstract_summary_returns_placeholder_when_not_finished():
    bridge = load_bridge_module()
    data = {"process_status": "processing", "abstract_summary": {}}
    assert bridge._render_abstract_summary(data) == "*Summary processing...*"


def test_render_abstract_summary_returns_placeholder_when_summary_missing():
    bridge = load_bridge_module()
    data = {"process_status": "finished", "abstract_summary": {}}
    assert bridge._render_abstract_summary(data) == "*Summary processing...*"


def test_render_abstract_summary_returns_placeholder_for_empty_data():
    bridge = load_bridge_module()
    assert bridge._render_abstract_summary({}) == "*Summary processing...*"
    assert bridge._render_abstract_summary(None) == "*Summary processing...*"


def test_render_action_items_with_mixed_items():
    bridge = load_bridge_module()
    data = {
        "process_status": "finished",
        "speech_action_items": [
            {
                "text": "Send the report to the team",
                "assignee": {"name": "Ada Lovelace"},
                "completed": False,
            },
            {
                "text": "Review the budget proposal",
                "assignee": {"name": "Linus Torvalds"},
                "completed": True,
            },
            {
                "text": "Schedule follow-up meeting",
                "assignee": None,
                "completed": False,
            },
        ],
    }
    result = bridge._render_action_items(data)
    assert result == (
        "- [ ] @Ada Lovelace - Send the report to the team\n"
        "- [x] @Linus Torvalds - Review the budget proposal\n"
        "- [ ] Schedule follow-up meeting"
    )


def test_render_action_items_returns_placeholder_when_not_finished():
    bridge = load_bridge_module()
    data = {"process_status": "processing", "speech_action_items": []}
    assert bridge._render_action_items(data) == "*Action items processing...*"


def test_render_action_items_returns_placeholder_for_empty_data():
    bridge = load_bridge_module()
    assert bridge._render_action_items({}) == "*Action items processing...*"
    assert bridge._render_action_items(None) == "*Action items processing...*"


def test_render_action_items_with_empty_array():
    bridge = load_bridge_module()
    data = {"process_status": "finished", "speech_action_items": []}
    assert bridge._render_action_items(data) == "*Action items processing...*"


def test_render_outline_with_parent_and_child_segments():
    bridge = load_bridge_module()
    speech_outline = [
        {
            "text": "Weather and Personal Updates",
            "segments": [
                {"text": "Matthew discussed the unpredictable weather."},
                {"text": "Speaker 1 mentioned weekend plans."},
            ],
        },
        {
            "text": "Project Status Review",
            "segments": [
                {"text": "The team reviewed the roadmap."},
            ],
        },
    ]
    result = bridge._render_outline(speech_outline)
    assert result == (
        "### Weather and Personal Updates\n\n"
        "- Matthew discussed the unpredictable weather.\n"
        "- Speaker 1 mentioned weekend plans.\n\n"
        "### Project Status Review\n\n"
        "- The team reviewed the roadmap."
    )


def test_render_outline_returns_placeholder_for_empty():
    bridge = load_bridge_module()
    assert bridge._render_outline([]) == "*Outline processing...*"
    assert bridge._render_outline(None) == "*Outline processing...*"


def test_render_outline_skips_parents_with_no_text():
    bridge = load_bridge_module()
    speech_outline = [
        {
            "text": "",
            "segments": [{"text": "Orphaned segment."}],
        },
        {
            "text": "Valid Section",
            "segments": [{"text": "Valid content."}],
        },
    ]
    result = bridge._render_outline(speech_outline)
    assert result == (
        "### Valid Section\n\n"
        "- Valid content."
    )


def test_render_outline_handles_parent_with_null_segments():
    bridge = load_bridge_module()
    speech_outline = [
        {
            "text": "Empty Section",
            "segments": None,
        },
        {
            "text": "Full Section",
            "segments": [{"text": "Has content."}],
        },
    ]
    result = bridge._render_outline(speech_outline)
    assert result == (
        "### Empty Section\n\n"
        "### Full Section\n\n"
        "- Has content."
    )


def test_assemble_summary_markdown_all_sections():
    bridge = load_bridge_module()
    abstract_data = {
        "process_status": "finished",
        "abstract_summary": {
            "short_summary": "The team discussed project timelines.",
        },
    }
    action_items_data = {
        "process_status": "finished",
        "speech_action_items": [
            {
                "text": "Send the report",
                "assignee": {"name": "Ada Lovelace"},
                "completed": False,
            },
        ],
    }
    speech_outline = [
        {
            "text": "Project Review",
            "segments": [{"text": "Reviewed the roadmap."}],
        },
    ]
    result = bridge._assemble_summary_markdown(abstract_data, action_items_data, speech_outline)
    assert result == (
        "The team discussed project timelines.\n\n"
        "## Action Items\n\n"
        "- [ ] @Ada Lovelace - Send the report\n\n"
        "## Outline\n\n"
        "### Project Review\n\n"
        "- Reviewed the roadmap."
    )


def test_assemble_summary_markdown_with_placeholders():
    bridge = load_bridge_module()
    result = bridge._assemble_summary_markdown(None, None, None)
    assert result == (
        "*Summary processing...*\n\n"
        "## Action Items\n\n"
        "*Action items processing...*\n\n"
        "## Outline\n\n"
        "*Outline processing...*"
    )
