# Obsidian Python Bridge Design

## Overview

Add a Python bridge script for the Obsidian Otter Sync plugin at `obsidian-otter-sync/utils/otter_sync.py`. The script will convert OtterAI data from the existing `otterai-api` library into the normalized schema already expected by the plugin.

Because transcript-heavy sync runs can produce large payloads, the script will not stream the full normalized payload over stdout. Instead, it will write the payload to a timestamped JSON file in a plugin-owned output directory and return a small stdout envelope pointing to that file.

This design keeps the plugin-side contract stable and reliable for large outputs while making generated payloads inspectable for debugging.

## Goals

- Provide the missing Python bridge required by the Obsidian plugin.
- Reuse the user's existing `otterai-api` auth/config instead of introducing new credential handling.
- Support incremental sync using `--since` and `--mode`.
- Produce the normalized bridge payload required by the plugin schema.
- Handle large payloads more reliably than stdout-only transport.
- Keep per-speech failures non-fatal while preserving useful logs.

## Non-Goals

- Add new authentication mechanisms for OtterAI.
- Build a persistent Python service or daemon.
- Add user-configured output directories.
- Expand the main `otter` CLI surface in v1.
- Change the plugin's normalized speech schema.

## Script Location and Invocation

The bridge script will live at:

- `obsidian-otter-sync/utils/otter_sync.py`

It will accept the following required arguments:

- `--since <unix-seconds>`
- `--mode <scheduled|manual|forced>`
- `--output-dir <plugin-owned-output-dir>`

The plugin will invoke it using the existing command-template mechanism.

## Architecture

The bridge is a standalone Python script with five focused parts.

### 1. CLI entrypoint

Responsibilities:

- Parse and validate command-line arguments.
- Validate `mode` against `scheduled`, `manual`, and `forced`.
- Capture `fetched_until` at the beginning of the run.
- Exit non-zero for bridge-level failures.

### 2. Otter client adapter

Responsibilities:

- Construct and use the existing `otterai-api` client.
- Reuse the user's existing saved login/config.
- Fetch candidate speeches incrementally using `modified_after`.
- Fetch per-speech detail needed for transcript and summary normalization.

### 3. Normalizer

Responsibilities:

- Convert Otter responses into the plugin schema.
- Build canonical fields:
  - `otid`
  - `source_url`
  - `title`
  - `created_at`
  - `modified_time`
  - `attendees`
  - `summary_markdown`
  - `transcript_segments`

### 4. Payload writer

Responsibilities:

- Write the normalized payload to the plugin-owned output directory.
- Use timestamped unique filenames.
- Write atomically so the plugin never reads a partial file.

### 5. Logging

Responsibilities:

- Emit operational logs through Python `logging`.
- Log bridge-level start/end information, counts, and per-speech failures.
- Keep stdout reserved for the machine-readable envelope.

## Data Flow

1. Parse `--since`, `--mode`, and `--output-dir`.
2. Validate inputs and capture `fetched_until = int(time.time())`.
3. Create or load an authenticated `OtterAI` client using the repo's existing login/config behavior.
4. Fetch candidate speeches using `modified_after=since`.
5. For each speech, fetch additional detail as needed.
6. Normalize each successful speech into the plugin schema.
7. Skip and log per-speech failures without failing the full run.
8. Write the full payload to a JSON file in the plugin-owned output directory.
9. Print a small JSON envelope to stdout.

## Output Contract

### Payload file contents

The payload file will contain the full normalized object expected by the plugin:

```json
{
  "fetched_until": 1773246769,
  "speeches": [
    {
      "otid": "abc123",
      "source_url": "https://otter.ai/u/example",
      "title": "Meeting title",
      "created_at": 1773246000,
      "modified_time": 1773246769,
      "attendees": ["Alice", "Bob"],
      "summary_markdown": "## Summary\n...",
      "transcript_segments": [
        {
          "speaker_name": "Alice",
          "timestamp": "0:00",
          "text": "Hello"
        }
      ]
    }
  ]
}
```

