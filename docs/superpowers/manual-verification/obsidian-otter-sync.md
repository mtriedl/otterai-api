# Obsidian Otter Sync Manual Verification

Use this checklist in an Obsidian desktop vault with the plugin enabled and a working Python bridge command.

## Checklist

1. Initial setup
   - Configure destination folder, command template, first-run backfill, and forced-sync backfill.
   - Confirm the command template includes `--output-dir` pointing at a writable directory for bridge payload files.
   - Confirm the desktop-only warning appears if local process execution is unavailable.
2. First-run backfill
   - Start with no saved plugin data.
   - Trigger the first sync and confirm the plugin uses the configured first-run backfill window.
   - Verify new meeting notes are created in the configured destination folder.
3. Manual sync feedback
   - Run `Sync now`.
   - Confirm a visible success or failure notice appears for the manual run.
   - Confirm stdout-only bridge envelopes do not surface raw speech payload JSON in notices or diagnostics.
4. Forced sync behavior
   - Run `Force sync now`.
   - Confirm the plugin uses the forced backfill window instead of the incremental watermark.
   - Verify the latest diagnostics mention a forced run.
5. Scheduled sync quiet success
   - Wait for a scheduled run with scheduled success notices disabled.
   - Confirm notes update as expected without a success popup.
6. Existing note update behavior
   - Re-run sync with one Otter meeting updated upstream.
   - Confirm the existing note is updated in place instead of creating a duplicate file.
7. User notes preservation
   - Add custom text under `## User Notes` in a synced note.
   - Re-run sync and confirm the custom text remains untouched.
8. Diagnostics after forced failure
   - Break the command template or return invalid JSON, then run `Force sync now`.
   - Confirm settings show the latest error summary, recent diagnostics, last fetch watermark state, and copy-debug-info output for troubleshooting.
   - Confirm the bridge payload file is retained when envelope parsing, payload loading, payload validation, or note processing fails.
9. Payload cleanup toggle
   - Enable `Delete payload files after successful sync` and run a successful sync.
   - Confirm the payload file referenced by the bridge envelope is deleted after the sync finishes successfully.
   - Disable the toggle and run another successful sync.
   - Confirm the payload file remains on disk when cleanup is disabled.
