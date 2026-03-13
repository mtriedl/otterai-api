# Obsidian Otter Sync Plugin Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a desktop-only Obsidian plugin that syncs OtterAI speeches into meeting notes using a user-configured Python command template.

**Architecture:** Add a self-contained Obsidian plugin project under a new repo subdirectory, with small TypeScript modules for settings/state, command execution, sync orchestration, note rendering, and diagnostics. Keep Otter access outside the plugin by treating the Python bridge as a strict JSON contract, then drive note creation and updates from canonical `otid` matching plus managed markdown sections.

**Tech Stack:** TypeScript, Obsidian plugin API, Node child process APIs, Vitest, `gray-matter`, `zod`, `esbuild`, `tsx`

---

## File Structure

### New plugin project

- Create: `obsidian-otter-sync/package.json` - plugin package metadata, scripts, dependencies
- Create: `obsidian-otter-sync/tsconfig.json` - TypeScript config for plugin source and tests
- Create: `obsidian-otter-sync/esbuild.config.mjs` - Obsidian plugin bundle config
- Create: `obsidian-otter-sync/manifest.json` - Obsidian plugin manifest
- Create: `obsidian-otter-sync/versions.json` - plugin version compatibility map
- Create: `obsidian-otter-sync/vitest.config.ts` - test runner config
- Create: `obsidian-otter-sync/README.md` - plugin-specific setup and usage notes

### Plugin source

- Create: `obsidian-otter-sync/src/main.ts` - plugin entrypoint, lifecycle wiring, command registration
- Create: `obsidian-otter-sync/src/settings.ts` - settings types, defaults, load/save helpers
- Create: `obsidian-otter-sync/src/settings-tab.ts` - Obsidian settings UI
- Create: `obsidian-otter-sync/src/state.ts` - persisted sync state and retry queue helpers
- Create: `obsidian-otter-sync/src/sync/orchestrator.ts` - scheduled/manual/forced sync orchestration and run lock
- Create: `obsidian-otter-sync/src/sync/python-bridge.ts` - command template validation, placeholder substitution, process execution, timeout handling
- Create: `obsidian-otter-sync/src/sync/schema.ts` - Zod schema for bridge payload
- Create: `obsidian-otter-sync/src/sync/retry-queue.ts` - merge fresh payloads with pending retries by `otid`
- Create: `obsidian-otter-sync/src/notes/frontmatter.ts` - frontmatter parsing/preservation helpers
- Create: `obsidian-otter-sync/src/notes/renderer.ts` - note body rendering and canonical layout
- Create: `obsidian-otter-sync/src/notes/synchronizer.ts` - locate/create/update notes and enforce ownership rules
- Create: `obsidian-otter-sync/src/notes/title.ts` - title cleansing and collision-safe filename generation
- Create: `obsidian-otter-sync/src/diagnostics.ts` - recent run summaries and redacted debug info
- Create: `obsidian-otter-sync/src/obsidian-types.ts` - minimal local interfaces/mocks if tests need them

### Tests

- Create: `obsidian-otter-sync/tests/fixtures/bridge-success.json` - sample bridge payload
- Create: `obsidian-otter-sync/tests/fixtures/existing-note.md` - canonical synced note fixture
- Create: `obsidian-otter-sync/tests/fixtures/malformed-user-note.md` - malformed section fixture
- Create: `obsidian-otter-sync/tests/helpers/fake-app.ts` - fake vault/workspace/plugin-host helpers
- Create: `obsidian-otter-sync/tests/settings.test.ts`
- Create: `obsidian-otter-sync/tests/python-bridge.test.ts`
- Create: `obsidian-otter-sync/tests/retry-queue.test.ts`
- Create: `obsidian-otter-sync/tests/renderer.test.ts`
- Create: `obsidian-otter-sync/tests/synchronizer.test.ts`
- Create: `obsidian-otter-sync/tests/orchestrator.test.ts`
- Create: `obsidian-otter-sync/tests/settings-tab.test.ts`

### Docs and support

- Create: `docs/superpowers/manual-verification/obsidian-otter-sync.md` - end-to-end manual verification checklist
- Create: `docs/examples/obsidian-otter-sync-command.md` - example Python command template and expected JSON contract

## Chunk 1: Scaffold, Settings, and Python Bridge

### Task 1: Scaffold the Obsidian plugin project

**Files:**
- Create: `obsidian-otter-sync/package.json`
- Create: `obsidian-otter-sync/tsconfig.json`
- Create: `obsidian-otter-sync/esbuild.config.mjs`
- Create: `obsidian-otter-sync/manifest.json`
- Create: `obsidian-otter-sync/versions.json`
- Create: `obsidian-otter-sync/vitest.config.ts`
- Create: `obsidian-otter-sync/src/main.ts`
- Create: `obsidian-otter-sync/src/settings.ts`
- Create: `obsidian-otter-sync/src/state.ts`
- Create: `obsidian-otter-sync/src/diagnostics.ts`
- Create: `obsidian-otter-sync/README.md`
- Test: `obsidian-otter-sync/tests/settings.test.ts`
- Create: `obsidian-otter-sync/tests/helpers/fake-app.ts`

- [ ] **Step 1: Write the failing settings defaults test**

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/settings'

