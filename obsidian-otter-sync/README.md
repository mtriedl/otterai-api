# Obsidian Otter Sync

This subproject contains the desktop-only Obsidian plugin scaffold for syncing OtterAI meetings into notes.

## Setup

1. Install plugin dependencies with `npm install --prefix obsidian-otter-sync`.
2. Build the plugin with `npm --prefix obsidian-otter-sync run build`.
3. In Obsidian desktop, open the plugin settings and configure:
   - Destination folder for synced notes
   - Python sync command template with bare `{since}` and `{mode}` placeholders
   - First-run and forced-sync backfill windows
   - Optional scheduled success notices

The plugin is desktop-only because it depends on local process execution. If process execution is unavailable, settings show a desktop-only warning and sync commands do not run.

## Diagnostics

The settings tab exposes the latest sync diagnostics so setup issues are easy to inspect:

- Last clean sync time
- Last fetch watermark
- Last sync error summary
- Recent sync diagnostics
- Copy debug info action with the command template redacted

See `docs/examples/obsidian-otter-sync-command.md` for the command template contract and failure expectations.
See `docs/superpowers/manual-verification/obsidian-otter-sync.md` for the manual verification checklist.

## Scripts

- `npm run test`
- `npm run build`
- `npm run dev`
