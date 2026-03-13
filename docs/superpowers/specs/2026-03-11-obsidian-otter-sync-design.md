# Obsidian Otter Sync Plugin Design

## Overview

Build an Obsidian plugin in a new subdirectory of this repository that syncs OtterAI speeches into Obsidian meeting notes. The plugin runs on a schedule while Obsidian is open and also supports manual sync. It does not call Otter directly. Instead, it executes a user-configured Python command that uses the existing `otterai-api` package, prints a stdout envelope, and writes normalized meeting data into a payload file.

This design keeps Otter authentication and API access in Python, where the current repo already has working support for speech listing and incremental fetches using `modified_after` and `modified_time`. The Obsidian plugin remains responsible for scheduling, note discovery, note creation and update, sync state, payload-file cleanup, and user-facing diagnostics.

The plugin is explicitly desktop-only for v1 because it depends on local process execution to run the user-provided Python command. Mobile Obsidian clients should treat the plugin as unsupported and show a clear configuration error rather than attempting sync.

## Goals

- Sync newly created or modified Otter meetings into Obsidian notes.
- Support automatic scheduled sync plus manual sync.
- Preserve user-authored note content during updates.
- Avoid duplicate notes by matching on Otter speech identity.
- Minimize unnecessary updates by comparing Otter `modified_time` against note `sync_time`.
- Provide enough diagnostics to debug sync failures without cluttering the vault.

## Non-Goals

- Reimplement the Otter API in TypeScript.
- Store Otter credentials inside the Obsidian plugin.
- Rename existing note files when Otter titles change.
- Create a vault note for operational logs in v1.
- Run background sync while Obsidian is closed.

## User Experience

### v1 Scope

The implementation should prioritize a narrow v1 slice that is realistic for a repository that currently contains only the Python library:

- Plugin scaffold and build/test setup
- Settings tab with required sync configuration
- Manual `Sync now` command
- Scheduled sync while Obsidian desktop is open
- In-plugin diagnostics stored in plugin data and shown in settings
- Safe create/update behavior for meeting notes

The settings-based diagnostics view is sufficient for v1. A richer history browser, modal workflows, or advanced status UI is out of scope unless the minimal version is already working.

### Settings

The plugin settings screen should include:

- Destination folder for synced notes, for example `30 - Work/Meetings`.
- Python sync command template, supplied by the user.
- Sync cadence, such as every hour.
- Default backfill mode and value for first run.
- Forced-sync backfill mode and value, configured in settings as either a relative window or an explicit start date.
- Last clean sync time.
- Last sync error summary.
- Recent sync diagnostics with a copyable debug summary.
- Last fetch watermark and last clean sync time.

### Platform Support

The plugin supports Obsidian desktop only in v1. If local process execution is unavailable, the plugin should disable sync actions and show an explanatory error in settings and manual sync attempts.

### Manual Sync Feedback

Manual sync should provide visible progress and final status notifications:

- Sync started.
- Fetching meetings.
- Writing notes.
- Completed.
- Failed.

The completion message should include counts for created, updated, skipped, and failed notes.

For v1, the plugin should expose two command-palette actions:

- `Sync now`
- `Force sync now`

`Force sync now` uses the forced backfill values saved in settings rather than prompting in a modal. For v1, all backfill choices are made in settings, not at sync start time. This keeps the surface area small while still supporting recovery and initial backfill workflows.

### Scheduled Sync Feedback

Scheduled sync should be quiet by default. Failures should surface through a notice and be recorded in diagnostics. Success notifications should be optional and off by default.

## Architecture

The plugin is split into focused units with clear responsibilities.

### 1. Sync Orchestrator

Responsibilities:

- Load settings and persisted sync state on startup.
- Register the manual `Sync now` command.
- Register the manual `Force sync now` command.
- Start and manage the periodic sync interval while Obsidian is open.
- Distinguish between scheduled sync, first-run sync, and manual forced sync.
- Prevent overlapping runs with a single-run lock.
- Advance `lastFetchWatermark` after a successful bridge fetch.
- Advance `lastCleanSyncTime` only after a run with no bridge failure and no per-note failures.
- Persist a pending retry queue for speeches that fetched successfully but failed during note processing.

Dependencies:

- Settings store
- Python bridge
- Note synchronizer
- Diagnostics store

