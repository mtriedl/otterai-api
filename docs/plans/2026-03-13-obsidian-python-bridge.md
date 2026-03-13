# Obsidian Python Bridge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the missing Python bridge script for the Obsidian Otter Sync plugin and update the plugin bridge to consume a file-backed payload contract.

**Architecture:** Add a standalone Python script at `obsidian-otter-sync/utils/otter_sync.py` that fetches incremental Otter speeches, normalizes them into the plugin schema, writes the full payload to a plugin-owned output directory, and prints a small stdout envelope. Update the plugin's TypeScript bridge so it parses the envelope, loads and validates the payload file, and respects a cleanup toggle for successful payload processing.

**Tech Stack:** Python, pytest, `otterai-api`, TypeScript, Vitest, Node child-process APIs, Obsidian plugin APIs

---

## File Structure

- Create: `obsidian-otter-sync/utils/otter_sync.py` - Python bridge CLI entrypoint, fetch adapter, normalization, logging, payload file writing
- Create: `tests/test_obsidian_bridge_script.py` - Python tests for the bridge script
- Modify: `obsidian-otter-sync/src/settings.ts` - add payload cleanup toggle and plugin-owned output-dir helpers if needed
- Modify: `obsidian-otter-sync/src/settings-tab.ts` - add payload cleanup toggle UI text
- Modify: `obsidian-otter-sync/src/sync/python-bridge.ts` - switch stdout contract from full payload JSON to envelope + payload file loading
- Modify: `obsidian-otter-sync/src/sync/schema.ts` - add schema for stdout envelope if kept separate from payload parser, or companion validator helpers
- Modify: `obsidian-otter-sync/src/sync/orchestrator.ts` - pass plugin-owned output dir into the bridge command contract if needed and apply cleanup policy after consume
- Modify: `obsidian-otter-sync/tests/python-bridge.test.ts` - update plugin bridge tests to cover envelope + file consumption and cleanup behavior
- Modify: `obsidian-otter-sync/tests/settings-tab.test.ts` - cover payload cleanup toggle
- Modify: `obsidian-otter-sync/tests/settings.test.ts` - cover default cleanup-toggle setting
- Modify: `docs/examples/obsidian-otter-sync-command.md` - align command docs with the implemented bridge invocation and stdout envelope

## Implementation Notes

- The Python script should reuse the repo's existing `otterai-api` auth/config flow rather than introducing new credentials.
- Stdout must remain a small JSON envelope only.
- Logging must never pollute stdout.
- The plugin-owned output directory should be passed to the script via `--output-dir`.
- The plugin should normally delete payload files after successful processing, but preserve them when the new cleanup toggle is disabled.
- If the plugin cannot parse or validate the payload file, it should leave the file behind regardless of the cleanup toggle.

### Task 1: Add the Python bridge CLI skeleton and stdout envelope contract

**Files:**
- Create: `obsidian-otter-sync/utils/otter_sync.py`
- Test: `tests/test_obsidian_bridge_script.py`

**Step 1: Write the failing CLI argument test**

```python
def test_requires_since_mode_and_output_dir(runner):
    result = runner.invoke(main, [])
    assert result.exit_code != 0
    assert '--since' in result.output
```

**Step 2: Write the failing stdout envelope test**

```python
def test_writes_stdout_envelope_with_payload_path(tmp_path, monkeypatch):
    result = runner.invoke(main, ['--since', '1710000000', '--mode', 'manual', '--output-dir', str(tmp_path)])
    envelope = json.loads(result.output)
    assert envelope['payload_path'].startswith(str(tmp_path))
    assert 'fetched_until' in envelope
```

**Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_obsidian_bridge_script.py -v`
Expected: FAIL because `obsidian-otter-sync/utils/otter_sync.py` does not exist yet

**Step 4: Write the minimal Python CLI skeleton**

```python
import argparse
import json
import logging
import os
import tempfile
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument('--since', required=True, type=int)
    parser.add_argument('--mode', required=True, choices=['scheduled', 'manual', 'forced'])
    parser.add_argument('--output-dir', required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    fetched_until = int(time.time())
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    payload_path = output_dir / f'otter-sync-{fetched_until}-{os.getpid()}.json'
    payload_path.write_text(json.dumps({'fetched_until': fetched_until, 'speeches': []}), encoding='utf-8')
    print(json.dumps({'payload_path': str(payload_path), 'fetched_until': fetched_until, 'speech_count': 0}))
    return 0
```

**Step 5: Run the targeted tests again**

Run: `uv run pytest tests/test_obsidian_bridge_script.py -v`
Expected: PASS

**Step 6: Commit**

```bash
git add obsidian-otter-sync/utils/otter_sync.py tests/test_obsidian_bridge_script.py
git commit -m "feat: add Obsidian bridge CLI scaffold"
```

### Task 2: Implement Otter fetch adapter and payload normalization

**Files:**
- Modify: `obsidian-otter-sync/utils/otter_sync.py`
- Test: `tests/test_obsidian_bridge_script.py`

**Step 1: Write the failing incremental fetch test**

```python
def test_fetches_speeches_with_modified_after(monkeypatch, tmp_path):
    mock_client = Mock()
    monkeypatch.setattr(module_under_test, 'build_client', lambda: mock_client)
    mock_client.get_speeches.return_value = {'data': {'speeches': []}}

    main(['--since', '1710000000', '--mode', 'manual', '--output-dir', str(tmp_path)])

    mock_client.get_speeches.assert_called_once_with(modified_after=1710000000)
```

**Step 2: Write the failing normalization test**

```python
def test_normalizes_speech_detail_into_plugin_schema(tmp_path, monkeypatch):
    mock_client = make_mock_client_with_speech_and_detail()
    monkeypatch.setattr(module_under_test, 'build_client', lambda: mock_client)

    main(['--since', '1710000000', '--mode', 'manual', '--output-dir', str(tmp_path)])

    payload = json.loads(Path(json.loads(captured_stdout)['payload_path']).read_text())
    speech = payload['speeches'][0]
    assert speech['otid'] == 'speech-1'
    assert speech['source_url'].startswith('https://otter.ai/u/')
    assert isinstance(speech['transcript_segments'], list)
```

**Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_obsidian_bridge_script.py -v`
Expected: FAIL because fetch/normalization are not implemented yet

**Step 4: Implement client adapter and normalizers**

```python
def build_client() -> OtterAI:
    return OtterAI()


def normalize_speech(summary_data, detail_data) -> dict:
    return {
        'otid': summary_data['otid'],
        'source_url': build_source_url(summary_data['otid']),
        'title': normalize_title(summary_data.get('title')),
        'created_at': int(summary_data['created_at']),
        'modified_time': int(summary_data['modified_time']),
        'attendees': normalize_attendees(detail_data),
        'summary_markdown': build_summary_markdown(detail_data),
        'transcript_segments': build_transcript_segments(detail_data),
    }
```

**Step 5: Run the targeted Python tests**

Run: `uv run pytest tests/test_obsidian_bridge_script.py -v`
Expected: PASS

**Step 6: Commit**

```bash
git add obsidian-otter-sync/utils/otter_sync.py tests/test_obsidian_bridge_script.py
git commit -m "feat: normalize Otter bridge payload"
```

### Task 3: Handle per-speech failures, logging, and atomic payload writes

**Files:**
- Modify: `obsidian-otter-sync/utils/otter_sync.py`
- Test: `tests/test_obsidian_bridge_script.py`

**Step 1: Write the failing per-speech skip test**

```python
def test_skips_failed_speech_detail_and_continues(tmp_path, monkeypatch, caplog):
    mock_client = make_mock_client_with_one_good_and_one_bad_speech()
    monkeypatch.setattr(module_under_test, 'build_client', lambda: mock_client)

    main(['--since', '1710000000', '--mode', 'manual', '--output-dir', str(tmp_path)])

    payload = load_payload_from_stdout(captured_stdout)
    assert len(payload['speeches']) == 1
    assert 'failed to normalize speech' in caplog.text
```

**Step 2: Write the failing atomic write test**

```python
def test_writes_payload_atomically(tmp_path, monkeypatch):
    result = main(['--since', '1710000000', '--mode', 'manual', '--output-dir', str(tmp_path)])
    assert not any(path.name.endswith('.tmp') for path in tmp_path.iterdir())
```

**Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_obsidian_bridge_script.py -v`
Expected: FAIL on per-speech skip/logging and atomic write expectations

**Step 4: Implement skip-on-failure logging and atomic writes**

```python
with tempfile.NamedTemporaryFile('w', delete=False, dir=output_dir, suffix='.tmp', encoding='utf-8') as handle:
    json.dump(payload, handle)
    temp_path = Path(handle.name)

temp_path.replace(payload_path)
```

```python
for speech in candidate_speeches:
    try:
        normalized.append(normalize_speech(speech, fetch_detail(...)))
    except Exception as error:
        logger.exception('failed to normalize speech %s', speech.get('otid'))
```

**Step 5: Run the targeted Python tests**

Run: `uv run pytest tests/test_obsidian_bridge_script.py -v`
Expected: PASS

**Step 6: Commit**

```bash
git add obsidian-otter-sync/utils/otter_sync.py tests/test_obsidian_bridge_script.py
git commit -m "fix: harden bridge payload writing"
```

### Task 4: Update plugin bridge to consume envelope + payload file

**Files:**
- Modify: `obsidian-otter-sync/src/sync/python-bridge.ts`
- Modify: `obsidian-otter-sync/src/sync/schema.ts`
- Modify: `obsidian-otter-sync/tests/python-bridge.test.ts`

**Step 1: Write the failing envelope test**

```ts
it('reads the payload file from the stdout envelope', async () => {
  const result = await runBridgeCommand({
    commandTemplate: makeEnvelopeTemplate(payloadPath),
    since: '1710000000',
    mode: 'manual',
  })

  expect(result.payload.speeches[0]?.otid).toBe('speech-1')
})
```

**Step 2: Write the failing cleanup-toggle-aware parse failure test**

```ts
it('keeps payload files when payload parsing fails', async () => {
  await expect(runBridgeCommand(...)).rejects.toMatchObject({ name: 'PythonBridgeSchemaError' })
  expect(fileStillExists(payloadPath)).toBe(true)
})
```

**Step 3: Run tests to verify they fail**

Run: `npm --prefix obsidian-otter-sync test -- python-bridge.test.ts`
Expected: FAIL because plugin bridge still expects full payload JSON on stdout

**Step 4: Implement stdout envelope parsing and payload-file loading**

```ts
interface BridgeEnvelope {
  payload_path: string
  fetched_until: number
  speech_count?: number
}

const envelope = JSON.parse(stdout) as BridgeEnvelope
const payloadText = await readFile(envelope.payload_path, 'utf8')
const payload = validateBridgePayload(JSON.parse(payloadText))
```

**Step 5: Run the targeted plugin bridge tests**

Run: `npm --prefix obsidian-otter-sync test -- python-bridge.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add obsidian-otter-sync/src/sync/python-bridge.ts obsidian-otter-sync/src/sync/schema.ts obsidian-otter-sync/tests/python-bridge.test.ts
git commit -m "feat: load bridge payloads from files"
```

### Task 5: Add plugin payload cleanup toggle and wire cleanup policy

**Files:**
- Modify: `obsidian-otter-sync/src/settings.ts`
- Modify: `obsidian-otter-sync/src/settings-tab.ts`
- Modify: `obsidian-otter-sync/src/sync/orchestrator.ts`
- Modify: `obsidian-otter-sync/tests/settings.test.ts`
- Modify: `obsidian-otter-sync/tests/settings-tab.test.ts`
- Modify: `obsidian-otter-sync/tests/orchestrator.test.ts`

**Step 1: Write the failing default-setting test**

```ts
it('defaults to deleting payload files after successful processing', () => {
  expect(DEFAULT_SETTINGS.deleteProcessedPayloadFiles).toBe(true)
})
```

**Step 2: Write the failing settings-tab test**

```ts
it('renders a payload cleanup toggle in settings', () => {
  tab.display()
  expect(containerEl.textContent).toContain('Delete payload files after successful processing')
})
```

**Step 3: Write the failing orchestrator cleanup test**

```ts
it('keeps payload files when cleanup is disabled', async () => {
  await orchestrator.run('manual')
  expect(deleteFileMock).not.toHaveBeenCalled()
})
```

**Step 4: Run tests to verify they fail**

Run: `npm --prefix obsidian-otter-sync test -- settings.test.ts settings-tab.test.ts orchestrator.test.ts`
Expected: FAIL because cleanup toggle and cleanup policy do not exist yet

**Step 5: Implement cleanup toggle and policy**

```ts
export interface OtterSyncSettings {
  // ...existing fields...
  deleteProcessedPayloadFiles: boolean
}
```

```ts
export const DEFAULT_SETTINGS = {
  // ...existing defaults...
  deleteProcessedPayloadFiles: true,
}
```

**Step 6: Run the targeted tests**

Run: `npm --prefix obsidian-otter-sync test -- settings.test.ts settings-tab.test.ts orchestrator.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add obsidian-otter-sync/src/settings.ts obsidian-otter-sync/src/settings-tab.ts obsidian-otter-sync/src/sync/orchestrator.ts obsidian-otter-sync/tests/settings.test.ts obsidian-otter-sync/tests/settings-tab.test.ts obsidian-otter-sync/tests/orchestrator.test.ts
git commit -m "feat: add payload cleanup toggle"
```

### Task 6: Update docs and run full verification

**Files:**
- Modify: `docs/examples/obsidian-otter-sync-command.md`
- Modify: `obsidian-otter-sync/README.md`

**Step 1: Write the failing docs verification step**

```text
Check that docs mention:
- --output-dir
- stdout envelope with payload_path
- payload cleanup toggle
```

**Step 2: Update docs to match implemented bridge contract**

```md
python /path/to/otter_sync.py --since {since} --mode {mode} --output-dir /path/to/plugin/temp
```

**Step 3: Run Python bridge tests**

Run: `uv run pytest tests/test_obsidian_bridge_script.py -v`
Expected: PASS

**Step 4: Run plugin tests**

Run: `npm --prefix obsidian-otter-sync test`
Expected: PASS

**Step 5: Run plugin build**

Run: `npm --prefix obsidian-otter-sync run build`
Expected: PASS

**Step 6: Commit**

```bash
git add docs/examples/obsidian-otter-sync-command.md obsidian-otter-sync/README.md
git commit -m "docs: update Python bridge setup"
```