describe('DEFAULT_SETTINGS', () => {
  it('defines the initial plugin settings', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      destinationFolder: '',
      commandTemplate: '',
      syncIntervalMinutes: 60,
      firstRunBackfillMode: 'relativeDays',
      firstRunBackfillValue: 7,
      forcedBackfillMode: 'relativeDays',
      forcedBackfillValue: 30,
      showScheduledSuccessNotice: false,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix obsidian-otter-sync test -- settings.test.ts`
Expected: FAIL with `Cannot find module '../src/settings'`

- [ ] **Step 3: Create the plugin scaffold and minimal settings module**

```ts
export type BackfillMode = 'relativeDays' | 'absoluteDate'

export interface OtterSyncSettings {
  destinationFolder: string
  commandTemplate: string
  syncIntervalMinutes: number
  firstRunBackfillMode: BackfillMode
  firstRunBackfillValue: number | string
  forcedBackfillMode: BackfillMode
  forcedBackfillValue: number | string
  showScheduledSuccessNotice: boolean
}

export const DEFAULT_SETTINGS: OtterSyncSettings = {
  destinationFolder: '',
  commandTemplate: '',
  syncIntervalMinutes: 60,
  firstRunBackfillMode: 'relativeDays',
  firstRunBackfillValue: 7,
  forcedBackfillMode: 'relativeDays',
  forcedBackfillValue: 30,
  showScheduledSuccessNotice: false,
}

export const DEFAULT_SYNC_STATE = {
  lastFetchWatermark: null,
  lastCleanSyncTime: null,
  pendingRetries: [],
}

export const DEFAULT_DIAGNOSTICS = {
  recentRuns: [],
  lastErrorSummary: null,
}
```

- [ ] **Step 4: Create the remaining scaffold config and test helper files explicitly**

```json
{
  "name": "obsidian-otter-sync",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node esbuild.config.mjs production",
    "dev": "node esbuild.config.mjs",
    "test": "vitest run"
  },
  "devDependencies": {
    "esbuild": "^0.25.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vitest": "^3.1.0"
  },
  "dependencies": {
    "gray-matter": "^4.0.3",
    "obsidian": "latest",
    "zod": "^3.24.0"
  }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

```ts
export const DEFAULT_SYNC_STATE = { lastFetchWatermark: null, lastCleanSyncTime: null, pendingRetries: [] }
export const DEFAULT_DIAGNOSTICS = { recentRuns: [], lastErrorSummary: null }
export function createFakePluginHost() { return { app: {}, plugin: {}, containerEl: document.createElement('div'), saveData: vi.fn() } }
```

- [ ] **Step 5: Add package scripts and manifest placeholders**

```json
{
  "id": "otter-sync",
  "name": "Otter Sync",
  "version": "0.0.1",
  "minAppVersion": "1.5.0",
  "description": "Sync OtterAI meetings into Obsidian notes.",
  "isDesktopOnly": true
}
```

```json
{
  "scripts": {
    "build": "node esbuild.config.mjs production",
    "dev": "node esbuild.config.mjs",
    "test": "vitest run"
  }
}
```

- [ ] **Step 6: Run the test again**

Run: `npm --prefix obsidian-otter-sync test -- settings.test.ts`
Expected: PASS

- [ ] **Step 7: Run a scaffold build smoke test**

Run: `npm --prefix obsidian-otter-sync run build`
Expected: PASS and emit `obsidian-otter-sync/main.js` plus valid `manifest.json`

- [ ] **Step 8: Commit**

```bash
git add obsidian-otter-sync/package.json obsidian-otter-sync/tsconfig.json obsidian-otter-sync/esbuild.config.mjs obsidian-otter-sync/manifest.json obsidian-otter-sync/versions.json obsidian-otter-sync/vitest.config.ts obsidian-otter-sync/src/main.ts obsidian-otter-sync/src/settings.ts obsidian-otter-sync/src/state.ts obsidian-otter-sync/src/diagnostics.ts obsidian-otter-sync/README.md obsidian-otter-sync/tests/settings.test.ts obsidian-otter-sync/tests/helpers/fake-app.ts
git commit -m "feat: scaffold Obsidian sync plugin"
```

### Task 2: Implement persisted settings and the settings tab

**Files:**
- Modify: `obsidian-otter-sync/src/main.ts`
- Modify: `obsidian-otter-sync/src/settings.ts`
- Create: `obsidian-otter-sync/src/settings-tab.ts`
- Modify: `obsidian-otter-sync/tests/helpers/fake-app.ts`
- Test: `obsidian-otter-sync/tests/settings-tab.test.ts`
- Test: `obsidian-otter-sync/tests/settings.test.ts`

- [ ] **Step 1: Write the failing settings load/save test**

```ts
it('merges saved plugin data with defaults', async () => {
  const loaded = await loadSettings({ syncIntervalMinutes: 15 })
  expect(loaded.syncIntervalMinutes).toBe(15)
  expect(loaded.destinationFolder).toBe('')
})
```

- [ ] **Step 2: Write the failing settings tab rendering test**

```ts
it('renders controls for command template and backfill settings', () => {
  const tab = new OtterSyncSettingTab(app, plugin)
  tab.display()
  expect(containerEl.textContent).toContain('Destination folder')
  expect(containerEl.textContent).toContain('Sync cadence')
  expect(containerEl.textContent).toContain('Python sync command template')
  expect(containerEl.textContent).toContain('First-run backfill')
  expect(containerEl.textContent).toContain('Forced sync backfill')
  expect(containerEl.textContent).toContain('Show scheduled success notices')
  expect(containerEl.textContent).toContain('Last clean sync time')
  expect(containerEl.textContent).toContain('Last fetch watermark')
  expect(containerEl.textContent).toContain('Last sync error summary')
  expect(containerEl.textContent).toContain('Recent sync diagnostics')
  expect(containerEl.textContent).toContain('Copy last sync debug info')
})
```

- [ ] **Step 3: Write the failing settings persistence test**

```ts
it('persists changed settings through saveData', async () => {
  await updateSettings(plugin, { destinationFolder: '30 - Work/Meetings' })
  expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
    settings: expect.objectContaining({ destinationFolder: '30 - Work/Meetings' }),
    state: expect.any(Object),
    diagnostics: expect.any(Object),
  }))
})
```

- [ ] **Step 4: Write the failing unsupported-platform settings test**

```ts
it('shows a clear desktop-only/process-unavailable message in settings', () => {
  const tab = new OtterSyncSettingTab(app, pluginWithUnavailableProcessExecution)
  tab.display()
  expect(containerEl.textContent).toContain('This plugin requires Obsidian desktop with local process execution')
})
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm --prefix obsidian-otter-sync test -- settings.test.ts settings-tab.test.ts`
Expected: FAIL with missing `loadSettings`, `updateSettings`, and `OtterSyncSettingTab`

- [ ] **Step 6: Implement settings helpers, minimal state/diagnostics envelope, and tab UI**

```ts
export async function loadSettings(data: Partial<OtterSyncSettings> | null | undefined) {
  return { ...DEFAULT_SETTINGS, ...data }
}

export interface PluginDataEnvelope {
  settings: OtterSyncSettings
  state: SyncState
  diagnostics: DiagnosticsState
}

export function loadState(data: Partial<SyncState> | null | undefined): SyncState {
  return { ...DEFAULT_SYNC_STATE, ...data }
}

export function loadDiagnostics(data: Partial<DiagnosticsState> | null | undefined): DiagnosticsState {
  return { ...DEFAULT_DIAGNOSTICS, ...data }
}

export async function updateSettings(plugin: { settings: OtterSyncSettings; state: SyncState; diagnostics: DiagnosticsState; saveData(data: unknown): Promise<void> }, patch: Partial<OtterSyncSettings>) {
  plugin.settings = { ...plugin.settings, ...patch }
  await plugin.saveData({ settings: plugin.settings, state: plugin.state, diagnostics: plugin.diagnostics })
}

export class OtterSyncSettingTab extends PluginSettingTab {
  display(): void {
    this.containerEl.empty()
    // render controls for destination folder, command template, cadence,
    // first-run backfill mode/value, forced backfill mode/value,
    // scheduled-success toggle, and read-only diagnostics fields
    // plus a desktop-only/process-unavailable error when command execution is not available
  }
}
```

- [ ] **Step 7: Wire settings loading and tab registration in the plugin entrypoint**

```ts
async onload() {
  const data = await this.loadData()
  this.settings = await loadSettings(data?.settings)
  this.state = loadState(data?.state)
  this.diagnostics = loadDiagnostics(data?.diagnostics)
  this.addSettingTab(new OtterSyncSettingTab(this.app, this))
}
```

- [ ] **Step 6: Run the targeted tests**

Run: `npm --prefix obsidian-otter-sync test -- settings.test.ts settings-tab.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add obsidian-otter-sync/src/main.ts obsidian-otter-sync/src/settings.ts obsidian-otter-sync/src/state.ts obsidian-otter-sync/src/diagnostics.ts obsidian-otter-sync/src/settings-tab.ts obsidian-otter-sync/tests/settings.test.ts obsidian-otter-sync/tests/settings-tab.test.ts
git commit -m "feat: add plugin settings UI"
```

### Task 3: Implement bridge schema validation and command-template execution

**Files:**
- Create: `obsidian-otter-sync/src/sync/schema.ts`
- Create: `obsidian-otter-sync/src/sync/python-bridge.ts`
- Test: `obsidian-otter-sync/tests/python-bridge.test.ts`
- Create: `obsidian-otter-sync/tests/fixtures/bridge-success.json`

- [ ] **Step 1: Write the failing schema validation test**

```ts
it('accepts a valid bridge payload', () => {
  const payload = {
    fetched_until: 1773246769,
    speeches: [{
      otid: 'jqb7OHo6mrHtCuMkyLN0nUS8mxY',
      source_url: 'https://otter.ai/u/abc',
      title: 'Weekly Sync',
      created_at: 1773246000,
      modified_time: 1773246769,
      attendees: ['Alex'],
      summary_markdown: '## Summary',
      transcript_segments: [{ speaker_name: 'Alex', timestamp: '0:00', text: 'Hello' }],
    }],
  }

  expect(() => parseBridgePayload(payload)).not.toThrow()
})
```

- [ ] **Step 2: Write the failing command-template validation and substitution tests**

```ts
it('rejects quoted placeholders in the command template', () => {
  expect(() => runBridgeCommand(makeBridgeInput({ commandTemplate: 'python sync.py --since "{since}" --mode {mode}' }))).rejects.toThrow(/configuration error/i)
})

it('rejects templates missing required placeholders', () => {
  expect(() => runBridgeCommand(makeBridgeInput({ commandTemplate: 'python sync.py --since {since}' }))).rejects.toThrow(/configuration error/i)
  expect(() => runBridgeCommand(makeBridgeInput({ commandTemplate: 'python sync.py --mode {mode}' }))).rejects.toThrow(/configuration error/i)
})

it('renders escaped since and mode values into the command template', () => {
  const command = renderCommandTemplate('python sync.py --since {since} --mode {mode}', { since: '1773246769', mode: 'forced' })
  expect(command).toBe('python sync.py --since 1773246769 --mode forced')
})
```

- [ ] **Step 3: Write the failing stdout/stderr and exit-path tests**

```ts
it('parses stdout JSON and returns stderr for diagnostics', async () => {
  const result = await runBridgeCommand(makeBridgeInput())
  expect(result.payload.fetched_until).toBe(1773246769)
  expect(result.stderr).toContain('warning')
  expect(result.exitCode).toBe(0)
})

it('fails on invalid JSON stdout', async () => {
  await expect(runBridgeCommand(makeBridgeInput({ stdout: 'not-json' }))).rejects.toThrow(/invalid json/i)
})

it('fails on non-zero exit status', async () => {
  await expect(runBridgeCommand(makeBridgeInput({ exitCode: 1 }))).rejects.toThrow(/exit code/i)
})

it('fails on malformed JSON payloads that miss required fields', async () => {
  expect(() => parseBridgePayload({ fetched_until: 1, speeches: [{ otid: '', source_url: null }] })).toThrow()
})

it('uses the correct shell spec for the current platform', () => {
  expect(getShellSpec('darwin')).toEqual({ command: '/bin/sh', args: ['-lc'] })
  expect(getShellSpec('win32')).toEqual({ command: 'cmd.exe', args: ['/d', '/s', '/c'] })
})
```

- [ ] **Step 4: Write the failing timeout cleanup test**

```ts
it('times out and kills the child process', async () => {
  await expect(runBridgeCommand(makeBridgeInput())).rejects.toThrow(/timed out/i)
  expect(killSpy).toHaveBeenCalled()
  expect(DEFAULT_BRIDGE_TIMEOUT_MS).toBe(60000)
})
```

- [ ] **Step 5: Run the bridge tests to verify they fail**

Run: `npm --prefix obsidian-otter-sync test -- python-bridge.test.ts`
Expected: FAIL with missing schema and bridge exports

- [ ] **Step 6: Implement exact bridge helpers in `obsidian-otter-sync/src/sync/python-bridge.ts`**

```ts
export function validateCommandTemplate(template: string) { /* validate bare placeholders */ }
export function renderCommandTemplate(template: string, values: { since: string; mode: 'scheduled' | 'manual' | 'forced' }) { /* quote values */ }
export function getShellSpec(platform: NodeJS.Platform) { /* /bin/sh -lc vs cmd.exe /d /s /c */ }
export function summarizeCommandForDiagnostics(template: string) { /* executable basename only */ }
export async function runBridgeCommand(input: BridgeCommandInput) { /* reject invalid templates as configuration errors; spawn; timeout; parse stdout; distinguish invalid JSON vs schema failure; capture stderr; include exitCode */ }
```

- [ ] **Step 7: Implement the schema and bridge payload parser**

```ts
export const transcriptSegmentSchema = z.object({
  speaker_name: z.string().min(1),
  timestamp: z.string().min(1),
  text: z.string(),
})

export const bridgePayloadSchema = z.object({
  fetched_until: z.number().int().nonnegative(),
  speeches: z.array(z.object({
    otid: z.string().min(1),
    source_url: z.string().min(1),
    title: z.string().min(1),
    created_at: z.number().int().nonnegative(),
    modified_time: z.number().int().nonnegative(),
    attendees: z.array(z.string().min(1)),
    summary_markdown: z.string(),
    transcript_segments: z.array(transcriptSegmentSchema),
  })),
})
```

- [ ] **Step 8: Run the targeted bridge tests**

Run: `npm --prefix obsidian-otter-sync test -- python-bridge.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add obsidian-otter-sync/src/sync/schema.ts obsidian-otter-sync/src/sync/python-bridge.ts obsidian-otter-sync/tests/python-bridge.test.ts obsidian-otter-sync/tests/fixtures/bridge-success.json
git commit -m "feat: add Python bridge contract"
```

## Chunk 2: Note Rendering, Matching, and Sync Engine

### Task 4: Implement title cleansing, frontmatter helpers, and note rendering

**Files:**
- Create: `obsidian-otter-sync/src/notes/title.ts`
- Create: `obsidian-otter-sync/src/notes/frontmatter.ts`
- Create: `obsidian-otter-sync/src/notes/renderer.ts`
- Test: `obsidian-otter-sync/tests/renderer.test.ts`

- [ ] **Step 1: Write the failing renderer test for canonical note output**

```ts
it('renders a new synced note with canonical frontmatter and sections', () => {
  const note = renderNewNote(sampleSpeech)
  expect(note).toContain('otid: jqb7OHo6mrHtCuMkyLN0nUS8mxY')
  expect(note).toContain('date: 2026-03-12')
  expect(note).toContain('type: meeting')
  expect(note).toContain('tags: []')
  expect(note).toContain('attendees:\n  - Alex')
  expect(note).toContain('source: https://otter.ai/u/abc')
  expect(note).toContain('sync_time: 1773246769')
  expect(note).toContain('# Weekly Sync')
  expect(note).toContain('## User Notes')
  expect(note).toContain('## Summary')
  expect(note).toContain('## Transcript')
  expect(note).toContain('Alex 0:00\nHello')
})
```

- [ ] **Step 2: Write the failing frontmatter preservation and summary passthrough tests**

```ts
it('preserves tags and unknown frontmatter keys when merging managed values', () => {
  expect(mergeManagedFrontmatter({ tags: 'team', project: 'alpha' }, { sync_time: 2 })).toMatchObject({ tags: 'team', project: 'alpha', sync_time: 2 })
})

it('passes summary markdown through without rewriting list structure', () => {
  expect(renderSummary('- [ ] Action item')).toContain('- [ ] Action item')
})

it('normalizes and deduplicates attendee names before rendering frontmatter', () => {
  expect(normalizeAttendees([' Alex ', 'Alex', 'Taylor'])).toEqual(['Alex', 'Taylor'])
})
```

- [ ] **Step 3: Write the failing collision-only filename test**

```ts
it('appends a short otid only when the base filename already exists', () => {
  expect(buildFilename('2026-03-12', 'Weekly Sync', 'jqb7OHo6', false)).toBe('2026-03-12 - Weekly Sync.md')
  expect(buildFilename('2026-03-12', 'Weekly Sync', 'jqb7OHo6', true)).toBe('2026-03-12 - Weekly Sync - jqb7OHo6.md')
})

it('uses the collision-safe filename when the base note path already exists in the destination folder', async () => {
  const path = await chooseNotePath(fakeVault, '30 - Work/Meetings', sampleSpeech)
  expect(path).toBe('30 - Work/Meetings/2026-03-12 - Weekly Sync - jqb7OHo6.md')
})
```

- [ ] **Step 4: Run the renderer tests to verify they fail**

Run: `npm --prefix obsidian-otter-sync test -- renderer.test.ts`
Expected: FAIL with missing renderer exports

- [ ] **Step 5: Implement title and rendering helpers**

```ts
export function cleanseTitle(title: string): string {
  return title.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ') || 'Untitled Meeting'
}

export function renderTranscript(segments: TranscriptSegment[]): string {
  return segments.map((segment) => `${segment.speaker_name} ${segment.timestamp}\n${segment.text}`).join('\n\n')
}
```

- [ ] **Step 6: Implement frontmatter preservation helpers and collision-aware filenames**

```ts
export function mergeManagedFrontmatter(existing: Record<string, unknown>, managed: Record<string, unknown>) {
  return {
    ...existing,
    ...managed,
  }
}
```

- [ ] **Step 7: Run the targeted renderer tests**

Run: `npm --prefix obsidian-otter-sync test -- renderer.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add obsidian-otter-sync/src/notes/title.ts obsidian-otter-sync/src/notes/frontmatter.ts obsidian-otter-sync/src/notes/renderer.ts obsidian-otter-sync/tests/renderer.test.ts
git commit -m "feat: add note rendering helpers"
```

### Task 5: Implement note lookup, safe update rules, and folder creation

**Files:**
- Create: `obsidian-otter-sync/src/notes/synchronizer.ts`
- Test: `obsidian-otter-sync/tests/synchronizer.test.ts`
- Create: `obsidian-otter-sync/tests/fixtures/existing-note.md`
- Create: `obsidian-otter-sync/tests/fixtures/malformed-user-note.md`
- Create: `obsidian-otter-sync/tests/helpers/fake-app.ts`

- [ ] **Step 1: Write the failing existing-note match test**

```ts
it('finds an existing note by frontmatter otid', async () => {
  const match = await findExistingNote(fakeVault, 'jqb7OHo6mrHtCuMkyLN0nUS8mxY')
  expect(match?.path).toBe('30 - Work/Meetings/2026-03-12 - Weekly Sync.md')
})
```

- [ ] **Step 2: Write the failing create-path test**

```ts
it('creates a new note in the destination folder with canonical content when no match exists', async () => {
  const result = await syncSpeech(fakeEmptyVault, sampleSpeech)
  expect(result.status).toBe('created')
  expect(result.path).toMatch(/30 - Work\/Meetings\/2026-03-12 - Weekly Sync( - jqb7OHo6)?\.md/)
  expect(result.content).toContain('## Transcript')
})
```

- [ ] **Step 3: Write the failing destination-folder scoping test**

```ts
it('only scans the configured destination folder for existing notes and duplicates', async () => {
  const match = await findExistingNote(fakeVault, 'jqb7OHo6mrHtCuMkyLN0nUS8mxY', '30 - Work/Meetings')
  expect(match?.path).toBe('30 - Work/Meetings/2026-03-12 - Weekly Sync.md')
})
```

- [ ] **Step 4: Write the failing safe-update test**

```ts
it('skips updates when User Notes cannot be identified exactly once', async () => {
  const result = await syncSpeech(fakeVault, malformedSpeech)
  expect(result.status).toBe('failed')
  expect(result.reason).toMatch(/User Notes/i)
})
```

- [ ] **Step 5: Write the failing normalization-path test**

```ts
it('preserves User Notes and rewrites the rest when Summary is malformed but User Notes appears exactly once', async () => {
  const result = await syncSpeech(fakeVault, malformedManagedSectionsSpeech)
  expect(result.status).toBe('updated')
  expect(result.normalized).toBe(true)
  expect(result.content).toContain('## User Notes\n\nKeep this text')
  expect(result.content).toContain('## Summary')
  expect(result.content).toContain('## Transcript')
  expect(result.diagnostics[0]).toMatch(/normalized/i)
})
```

- [ ] **Step 6: Write the failing source-to-otid migration test**

```ts
it('migrates an older synced note when otid is missing but source contains a parseable id', async () => {
  const result = await findExistingNote(fakeVault, 'jqb7OHo6mrHtCuMkyLN0nUS8mxY')
  expect(result?.frontmatter.otid).toBe('jqb7OHo6mrHtCuMkyLN0nUS8mxY')
})
```

- [ ] **Step 7: Write the failing invalid-source migration test**

```ts
it('records a diagnostic when source cannot be parsed into an otid', async () => {
  const result = await findExistingNote(fakeVault, 'jqb7OHo6mrHtCuMkyLN0nUS8mxY')
  expect(result?.status).toBe('unmatchable')
  expect(result?.reason).toMatch(/cannot be parsed/i)
  expect(result?.matchedNote).toBeNull()
})
```

- [ ] **Step 8: Write the failing duplicate-note detail test**

```ts
it('fails with conflicting note paths when multiple notes share the same otid', async () => {
  const result = await syncSpeech(fakeVault, sampleSpeech)
  expect(result.status).toBe('failed')
  expect(result.conflictingPaths).toEqual(expect.arrayContaining(['30 - Work/Meetings/A.md', '30 - Work/Meetings/B.md']))
})
```

- [ ] **Step 8: Write the failing title-refresh-without-rename test**

```ts
it('updates the H1 title when the Otter title changes without renaming the file', async () => {
  const result = await syncSpeech(fakeVaultWithExistingPath('30 - Work/Meetings/2026-03-12 - Weekly Sync.md'), { ...sampleSpeech, title: 'Weekly Sync Renamed' })
  expect(result.path).toBe('30 - Work/Meetings/2026-03-12 - Weekly Sync.md')
  expect(result.content).toContain('# Weekly Sync Renamed')
})

it('preserves User Notes verbatim while refreshing managed content on a canonical update', async () => {
  const result = await syncSpeech(fakeVaultWithCanonicalNote, { ...sampleSpeech, modified_time: 200 })
  expect(result.content).toContain('## User Notes\n\nKeep this text exactly')
  expect(result.content).toContain('## Summary')
  expect(result.content).toContain('## Transcript')
  expect(result.normalized).toBe(false)
})
```

- [ ] **Step 9: Write the failing skip-and-update decision tests**

```ts
it('skips when modified_time is not newer than sync_time', async () => {
  const result = await syncSpeech(fakeVault, { ...sampleSpeech, modified_time: 100 })
  expect(result.status).toBe('skipped')
})

it('updates managed content when modified_time is newer than sync_time', async () => {
  const result = await syncSpeech(fakeVault, { ...sampleSpeech, modified_time: 200 })
  expect(result.status).toBe('updated')
  expect(result.content).toContain('## Summary')
})
```

- [ ] **Step 10: Write the failing folder-creation test**

```ts
it('creates the destination folder before writing a new note', async () => {
  await syncSpeech(fakeVault, sampleSpeech)
  expect(fakeVault.createdFolders).toContain('30 - Work/Meetings')
})
```

- [ ] **Step 11: Write the failing folder-creation fatal-path test**

```ts
it('stops note processing and records a fatal diagnostic when destination folder creation fails', async () => {
  const result = await syncBatch(fakeVaultThatFailsMkdir, [sampleSpeech, anotherSpeech])
  expect(result.status).toBe('failed')
  expect(result.fatal).toBe(true)
  expect(result.processedCount).toBe(0)
})
```

- [ ] **Step 12: Write the failing managed-frontmatter preservation test**

```ts
it('preserves tags and unknown frontmatter keys while restoring managed keys on update', async () => {
  const result = await syncSpeech(fakeVault, sampleSpeech)
  expect(result.frontmatter.tags).toEqual(['team'])
  expect(result.frontmatter.project).toBe('alpha')
  expect(result.frontmatter.type).toBe('meeting')
  expect(result.frontmatter.sync_time).toBe(1773246769)
})
```

- [ ] **Step 13: Run the synchronizer tests to verify they fail**

Run: `npm --prefix obsidian-otter-sync test -- synchronizer.test.ts`
Expected: FAIL with missing synchronizer exports

- [ ] **Step 14: Implement note synchronizer behavior**

```ts
if (matches.length > 1) {
  return { status: 'failed', reason: 'Duplicate otid matches found' }
}

if (existing && speech.modified_time <= existing.sync_time) {
  return { status: 'skipped', reason: 'Already up to date' }
}
```

- [ ] **Step 15: Implement exact section safety checks, normalization path with diagnostics, destination-folder scoping, non-blocking migration fallback, title refresh without rename, skip/update rules, managed-frontmatter preservation, and fatal folder-create failure**

```ts
const userNotesMatches = content.match(/^## User Notes$/gm) ?? []
if (userNotesMatches.length !== 1) {
  return { status: 'failed', reason: 'Cannot preserve User Notes safely' }
}
```

- [ ] **Step 16: Run the targeted synchronizer tests**

Run: `npm --prefix obsidian-otter-sync test -- synchronizer.test.ts`
Expected: PASS

- [ ] **Step 17: Commit**

```bash
git add obsidian-otter-sync/src/notes/synchronizer.ts obsidian-otter-sync/tests/synchronizer.test.ts obsidian-otter-sync/tests/fixtures/existing-note.md obsidian-otter-sync/tests/fixtures/malformed-user-note.md obsidian-otter-sync/tests/helpers/fake-app.ts
git commit -m "feat: add note sync engine"
```

### Task 6: Implement retry queue merging and diagnostics persistence

**Files:**
- Modify: `obsidian-otter-sync/src/state.ts`
- Create: `obsidian-otter-sync/src/sync/retry-queue.ts`
- Modify: `obsidian-otter-sync/src/diagnostics.ts`
- Test: `obsidian-otter-sync/tests/retry-queue.test.ts`

- [ ] **Step 1: Write the failing retry merge test**

```ts
it('prefers the freshest payload by modified_time when merging retries with fresh fetches', () => {
  const merged = mergeRetryQueue([
    { otid: '1', modified_time: 100, failure_reason: 'disk full' },
  ], [
    { otid: '1', modified_time: 200 },
  ])

  expect(merged[0].modified_time).toBe(200)
})
```

- [ ] **Step 2: Write the failing diagnostics redaction test**

```ts
it('stores a redacted command summary instead of the raw template', () => {
  const summary = summarizeCommandForDiagnostics('OTTERAI_PASSWORD=secret python sync.py --since {since} --mode {mode}')
  expect(summary).not.toContain('secret')
  expect(summary).toEqual({ executable: 'python', placeholderSubstitution: 'required' })
})
```

- [ ] **Step 3: Write the failing state-transition and rolling-history tests**

```ts
it('removes a retry entry immediately after success', () => {
  const next = markRetrySuccess(makeStateWithRetry('1'), '1')
  expect(next.pendingRetries).toEqual([])
})

it('replaces a queued retry entry after repeated failure for the same otid', () => {
  const next = replaceRetryEntry(makeStateWithRetry('1'), makeRetryEntry({ otid: '1', modified_time: 200, failure_reason: 'disk full', last_attempted_at: 20 }))
  expect(next.pendingRetries[0].modified_time).toBe(200)
  expect(next.pendingRetries[0].failure_reason).toBe('disk full')
})

it('caps run history to the most recent 20 entries', () => {
  const next = appendRunHistory(makeHistory(20), makeRun(21))
  expect(next.length).toBe(20)
})
```

- [ ] **Step 4: Write the failing diagnostics persistence test**

```ts
it('stores top-level and per-note failures in diagnostics state', () => {
  const next = recordRunResult(emptyDiagnostics(), {
    runMode: 'manual',
    startedAt: 10,
    endedAt: 20,
    fetchWatermarkUsed: 1,
    fetchedUntil: 2,
    retryReplay: true,
    counts: { created: 1, updated: 0, skipped: 0, failed: 1 },
    commandSummary: 'python',
    exitCode: 1,
    stderrSnippet: 'boom',
    speechCount: 3,
    errorSummary: 'bridge failed',
    noteFailures: [{ otid: '1', source_url: 'https://otter.ai/u/abc', notePath: 'Meetings/A.md', reason: 'duplicate' }],
  })
  expect(next.recentRuns[0].errorSummary).toContain('bridge failed')
  expect(next.recentRuns[0].noteFailures[0].notePath).toBe('Meetings/A.md')
})
```

- [ ] **Step 5: Run the retry and diagnostics tests to verify they fail**

Run: `npm --prefix obsidian-otter-sync test -- retry-queue.test.ts`
Expected: FAIL with missing queue and diagnostics helpers

- [ ] **Step 6: Implement retry queue state and diagnostics reducers**

```ts
export function mergeRetryQueue(retries: RetryEntry[], speeches: SpeechPayload[]) {
  const merged = new Map<string, RetryEntry | SpeechPayload>()
  for (const entry of [...retries, ...speeches]) {
    const current = merged.get(entry.otid)
    if (!current || entry.modified_time >= current.modified_time) merged.set(entry.otid, entry)
  }
  return [...merged.values()].map(stripRetryMetadata)
}
```

- [ ] **Step 7: Implement state helpers for `lastFetchWatermark`, `lastCleanSyncTime`, and `pendingRetries`**

```ts
export interface SyncState {
  lastFetchWatermark: number | null
  lastCleanSyncTime: number | null
  pendingRetries: RetryEntry[]
}

export interface RetryEntry {
  otid: string
  source_url: string
  title: string
  created_at: number
  modified_time: number
  attendees: string[]
  summary_markdown: string
  transcript_segments: Array<{ speaker_name: string; timestamp: string; text: string }>
  failure_reason: string
  last_attempted_at: number
}
```

- [ ] **Step 8: Implement rolling diagnostics history and retry removal-on-success helpers**

```ts
export function appendRunHistory(history: RunSummary[], next: RunSummary) {
  return [next, ...history].slice(0, 20)
}

export function markRetrySuccess(state: SyncState, otid: string): SyncState {
  return { ...state, pendingRetries: state.pendingRetries.filter((entry) => entry.otid !== otid) }
}

export function replaceRetryEntry(state: SyncState, entry: RetryEntry): SyncState {
  return { ...state, pendingRetries: [...state.pendingRetries.filter((item) => item.otid !== entry.otid), entry] }
}
```

- [ ] **Step 9: Run the targeted retry and diagnostics tests**

Run: `npm --prefix obsidian-otter-sync test -- retry-queue.test.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add obsidian-otter-sync/src/state.ts obsidian-otter-sync/src/sync/retry-queue.ts obsidian-otter-sync/src/diagnostics.ts obsidian-otter-sync/tests/retry-queue.test.ts
git commit -m "feat: add sync state and diagnostics"
```

## Chunk 3: Orchestration, Commands, and Verification

### Task 7: Implement sync orchestration and command registration

**Files:**
- Create: `obsidian-otter-sync/src/sync/orchestrator.ts`
- Modify: `obsidian-otter-sync/src/main.ts`
- Test: `obsidian-otter-sync/tests/orchestrator.test.ts`

- [ ] **Step 1: Write the failing orchestration test for scheduled sync watermark computation**

```ts
it('uses lastFetchWatermark minus one day for scheduled syncs', async () => {
  const since = computeSince({
    mode: 'scheduled',
    state: { lastFetchWatermark: 200000, lastCleanSyncTime: null, pendingRetries: [] },
  })
  expect(since).toBe(113600)
})
```

- [ ] **Step 2: Write the failing first-run and forced-backfill tests**

```ts
it('uses first-run backfill defaults when no fetch watermark exists', () => {
  const since = computeSince(makeFirstRunInput())
  expect(since).toBeGreaterThan(0)
})

it('uses first-run backfill defaults for scheduled sync when no fetch watermark exists', () => {
  const since = computeSince(makeScheduledFirstRunInput())
  expect(since).toBe(makeFirstRunBackfillTimestamp())
})

it('uses forced backfill settings for Force sync now', () => {
  const since = computeSince(makeForcedInput())
  expect(since).toBe(makeForcedBackfillTimestamp())
})
```

- [ ] **Step 3: Write the failing force-sync command registration test**

```ts
it('registers Sync now and Force sync now commands', async () => {
  await plugin.onload()
  expect(registeredCommands).toEqual(expect.arrayContaining(['sync-now', 'force-sync-now']))
})
```

- [ ] **Step 4: Write the failing manual progress notice test**

```ts
it('shows started and completed notices for a manual sync', async () => {
  await orchestrator.run('manual')
  expect(notices).toEqual(expect.arrayContaining(['Sync started', 'Fetching meetings', 'Writing notes', 'Sync completed: created 1, updated 0, skipped 0, failed 0']))
})
```

- [ ] **Step 5: Write the failing scheduled-notice quiet-mode test**

```ts
it('keeps scheduled success notices off by default', async () => {
  await orchestrator.run('scheduled')
  expect(notices).not.toContain('Sync completed')
})

it('shows failed with counts for manual sync failures', async () => {
  await expect(orchestrator.run('manual')).rejects.toThrow()
  expect(notices).toEqual(expect.arrayContaining(['Sync failed: created 0, updated 0, skipped 0, failed 1']))
})

it('shows a failure notice for scheduled sync failures and records diagnostics', async () => {
  await expect(orchestrator.run('scheduled')).rejects.toThrow()
  expect(notices).toEqual(expect.arrayContaining(['Sync failed: created 0, updated 0, skipped 0, failed 1']))
  expect(diagnostics.recentRuns[0].runMode).toBe('scheduled')
})
```

- [ ] **Step 5: Write the failing run-lock concurrency test**

```ts
it('rejects a second sync while one is already in progress and releases the lock afterward', async () => {
  const first = orchestrator.run('manual')
  await expect(orchestrator.run('manual')).rejects.toThrow(/already running/i)
  await first
  await expect(orchestrator.run('manual')).resolves.toBeDefined()
})
```

- [ ] **Step 6: Write the failing state-advancement and retry-persistence tests**

```ts
it('updates lastFetchWatermark after a successful bridge fetch even when a note write fails', async () => {
  await orchestrator.run('manual')
  expect(pluginState.lastFetchWatermark).toBe(1773246769)
  expect(pluginState.lastCleanSyncTime).toBeNull()
})

it('does not advance lastFetchWatermark or lastCleanSyncTime on a fatal bridge failure', async () => {
  await expect(orchestrator.run('manual')).rejects.toThrow(/bridge/i)
  expect(pluginState.lastFetchWatermark).toBeNull()
  expect(pluginState.lastCleanSyncTime).toBeNull()
})

it('advances lastCleanSyncTime on a fully successful sync', async () => {
  await orchestrator.run('manual')
  expect(pluginState.lastCleanSyncTime).toBeGreaterThan(0)
})

it('persists retry entries for failed note writes', async () => {
  await orchestrator.run('manual')
  expect(pluginState.pendingRetries).toHaveLength(1)
})

it('replays pendingRetries and merges them with fresh fetch results by otid, preferring newer modified_time', async () => {
  await orchestrator.run('manual')
  expect(processedOtids).toContain('jqb7OHo6mrHtCuMkyLN0nUS8mxY')
  expect(processedModifiedTimeFor('jqb7OHo6mrHtCuMkyLN0nUS8mxY')).toBe(200)
})

it('does not advance lastCleanSyncTime when bridge or per-note failures occur', async () => {
  await orchestrator.run('manual')
  expect(pluginState.lastCleanSyncTime).toBeNull()
})
```

- [ ] **Step 7: Write the failing desktop-only/process-unavailable test**

```ts
it('refuses sync when local process execution is unavailable', async () => {
  await expect(orchestrator.run('manual')).rejects.toThrow(/desktop only/i)
})
```

- [ ] **Step 8: Write the failing startup scheduling test**

```ts
it('starts the periodic sync interval on load and clears it on unload', async () => {
  await plugin.onload()
  expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000)
  await plugin.onunload()
  expect(clearIntervalSpy).toHaveBeenCalled()
})
```

- [ ] **Step 9: Run the orchestrator tests to verify they fail**

Run: `npm --prefix obsidian-otter-sync test -- orchestrator.test.ts`
Expected: FAIL with missing orchestrator exports

- [ ] **Step 10: Implement scheduled, manual, and forced orchestration paths**

```ts
export function computeSince(input: ComputeSinceInput): number {
  if (input.mode === 'forced') return resolveBackfillSetting(input.settings.forcedBackfillMode, input.settings.forcedBackfillValue)
  if (input.state.lastFetchWatermark == null) return resolveBackfillSetting(input.settings.firstRunBackfillMode, input.settings.firstRunBackfillValue)
  return Math.max(0, (input.state.lastFetchWatermark ?? resolveBackfillSetting(input.settings.firstRunBackfillMode, input.settings.firstRunBackfillValue)) - 86400)
}
```

- [ ] **Step 11: Wire command registration and interval management into `main.ts`**

```ts
this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => this.orchestrator.run('manual') })
this.addCommand({ id: 'force-sync-now', name: 'Force sync now', callback: () => this.orchestrator.run('forced') })
```

- [ ] **Step 12: Implement run notices, lock release on timeout/failure, retry persistence, scheduled-notice quiet mode, startup scheduling, and desktop-only guard**

```ts
try {
  this.isRunning = true
  new Notice('Sync started')
  const result = await this.runOnce(mode)
  new Notice('Sync completed')
  return result
} finally {
  this.isRunning = false
}
```

```ts
const merged = mergeRetryQueue(state.pendingRetries, bridgeResult.payload.speeches)
await this.recordRunDiagnostics({
  runMode: mode,
  startedAt,
  endedAt: Date.now(),
  fetchWatermarkUsed: since,
  fetchedUntil: bridgeResult.payload.fetched_until,
  retryReplay: state.pendingRetries.length > 0,
  counts,
  commandSummary: summarizeCommandForDiagnostics(this.settings.commandTemplate),
  exitCode: bridgeResult.exitCode,
  stderrSnippet: bridgeResult.stderr,
  speechCount: bridgeResult.payload.speeches.length,
  errorSummary,
  noteFailures,
})
```

- [ ] **Step 13: Run the targeted orchestrator tests**

Run: `npm --prefix obsidian-otter-sync test -- orchestrator.test.ts`
Expected: PASS

- [ ] **Step 14: Commit**

```bash
git add obsidian-otter-sync/src/main.ts obsidian-otter-sync/src/sync/orchestrator.ts obsidian-otter-sync/tests/orchestrator.test.ts
git commit -m "feat: add sync orchestration"
```

### Task 8: Polish diagnostics UX, plugin docs, and manual verification assets

**Files:**
- Modify: `obsidian-otter-sync/src/settings-tab.ts`
- Modify: `obsidian-otter-sync/README.md`
- Create: `docs/examples/obsidian-otter-sync-command.md`
- Create: `docs/superpowers/manual-verification/obsidian-otter-sync.md`
- Test: `obsidian-otter-sync/tests/settings-tab.test.ts`

- [ ] **Step 1: Write the failing diagnostics UI test**

```ts
it('shows last clean sync time and a copy-debug-info control', () => {
  tab.display()
  expect(containerEl.textContent).toContain('Last clean sync time')
  expect(containerEl.textContent).toContain('Last fetch watermark')
  expect(containerEl.textContent).toContain('Last sync error summary')
  expect(containerEl.textContent).toContain('Recent sync diagnostics')
  expect(containerEl.textContent).toContain('Copy last sync debug info')
})
```

- [ ] **Step 2: Write the failing docs coverage test/checklist review step**

```ts
it('documents the full bridge JSON contract and failure expectations', async () => {
  const doc = await readDoc('docs/examples/obsidian-otter-sync-command.md')
  expect(doc).toContain('fetched_until')
  expect(doc).toContain('transcript_segments')
  expect(doc).toContain('non-zero exit')
})
```

- [ ] **Step 3: Run the settings tab test to verify it fails**

Run: `npm --prefix obsidian-otter-sync test -- settings-tab.test.ts`
Expected: FAIL because diagnostics UI is missing

- [ ] **Step 4: Implement diagnostics rendering and process-unavailable error messaging in the settings tab**

```ts
new Setting(this.containerEl)
  .setName('Copy last sync debug info')
  .addButton((button) => button.setButtonText('Copy').onClick(() => navigator.clipboard.writeText(debugInfo)))
```

- [ ] **Step 5: Document the command template, JSON contract, and failure expectations**

```md
python /path/to/otter_sync.py --since {since} --mode {mode}
```

- [ ] **Step 6: Write the manual verification checklist**

```md
1. Install the plugin in Obsidian desktop.
2. Configure destination folder and command template.
3. Run first-time `Sync now` and verify first-run backfill behavior.
4. Confirm manual sync feedback shows started, fetching, writing, and completed or failed notices.
5. Run `Force sync now` and verify forced backfill behavior.
6. Wait for scheduled sync and verify quiet success behavior.
7. Update an existing synced note from a newer `modified_time` meeting and verify managed content refresh without renaming the file.
8. Edit `## User Notes`, sync again, and confirm preservation.
9. Force a bridge failure and confirm diagnostics visibility.
```

- [ ] **Step 7: Run the targeted settings tab test**

Run: `npm --prefix obsidian-otter-sync test -- settings-tab.test.ts`
Expected: PASS

- [ ] **Step 8: Run the full plugin test suite**

Run: `npm --prefix obsidian-otter-sync test`
Expected: PASS

- [ ] **Step 9: Build the plugin bundle**

Run: `npm --prefix obsidian-otter-sync run build`
Expected: PASS and emit `main.js`

- [ ] **Step 10: Commit**

```bash
git add obsidian-otter-sync/src/settings-tab.ts obsidian-otter-sync/README.md docs/examples/obsidian-otter-sync-command.md docs/superpowers/manual-verification/obsidian-otter-sync.md obsidian-otter-sync/tests/settings-tab.test.ts
git commit -m "docs: finish Obsidian sync plugin setup"
```

## Chunk Review Checklist

After finishing each chunk above:

- [ ] Dispatch the plan-document-reviewer subagent for that chunk with the spec path `docs/superpowers/specs/2026-03-11-obsidian-otter-sync-design.md`
- [ ] If issues are found, update the plan chunk and re-run review until approved
- [ ] Do not start the next chunk until the current one is approved

## Final Verification

- [ ] Run: `npm --prefix obsidian-otter-sync test`
- [ ] Run: `npm --prefix obsidian-otter-sync run build`
- [ ] Verify the manual checklist in `docs/superpowers/manual-verification/obsidian-otter-sync.md`
- [ ] Confirm the plugin README matches the implemented command-template contract