### 2. Python Bridge

Responsibilities:

- Execute the configured Python command.
- Pass sync parameters such as fetch watermark, run mode, and backfill overrides.
- Capture stdout, stderr, and process exit code.
- Parse the stdout envelope JSON.
- Load and validate the payload file referenced by the stdout envelope.

Dependencies:

- Obsidian process execution APIs
- Payload validator

The bridge is intentionally thin. All Otter-specific fetching stays on the Python side.

For v1, the bridge interface should be fixed rather than deferred. The plugin executes a configured command template with explicit required placeholders:

```text
<configured command template with {since} and {mode} placeholders plus --output-dir>
```

When the user chooses a forced backfill start date, the plugin substitutes that computed Unix timestamp into the `{since}` placeholder. The plugin does not pass secrets. The configured command may point to a script, module invocation, or shell wrapper as long as it accepts the substituted values, writes the normalized payload file into the configured `--output-dir`, and prints the stdout envelope JSON.

Execution model for v1:

- The setting is a full command template string, not a path plus separate args fields.
- The template must include `{since}` and `{mode}` placeholders.
- The template must also include `--output-dir` with a writable path.
- Before execution, the plugin substitutes those placeholders with platform-appropriate shell-escaped values.
- Users should include `{since}` and `{mode}` as bare placeholders, not pre-quoted placeholders. The plugin is responsible for quoting substituted values.
- If the template contains quoted placeholders such as `"{since}"` or `'{mode}'`, the plugin should treat that as a configuration error and refuse to run until the template is corrected.
- On macOS and Linux, the plugin executes the final command via `/bin/sh -lc`.
- On Windows, the plugin executes the final command via `cmd.exe /d /s /c`.
- Example: `python ~/bin/otter_sync.py --since {since} --mode {mode} --output-dir ~/.cache/obsidian-otter-sync`
- The plugin applies a fixed v1 timeout to the command execution, defaulting to 60 seconds.
- On timeout, the plugin terminates the child process, records a fatal bridge failure, surfaces an error for manual sync, and releases the single-run lock so future scheduled syncs can continue.

Allowed `{mode}` values for v1:

- `scheduled`: any timer-triggered run, including the first automatic run after plugin startup
- `manual`: a user-triggered `Sync now` run
- `forced`: a user-triggered `Force sync now` run that uses forced-backfill settings

There is no separate `first-run` mode in the bridge contract. First-run behavior affects only how the plugin computes `{since}`.

This makes quoting behavior explicit and lets users point at virtualenv-backed scripts, module invocations, or wrapper scripts without requiring the plugin to implement its own shell parser.

### 3. Note Locator and Synchronizer

Responsibilities:

- Search the configured destination folder for notes with frontmatter `otid` matching the Otter speech identifier.
- Create new notes when no match exists.
- Update existing notes only when Otter `modified_time` is newer than note `sync_time`.
- Preserve the `## User Notes` section.
- Rewrite managed frontmatter and sections when needed.
- Keep the original filename stable after creation.

Dependencies:

- Obsidian vault APIs
- Markdown renderer
- Frontmatter parser

### 4. Content Normalizer and Renderer

Responsibilities:

- Cleanse meeting titles for filenames and headers.
- Render summary material into proper markdown.
- Normalize attendees from speaker names.
- Render transcript blocks as speaker plus timestamp on one line and utterance text on the next line.
- Build note content with a fixed section order.

### 5. Diagnostics Store

Responsibilities:

- Persist last run status and recent run history in plugin data.
- Record top-level failures and per-note failures.
- Expose copyable debug information in settings.

## Sync Data Flow

### Scheduled Sync

1. Load plugin settings and persisted sync state.
2. Compute fetch watermark as `lastFetchWatermark - 86400`, clamped at zero.
3. Execute the configured Python command with that watermark.
4. Parse the returned stdout envelope and load the normalized speeches from the payload file.
5. Update `lastFetchWatermark` from the bridge payload's `fetched_until` value after a successful bridge fetch.
6. Merge fresh speeches with `pendingRetries`, keyed by `otid`, preferring the freshest payload by `modified_time`.
7. Process the merged set of speeches independently.
8. Add any per-note failures back to `pendingRetries`.
9. Record counts and diagnostics.
10. If the run has no bridge failure and no per-note failures, update `lastCleanSyncTime`.

