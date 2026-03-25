# Obsidian Otter Sync Command Template

Use the plugin setting as a full command template. The plugin replaces `{since}` and `{mode}` with shell-escaped values immediately before execution.

## Template rules

- Include both bare placeholders: `{since}` and `{mode}`
- Include `--output-dir` with a writable directory path for bridge payload files
- Do not pre-quote placeholders such as `"{since}"` or `'{mode}'`
- The plugin executes the rendered command through `/bin/sh -lc` on macOS/Linux and `cmd.exe /d /s /c` on Windows
- `{mode}` is one of `scheduled`, `manual`, or `forced`
- `{since}` is the computed Unix timestamp used for the fetch window
- The bridge is responsible for creating the `--output-dir` directory when it does not exist

## Example template

```text
~/Documents/GitHub/otterai-api/.venv/bin/python ~/Documents/GitHub/otterai-api/obsidian-otter-sync/utils/otter_sync.py --since {since} --mode {mode} --output-dir ~/.cache/obsidian-otter-sync
```

Example rendered command for a forced sync:

```text
~/Documents/GitHub/otterai-api/.venv/bin/python ~/Documents/GitHub/otterai-api/obsidian-otter-sync/utils/otter_sync.py --since '1710000001' --mode 'forced' --output-dir ~/.cache/obsidian-otter-sync
```

## Stdout envelope contract

The command must print one JSON object to stdout with this shape:

```json
{
  "payload_path": "/Users/example/.cache/obsidian-otter-sync/payload.json",
  "fetched_until": 1710003601,
  "speech_count": 1
}
```

Required fields:

- `payload_path`: non-empty string path to the JSON payload file
- `fetched_until`: integer watermark for the current fetch
- `speech_count`: integer count of payload speeches

Field expectations:

- Stdout should contain only the envelope JSON; speech data belongs in the payload file
- `payload_path` should point at the payload file written for this run

## Payload file contract

The plugin treats the file at `payload_path` as the canonical meeting payload. The file contents must be one JSON object with this shape:

```json
{
  "fetched_until": 1710003601,
  "speeches": [
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
          "timestamp": "00:00",
          "text": "Welcome back everyone."
        }
      ]
    }
  ]
}
```

Required fields:

- Top level: `fetched_until`, `speeches`
- Per speech: `otid`, `source_url`, `title`, `created_at`, `modified_time`, `attendees`, `summary_markdown`, `transcript_segments`
- Per transcript segment: `speaker_name`, `timestamp`, `text`

Field expectations:

- `fetched_until`, `created_at`, and `modified_time` must be integers
- `attendees` must be an array of strings
- `summary_markdown` may be an empty string, but it must still be present
- `transcript_segments` must be an array, even when empty
- `speaker_name` and `timestamp` must be non-empty strings
- `text` must be a string

## Failure expectations

The plugin treats the command as failed when any of the following happen:

- The command template is empty, missing `{since}` or `{mode}`, or quotes either placeholder
- The command omits `--output-dir` and the bridge exits with an argument error
- The process cannot start or exits non-zero
- The process times out
- Stdout is not valid JSON
- The stdout envelope misses `payload_path`, `fetched_until`, or `speech_count`, or uses the wrong types
- The payload file cannot be read
- The payload file is not valid JSON
- The payload JSON misses required fields or uses the wrong types

Failure behavior:

- Manual sync surfaces an Obsidian notice with the failure summary
- Scheduled sync records diagnostics and continues trying again on the next cadence
- The last sync error summary remains visible in settings until a later failure replaces it
- Copy debug info includes settings, state, and diagnostics while redacting the command template body
- The plugin keeps the payload file when envelope parsing, payload loading, payload validation, or note processing fails
- When the `Delete payload files after successful sync` setting is enabled, the plugin removes the payload file only after a fully successful sync
