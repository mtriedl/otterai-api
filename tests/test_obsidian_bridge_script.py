import json
import importlib.util
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock


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