### First Run and Forced Sync

On first run, or during a user-triggered forced sync, the plugin should allow a broader fetch window. In v1, the user defines these backfill values in settings, either as a duration such as the last 7 or 30 days or as a custom start date. This computed fetch watermark replaces the normal incremental watermark for that run only.

Even during backfill, note matching and update rules remain the same:

- Create a note if none exists for the speech.
- Update an existing note only when `modified_time > sync_time`.
- Preserve user-owned content.

This allows safe re-discovery without destructive duplication.

## Python Bridge Contract

The plugin expects the Python command to emit a small stdout envelope for all speeches updated since the supplied watermark and to write the normalized meeting payload into a file. The CLI shape is fixed in this spec so implementation and testing can target one contract.

The command interface is fixed for v1:

```text
<configured command template with {since} and {mode} placeholders plus --output-dir>
```

The command must write exactly one JSON object to stdout and use stderr for diagnostics. Any non-JSON stdout output is a contract violation and causes the run to fail.

Expected stdout envelope shape:

```json
{
  "payload_path": "/Users/example/.cache/obsidian-otter-sync/payload.json",
  "fetched_until": 1773246769,
  "speech_count": 0
}
```

Stdout envelope rules:

- `payload_path` is a required non-empty string path to a JSON payload file.
- `fetched_until` is a required Unix-seconds watermark representing the upper bound that the Python fetch covered.
- `speech_count` is a required integer count of payload speeches.
- After a successful bridge fetch, the plugin persists `lastFetchWatermark = fetched_until`.
- The Python side should set `fetched_until` to the time immediately before it begins the upstream fetch sequence so the next incremental run can safely query from `lastFetchWatermark - 86400`.
- Stdout should contain only the envelope. Speech data belongs in the payload file, not stdout.

Expected payload file shape:

```json
{
  "fetched_until": 1773246769,
  "speeches": []
}
```

Payload field rules:

- The plugin reads the file at `payload_path` after envelope validation.
- The payload file must contain the normalized `fetched_until` watermark and `speeches` array.
- The payload file must be valid JSON. Malformed or unreadable payload files fail the run.

Expected per-speech fields and types:

- `otid` as a non-empty string
- `source_url` as a non-empty string
- `title` as a string, allowing empty input but normalized by the Python side to a non-empty fallback such as `Untitled Meeting`
- `created_at` as Unix seconds
- `modified_time` as Unix seconds
- `attendees` as an array of speaker name strings
- `summary_markdown` as a markdown string, allowing empty content
- `transcript_segments` as an array ordered by ascending transcript position

Expected transcript segment fields and types:

- `speaker_name` as a non-empty string, or a normalized fallback such as `Unknown Speaker`
- `timestamp` as a display string such as `0:05`
- `text` as a string, allowing empty content

Null values are not allowed for required fields in the normalized payload. The Python side should convert upstream missing values into explicit fallback strings or empty arrays before writing the payload.

Canonical identity rules:

- `otid` is the canonical identity for sync decisions.
- `source_url` is written to note frontmatter `source` for readability and linkability.
- The plugin writes `otid` directly into note frontmatter and uses that field as the primary matcher.
- If an older synced note has no `otid` field, the plugin may attempt a one-time migration by parsing the speech ID from `source`. If parsing fails, the plugin should treat that note as invalid for automatic updates and record a diagnostic rather than guessing.

All note detection, duplicate handling, updates, and retry deduplication should use `otid` as the canonical identity. Raw `source_url` string equality is not used as the primary matcher.

If the command exits non-zero, emits invalid stdout JSON, returns an invalid stdout envelope, cannot produce a readable payload file, or returns malformed payload data, the run should fail with a diagnostic entry and a user-visible error for manual sync.

Persisted sync state for v1:

- `lastFetchWatermark`: last successfully fetched upper-bound timestamp from the Python bridge
- `lastCleanSyncTime`: local timestamp of the most recent run with no bridge failure and no per-note failures
- `pendingRetries`: queued failed note-processing entries to replay on the next run

Retry entry shape for `pendingRetries`:

- `otid`
- `source_url`
- `title`
- `created_at`
- `modified_time`
- `attendees`
- `summary_markdown`
- `transcript_segments`
- `failure_reason`
- `last_attempted_at`

