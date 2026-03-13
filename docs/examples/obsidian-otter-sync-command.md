# Obsidian Otter Sync Command Template

Use the plugin setting as a full command template. The plugin replaces `{since}` and `{mode}` with shell-escaped values immediately before execution.

## Template rules

- Include both bare placeholders: `{since}` and `{mode}`
- Do not pre-quote placeholders such as `"{since}"` or `'{mode}'`
- The plugin executes the rendered command through `/bin/sh -lc` on macOS/Linux and `cmd.exe /d /s /c` on Windows
- `{mode}` is one of `scheduled`, `manual`, or `forced`
- `{since}` is the computed Unix timestamp used for the fetch window

## Example template

```text
python ~/bin/otter_sync.py --since {since} --mode {mode} --format json
```

Example rendered command for a forced sync:

```text
python ~/bin/otter_sync.py --since '1710000001' --mode 'forced' --format json
```

## JSON bridge contract

The command must print one JSON object to stdout with this shape:

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
- The process cannot start or exits non-zero
- The process times out
- Stdout is not valid JSON
- The JSON payload misses required fields or uses the wrong types

Failure behavior:

- Manual sync surfaces an Obsidian notice with the failure summary
- Scheduled sync records diagnostics and continues trying again on the next cadence
- The last sync error summary remains visible in settings until a later failure replaces it
- Copy debug info includes settings, state, and diagnostics while redacting the command template body