### Stdout envelope

Stdout should remain small and machine-readable:

```json
{
  "payload_path": "/path/to/plugin-output/otter-sync-1773246769-12345.json",
  "fetched_until": 1773246769,
  "speech_count": 42
}
```

The plugin will read the envelope from stdout, then open and validate the payload file.

## Output Directory and File Lifecycle

The output directory is not user-configured. It is owned and supplied by the plugin through `--output-dir`.

### File naming

Use a timestamped unique file name such as:

- `otter-sync-<unix-ts>-<pid>.json`

### Cleanup behavior

- Default: plugin deletes payload files after successful processing.
- Debug option: plugin setting can disable successful-run deletion so payload files remain available for inspection.
- Parse or validation failures should keep the payload file regardless of the cleanup setting.

This means the bridge script only writes the file; the plugin owns retention and cleanup policy.

## Summary Markdown Normalization

The bridge script should normalize Otter summary data into one consistent markdown string.

Rules:

- If Otter provides structured summary data such as outline items or action items, convert it into markdown.
- Always emit `summary_markdown`, even when it is an empty string.
- Keep formatting stable so the plugin can treat the field as opaque markdown.

## Transcript Normalization

Each normalized transcript segment should include:

- `speaker_name`
- `timestamp`
- `text`

The bridge script should emit transcript segments in the order returned by Otter detail data, ready for the plugin renderer to format as:

- `Speaker timestamp`
- text on the next line

## Error Handling

### Bridge-level failures

The script should exit non-zero when any of the following occur:

- Invalid arguments
- Invalid `mode`
- Missing or unusable output directory
- Otter client setup/auth failure
- List-fetch failure that prevents speech discovery
- Payload-file write failure

These are command failures the plugin should treat as bridge errors.

### Per-speech failures

If a single speech detail fetch or normalization step fails:

- Log the failure with `logging`
- Skip that speech
- Continue processing remaining speeches

Only successfully normalized speeches are included in the payload file.

### Atomic writes

Write to a temporary file first, then atomically rename to the final payload path. This prevents the plugin from reading partial output.

## Logging

Use Python `logging` rather than `print` for operational visibility.

Guidelines:

- Log start/end of the run
- Log number of candidate speeches found
- Log number of successfully normalized speeches
- Log per-speech failures with `otid` when available
- Send logs to stderr or another non-stdout sink
- Keep stdout reserved for the final envelope only

## Plugin-side follow-up

This bridge script requires a small plugin-side contract update:

- Current plugin bridge expects the full payload on stdout.
- The plugin will need to accept a small stdout envelope, then read the payload file from `payload_path`.
- The plugin should also expose a cleanup toggle for successful payload-file deletion.

This is intentionally small and should be treated as part of the implementation plan for the bridge feature.

## Testing Strategy

### Python bridge tests

- Argument validation for `--since`, `--mode`, and `--output-dir`
- Stdout envelope shape
- Logging not polluting stdout
- Atomic payload write behavior
- Per-speech skip-on-failure behavior

### Normalization tests

- Summary formatting from structured Otter data to markdown
- Transcript segment normalization
- Attendee extraction and deduplication
- Empty and partial summary/transcript handling

### Library integration tests

- Mock `otterai-api` list and detail fetches
- Validate payload file contents against the plugin schema
- Validate stdout envelope points to the created payload file

### Plugin follow-up tests

- Verify plugin bridge reads the stdout envelope and loads the payload file
- Verify payload cleanup toggle behavior
- Verify payload file retention on parse/validation failure

## Recommended Direction

Use a standalone bridge script at `obsidian-otter-sync/utils/otter_sync.py` that writes the large normalized payload to a plugin-owned output directory and prints a small stdout envelope.

This keeps the transport reliable for large transcripts, keeps payloads inspectable for debugging, avoids extra user configuration, and fits the plugin contract with only a small plugin-side update.
