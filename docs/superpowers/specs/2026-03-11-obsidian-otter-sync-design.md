# Obsidian Otter Sync Plugin Design

## Overview

Build an Obsidian plugin in a new subdirectory of this repository that syncs OtterAI speeches into Obsidian meeting notes. The plugin runs on a schedule while Obsidian is open and also supports manual sync. It does not call Otter directly. Instead, it executes a user-configured Python command that uses the existing `otterai-api` package and returns normalized meeting data.

This design keeps Otter authentication and API access in Python, where the current repo already has working support for speech listing and incremental fetches using `modified_after` and `modified_time`. The Obsidian plugin remains responsible for scheduling, note discovery, note creation and update, sync state, and user-facing diagnostics.

## Goals

- Sync newly created or modified Otter meetings into Obsidian notes.
- Support automatic scheduled sync plus manual sync.
- Preserve user-authored note content during updates.
- Avoid duplicate notes by matching on Otter source URL.
- Minimize unnecessary updates by comparing Otter `modified_time` against note `sync_time`.
- Provide enough diagnostics to debug sync failures without cluttering the vault.

## Non-Goals

- Reimplement the Otter API in TypeScript.
- Store Otter credentials inside the Obsidian plugin.
- Rename existing note files when Otter titles change.
- Create a vault note for operational logs in v1.
- Run background sync while Obsidian is closed.

## User Experience

### Settings

The plugin settings screen should include:

- Destination folder for synced notes, for example `30 - Work/Meetings`.
- Python command to execute for sync, supplied by the user.
- Sync cadence, such as every hour.
- Default backfill window for first run.
- Manual forced-sync controls to choose a backfill window or explicit start date.
- Last successful sync time.
- Last sync error summary.
- Recent sync diagnostics with a copyable debug summary.

### Manual Sync Feedback

Manual sync should provide visible progress and final status notifications:

- Sync started.
- Fetching meetings.
- Writing notes.
- Completed.
- Failed.

The completion message should include counts for created, updated, skipped, and failed notes.

### Scheduled Sync Feedback

Scheduled sync should be quiet by default. Failures should surface through a notice and be recorded in diagnostics. Success notifications should be optional and off by default.

## Architecture

The plugin is split into focused units with clear responsibilities.

### 1. Sync Orchestrator

Responsibilities:

- Load settings and persisted sync state on startup.
- Register the manual `Sync now` command.
- Start and manage the periodic sync interval while Obsidian is open.
- Distinguish between scheduled sync, first-run sync, and manual forced sync.
- Prevent overlapping runs with a single-run lock.
- Advance `lastSuccessfulSync` only after a successful overall run.

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
- Parse JSON output.
- Validate that the returned payload conforms to the expected normalized schema.

Dependencies:

- Obsidian process execution APIs
- Payload validator

The bridge is intentionally thin. All Otter-specific fetching stays on the Python side.

### 3. Note Locator and Synchronizer

Responsibilities:

- Search the configured destination folder for notes with frontmatter `source` matching the Otter URL.
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
2. Compute fetch watermark as `lastSuccessfulSync - 86400`, clamped at zero.
3. Execute the configured Python command with that watermark.
4. Parse the returned normalized speeches.
5. Process each speech independently.
6. Record counts and diagnostics.
7. If the overall run succeeds, update `lastSuccessfulSync`.

### First Run and Forced Sync

On first run, or during a user-triggered forced sync, the plugin should allow a broader fetch window. The user can choose a backfill duration such as the last 7 or 30 days, or provide a custom start date. This computed fetch watermark replaces the normal incremental watermark for that run only.

Even during backfill, note matching and update rules remain the same:

- Create a note if none exists for the speech.
- Update an existing note only when `modified_time > sync_time`.
- Preserve user-owned content.

This allows safe re-discovery without destructive duplication.

## Python Bridge Contract

The plugin expects the Python command to emit normalized JSON for all speeches updated since the supplied watermark. The exact CLI shape can be finalized during implementation planning, but the returned data must include enough information for the plugin to stay independent from raw Otter response details.

Expected per-speech fields:

- `otid`
- `source_url`
- `title`
- `created_at`
- `modified_time`
- `attendees`
- `summary_markdown` or equivalent structured summary payload that can be rendered to markdown
- `transcript_segments`

Expected transcript segment fields:

- `speaker_name`
- `timestamp`
- `text`

If the command exits non-zero, emits invalid JSON, or returns malformed data, the run should fail with a diagnostic entry and a user-visible error for manual sync.

## Note Model

### File Naming

When creating a note, the plugin should name it:

`YYYY-MM-DD - Cleansed Meeting Title.md`

Where the date comes from Otter `created_at`.

Once created, the filename stays stable even if the Otter title later changes. The note header may still update to the latest cleansed meeting title.

### Frontmatter

Each synced note should include:

```yaml
---
date: 2026-05-02
type: meeting
attendees:
  - Speaker 1 Name
  - Speaker 2 Name
tags:
source: https://otter.ai/u/4ypoVqo4Z4ZUagOc-VfM7mugJIA
sync_time: 1773246769
---
```

Rules:

- `date`: from Otter `created_at`, formatted as `YYYY-MM-DD`
- `type`: fixed to `meeting`
- `attendees`: speaker list from the speech
- `tags`: present but user-managed unless later requirements define automatic values
- `source`: Otter URL containing the speech ID
- `sync_time`: Otter `modified_time` as a Unix timestamp

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

## Matching and Update Rules

### Existing Note Detection

The plugin should locate existing synced notes by scanning the configured destination folder for frontmatter `source` matching the Otter source URL. This is the canonical identity for sync behavior.

### Create Rule

If no note exists for a speech source, create a new note with the full frontmatter and body template.

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
- Created, updated, skipped, and failed counts
- Command executed
- Exit code
- Stderr snippet if available
- Number of speeches returned
- Top-level failure summary if any

Per-note failures should include:

- Speech `otid`
- Source URL
- Note path, if resolved
- Failure message

### Failure Semantics

- A fatal bridge failure should fail the overall run and must not advance `lastSuccessfulSync`.
- A per-note failure should be logged while allowing safe continuation for other notes.
- A partially successful run should report partial results clearly.

### User Debugging Support

The settings UI should expose recent run diagnostics and a `Copy last sync debug info` action so users can easily share actionable troubleshooting details.

## Testing Strategy

### Automated Tests

1. Python bridge tests
   - Command construction
   - First-run and forced backfill parameter handling
   - Stdout and stderr parsing
   - Invalid JSON handling
   - Non-zero exit handling
   - Schema validation

2. Note sync tests
   - New note creation
   - Existing note matching by `source`
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
   - Advancement of `lastSuccessfulSync`

5. Failure-path tests
   - Fatal bridge failures do not advance sync watermark
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
- The boundary between them is a normalized JSON contract that is easy to test.

## Open Items for Planning

These are implementation details to finalize in the next planning step:

- Exact plugin subdirectory name and scaffold shape
- Exact Python command interface and argument names
- JSON schema details for normalized summaries and transcripts
- Whether manual sync uses a command palette flow, modal, or settings action for choosing forced backfill values
- Exact test harness and tooling for the Obsidian plugin
