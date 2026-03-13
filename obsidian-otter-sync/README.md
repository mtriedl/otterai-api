# Obsidian Otter Sync

This subproject contains the desktop-only Obsidian plugin scaffold for syncing OtterAI meetings into notes.

## Setup

1. Install plugin dependencies with `npm install --prefix obsidian-otter-sync`.
2. Build the plugin with `npm --prefix obsidian-otter-sync run build`.
3. In Obsidian desktop, open the plugin settings and configure:
   - Destination folder for synced notes
   - Python sync command template with bare `{since}` and `{mode}` placeholders plus a writable `--output-dir`
   - First-run and forced-sync backfill windows
   - Optional payload cleanup after successful sync
   - Optional scheduled success notices

The plugin is desktop-only because it depends on local process execution. If process execution is unavailable, settings show a desktop-only warning and sync commands do not run.

## Diagnostics

The settings tab exposes the latest sync diagnostics so setup issues are easy to inspect:

- Last clean sync time
- Last fetch watermark
- Last sync error summary
- Recent sync diagnostics
- Copy debug info action with the command template redacted

The Python bridge contract is split across stdout and a payload file:

- Stdout must contain a JSON envelope with `payload_path`, `fetched_until`, and `speech_count`
- The file at `payload_path` must contain the validated `fetched_until` plus `speeches` payload consumed by the plugin
- The plugin keeps payload files on bridge parse, validation, load, and note-processing failures for debugging
- If `Delete payload files after successful sync` is enabled, the plugin deletes the payload file only after a successful sync

See `docs/examples/obsidian-otter-sync-command.md` for the command template contract and failure expectations.
See `docs/superpowers/manual-verification/obsidian-otter-sync.md` for the manual verification checklist.

## Scripts

- `npm run test`
- `npm run build`
- `npm run dev`