Retry queue rules:

- Retry entries are keyed by `otid`.
- If the same `otid` fails again, the plugin replaces the existing retry entry with the newest normalized payload and failure details.
- If a retry succeeds, the entry is removed immediately.
- If a fresh fetch returns a newer payload for an `otid` already in the retry queue, the plugin replaces the queued entry before attempting note processing.
- Retry replay uses the same create/update logic as fresh fetch results.

## Note Model

### File Naming

When creating a note, the plugin should name it:

`YYYY-MM-DD - Cleansed Meeting Title.md`

Where the date comes from Otter `created_at`.

Once created, the filename stays stable even if the Otter title later changes. The note header may still update to the latest cleansed meeting title.

If that filename already exists for a different note, the plugin should create a collision-safe variant by appending ` - <short-otid>` before `.md`, where `<short-otid>` is a stable truncated prefix of the speech `otid`.

### Frontmatter

Each synced note should include:

```yaml
---
otid: jqb7OHo6mrHtCuMkyLN0nUS8mxY
date: 2026-05-02
type: meeting
attendees:
  - Speaker 1 Name
  - Speaker 2 Name
tags: []
source: https://otter.ai/u/4ypoVqo4Z4ZUagOc-VfM7mugJIA
sync_time: 1773246769
---
```

Rules:

- `otid`: canonical Otter speech identifier used for matching and duplicate detection
- `date`: from Otter `created_at`, formatted as `YYYY-MM-DD`
- `type`: fixed to `meeting`
- `attendees`: speaker list from the speech
- `tags`: created as an empty YAML list `[]` and then treated as fully user-managed
- `source`: Otter URL containing the speech ID
- `sync_time`: Otter `modified_time` as a Unix timestamp

Frontmatter preservation rules on update:

- The plugin updates only synchronized keys: `otid`, `date`, `type`, `attendees`, `source`, and `sync_time`.
- The plugin preserves user-managed keys, including `tags`, and preserves any unknown frontmatter keys already present on the note.
- The plugin treats `type` as strictly managed and restores it to `meeting` on update if it differs.

### Body Structure

Each note should use this layout:

```markdown
# Meeting Title

## User Notes

## Summary

...managed Otter summary markdown...

## Transcript

Speaker 1 Name 0:00
Welcome to my meeting today

Speaker 2 Name 0:05
Glad to be here
```

Ownership rules:

- `## User Notes` is user-owned and never overwritten by sync.
- `## Summary` is plugin-managed.
- `## Transcript` is plugin-managed.

On update, the plugin should replace only the managed content plus synchronized frontmatter fields.

Section handling rules:

- The plugin identifies sections by exact headings: `## User Notes`, `## Summary`, and `## Transcript`.
- If all three headings are present exactly once, the plugin preserves the content between `## User Notes` and the next managed heading, then rewrites the managed sections in place.
- If `## User Notes` appears exactly once but `## Summary` or `## Transcript` is missing, duplicated, or renamed, the plugin should preserve the content under the single exact `## User Notes` heading and rewrite the rest of the document into the canonical section order, logging that the note was normalized.
- If `## User Notes` does not appear exactly once with that exact heading text, the plugin should skip updating that note and record a per-note failure rather than risk overwriting user content.

## Matching and Update Rules

### Existing Note Detection

The plugin should locate existing synced notes by scanning the configured destination folder and comparing each note's frontmatter `otid` to the returned `otid`. If `otid` is missing, it may attempt a one-time migration from `source` as described above.

If multiple notes in the destination folder share the same `otid`, the plugin should treat that as a duplicate-note error. It should not guess which file is canonical. The speech should be skipped for that run and a per-note diagnostic should be recorded listing the conflicting note paths.

### Create Rule

If no note exists for a speech `otid`, create a new note with the full frontmatter and body template.

If the configured destination folder does not exist, the plugin should create it before writing notes. If folder creation fails, the run should record a fatal diagnostic and stop before note processing.

### Update Rule

If a note exists:

- Read its `sync_time` from frontmatter.
- If Otter `modified_time` is newer, update synchronized frontmatter fields and rewrite `# Title`, `## Summary`, and `## Transcript`.
- If Otter `modified_time` is not newer, skip the note.

### Title Change Rule

