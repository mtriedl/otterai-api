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
                    {"speaker_name": "Ada"},
                    {"speaker_name": "Linus"},
                ],
                "summary": [
                    {"text": "Reviewed action items"},
                    {"text": "Confirmed next steps"},
                ],
                "transcripts": [
                    {
                        "speaker_name": "Ada",
                        "start_time": 0,
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
    monkeypatch.setattr(bridge, "normalize_speech", fake_normalize)

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
