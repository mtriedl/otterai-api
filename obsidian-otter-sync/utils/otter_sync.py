import argparse
import json
import time
from pathlib import Path


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
    fetched_until = int(time.time())

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    payload_path = output_dir / "payload.json"
    payload = {"fetched_until": fetched_until, "speeches": []}
    payload_path.write_text(json.dumps(payload))

    envelope = {
        "payload_path": str(payload_path),
        "fetched_until": fetched_until,
        "speech_count": 0,
    }
    print(json.dumps(envelope))


if __name__ == "__main__":
    main()