If the Otter title changes after note creation:

- Do not rename the file.
- Update the main header text during note refresh.

## Error Handling and Diagnostics

### Logging Strategy

Diagnostics should live in plugin data, not in vault notes. Keep a rolling history, for example the last 20 runs.

Each run record should include:

- Run mode: scheduled, manual, or forced
- Start and end time
- Fetch watermark used
- Fetched-until watermark returned by the bridge
- Whether retry queue entries were replayed
- Created, updated, skipped, and failed counts
- Command label or redacted command summary
- Exit code
- Stderr snippet if available
- Number of speeches returned
- Top-level failure summary if any

Diagnostics must never persist the raw configured command if it could contain inline secrets or environment variables. Instead, store a safe summary such as the executable basename plus whether placeholder substitution succeeded.

Per-note failures should include:

- Speech `otid`
- Source URL
- Note path, if resolved
- Failure message

### Failure Semantics

- A fatal bridge failure should fail the overall run and must not advance `lastFetchWatermark` or `lastCleanSyncTime`.
- A per-note failure should be logged while allowing safe continuation for other notes.
- A successful bridge fetch should advance `lastFetchWatermark` even if one or more note writes fail.
- A partially successful run should report partial results clearly and must not advance `lastCleanSyncTime`.
- Per-note failures must be added to the pending retry queue so they can be retried on the next run without freezing the incremental fetch watermark.
- The plugin keeps the payload file when envelope parsing, payload loading, payload validation, or note processing fails so the user can inspect what the bridge produced.
- When the `Delete payload files after successful sync` setting is enabled, the plugin deletes the payload file only after a fully successful sync.

### User Debugging Support

The settings UI should expose recent run diagnostics and a `Copy last sync debug info` action so users can easily share actionable troubleshooting details.

## Testing Strategy

### Automated Tests

1. Python bridge tests
   - Command construction
   - First-run and forced backfill parameter handling
   - Stdout envelope and stderr parsing
   - Payload file loading and validation
   - Invalid JSON handling
   - Non-zero exit handling
   - Schema validation

2. Note sync tests
   - New note creation
   - Existing note matching by `otid`
   - Skip when `modified_time <= sync_time`
   - Update when `modified_time > sync_time`
   - Preserve `## User Notes`
   - Stable filename after title changes

3. Rendering tests
   - Frontmatter formatting
   - Summary markdown formatting
   - Transcript formatting
   - Attendee normalization
   - Title cleansing

4. Orchestrator tests
   - Startup scheduling
   - Single-run lock behavior
   - Manual progress states
   - First-run default backfill
   - Forced sync custom backfill
   - Advancement of `lastFetchWatermark` and `lastCleanSyncTime`

5. Failure-path tests
   - Fatal bridge failures do not advance persisted sync state
   - Per-note failures are recorded
   - Successful notes still write when safe
   - Result summaries are accurate

### Manual Verification

Implementation should also include a short manual verification checklist in Obsidian covering:

- Initial setup
- First-run backfill
- Manual sync feedback
- Scheduled sync behavior
- Existing note update behavior
- Preservation of `## User Notes`
- Diagnostics visibility after a forced failure

## Risks and Mitigations

- Python environment misconfiguration
   - Mitigation: strong command validation, stderr capture, and clear setup guidance.

- Payload file accumulation on disk
  - Mitigation: configurable cleanup after successful sync, while retaining failed payloads for debugging.

- Otter payload inconsistencies
  - Mitigation: validate normalized JSON at the bridge boundary and degrade gracefully on per-note failures.

- User edits inside managed sections
  - Mitigation: clearly define `## User Notes` as the safe editable area and treat summary/transcript as managed content.

- Large first-run syncs
  - Mitigation: configurable backfill window plus visible progress and result counts.

## Recommended Implementation Direction

Use the plugin-plus-user-provided-Python-command approach.

This gives the smallest viable architecture for v1:

- Obsidian handles UX, scheduling, vault operations, and state.
- Python handles Otter access using the existing library and saved credentials.
- The boundary between them is a stdout-envelope-plus-payload-file JSON contract that is easy to test.

## Open Items for Planning

These are implementation details to finalize in the next planning step:

- Exact plugin subdirectory name and scaffold shape
- Exact test harness and tooling for the Obsidian plugin
