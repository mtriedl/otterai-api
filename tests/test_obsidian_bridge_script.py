import json
import subprocess
import sys
from pathlib import Path


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "obsidian-otter-sync"
    / "utils"
    / "otter_sync.py"
)


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


def test_cli_writes_minimal_payload_and_prints_stdout_envelope(tmp_path):
    output_dir = tmp_path / "bridge-output"

    result = run_bridge(
        "--since",
        "1710000001",
        "--mode",
        "manual",
        "--output-dir",
        str(output_dir),
    )

    assert result.returncode == 0
    assert result.stderr == ""

    envelope = json.loads(result.stdout)
    assert envelope["fetched_until"] == 1710000001
    assert envelope["speech_count"] == 0

    payload_path = Path(envelope["payload_path"])
    assert payload_path.parent == output_dir
    assert payload_path.exists()

    payload = json.loads(payload_path.read_text())
    assert payload == {"fetched_until": 1710000001, "speeches": []}
