import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_DIAGNOSTICS, type DiagnosticsState, type RunRecord } from '../src/diagnostics'
import { DEFAULT_SETTINGS } from '../src/settings'
import { DEFAULT_SYNC_STATE, type RetryEntry, type SyncState } from '../src/state'
import type { BridgePayload, BridgeSpeech } from '../src/sync/schema'
import { computeSince, createSyncOrchestrator } from '../src/sync/orchestrator'
import { createFakeApp, createFakeManifest } from './helpers/fake-app'
import { ensureTestObsidianModule } from './helpers/register-obsidian'

function buildSpeech(overrides: Partial<BridgeSpeech> = {}): BridgeSpeech {
  return {
    otid: 'speech-1',
    source_url: 'https://otter.ai/u/speech-1',
    title: 'Daily Standup',
    created_at: 1_710_000_000,
    modified_time: 1_710_000_100,
    attendees: ['Alice'],
    summary_markdown: 'Summary',
    transcript_segments: [
      {
        speaker_name: 'Alice',
        timestamp: '0:00',
        text: 'Hello',
      },
    ],
    ...overrides,
  }
}

function buildPayload(overrides: Partial<BridgePayload> = {}): BridgePayload {
  return {
    fetched_until: 1_710_000_200,
    speeches: [buildSpeech()],
    ...overrides,
  }
}

function buildRetryEntry(overrides: Partial<RetryEntry> = {}): RetryEntry {
  return {
    ...buildSpeech(),
    failure_reason: 'previous write failed',
    last_attempted_at: '2026-03-12T10:00:00.000Z',
    ...overrides,
  }
}

function makePlugin(overrides: { state?: Partial<SyncState>; settings?: Partial<typeof DEFAULT_SETTINGS>; available?: boolean } = {}) {
  const plugin: {
    app: ReturnType<typeof createFakeApp>
    settings: typeof DEFAULT_SETTINGS
    state: SyncState
    diagnostics: DiagnosticsState
    updateState(update: Partial<SyncState>): Promise<void>
    updateDiagnostics(update: Partial<DiagnosticsState>): Promise<void>
    isLocalProcessExecutionAvailable(): boolean
    addCommand: ReturnType<typeof vi.fn>
  } = {
    app: createFakeApp(),
    settings: {
      ...DEFAULT_SETTINGS,
      destinationFolder: 'Meetings',
      commandTemplate: 'python sync.py {since} {mode}',
      ...overrides.settings,
    },
    state: {
      ...DEFAULT_SYNC_STATE,
      ...overrides.state,
      pendingRetries: [...(overrides.state?.pendingRetries ?? DEFAULT_SYNC_STATE.pendingRetries)],
    },
    diagnostics: { ...DEFAULT_DIAGNOSTICS, recentRuns: [] as RunRecord[] },
    async updateState(update: Partial<SyncState>) {
      this.state = {
        ...this.state,
        ...update,
        pendingRetries: [...(update.pendingRetries ?? this.state.pendingRetries)],
      }
    },
    async updateDiagnostics(update: Partial<DiagnosticsState>) {
      this.diagnostics = {
        ...this.diagnostics,
        ...update,
        recentRuns: [...(update.recentRuns ?? this.diagnostics.recentRuns)],
      }
    },
    isLocalProcessExecutionAvailable() {
      return overrides.available ?? true
    },
    addCommand: vi.fn(),
  }

  return plugin
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function waitForValue<T>(getValue: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = getValue()
    if (value !== undefined) {
      return value
    }

    await Promise.resolve()
  }

  throw new Error('Expected value to become available')
}

describe('computeSince', () => {
  it('uses lastFetchWatermark minus one day for scheduled and manual incremental syncs', () => {
    expect(
      computeSince({
        mode: 'scheduled',
        nowSeconds: 1_800_000_000,
        settings: DEFAULT_SETTINGS,
        state: { ...DEFAULT_SYNC_STATE, lastFetchWatermark: 200_000 },
      }),
    ).toBe(113_600)

    expect(
      computeSince({
        mode: 'manual',
        nowSeconds: 1_800_000_000,
        settings: DEFAULT_SETTINGS,
        state: { ...DEFAULT_SYNC_STATE, lastFetchWatermark: 10_000 },
      }),
    ).toBe(0)
  })

  it('uses first-run backfill defaults when no fetch watermark exists', () => {
    expect(
      computeSince({
        mode: 'scheduled',
        nowSeconds: 1_800_000_000,
        settings: { ...DEFAULT_SETTINGS, firstRunBackfillMode: 'relativeDays', firstRunBackfillValue: 7 },
        state: DEFAULT_SYNC_STATE,
      }),
    ).toBe(1_799_395_200)

    expect(
      computeSince({
        mode: 'manual',
        nowSeconds: 1_800_000_000,
        settings: { ...DEFAULT_SETTINGS, firstRunBackfillMode: 'absoluteDate', firstRunBackfillValue: '2026-03-01' },
        state: DEFAULT_SYNC_STATE,
      }),
    ).toBe(1_772_323_200)
  })

  it('uses forced backfill settings for forced syncs', () => {
    expect(
      computeSince({
        mode: 'forced',
        nowSeconds: 1_800_000_000,
        settings: { ...DEFAULT_SETTINGS, forcedBackfillMode: 'relativeDays', forcedBackfillValue: 30 },
        state: { ...DEFAULT_SYNC_STATE, lastFetchWatermark: 999_999_999 },
      }),
    ).toBe(1_797_408_000)
  })
})

describe('sync orchestrator', () => {
  it('shows manual started, fetching, writing, and completed notices with counts', async () => {
    const notices: string[] = []
    const plugin = makePlugin()
    const orchestrator = createSyncOrchestrator(plugin, {
      now: () => 1_800_000_000_000,
      notify: (message) => {
        notices.push(message)
      },
      runBridgeCommand: vi.fn().mockResolvedValue({ payload: buildPayload(), stdout: '{}', stderr: '', exitCode: 0 }),
      synchronizeNotes: vi.fn().mockResolvedValue({
        notes: [
          { otid: 'speech-1', status: 'created', path: 'Meetings/Daily Standup.md', normalized: false, diagnostics: [] },
        ],
        diagnostics: [],
        stopped: false,
      }),
    })

    await orchestrator.runSync('manual')

    expect(notices).toEqual([
      'Sync started.',
      'Fetching Otter meetings...',
      'Writing meeting notes...',
      'Sync completed: 1 created, 0 updated, 0 skipped, 0 failed.',
    ])
  })

  it('shows manual failure notices with counts in the summary', async () => {
    const notices: string[] = []
    const plugin = makePlugin()
    const orchestrator = createSyncOrchestrator(plugin, {
      now: () => 1_800_000_000_000,
      notify: (message) => {
        notices.push(message)
      },
      runBridgeCommand: vi.fn().mockResolvedValue({ payload: buildPayload(), stdout: '{}', stderr: '', exitCode: 0 }),
      synchronizeNotes: vi.fn().mockResolvedValue({
        notes: [
          {
            otid: 'speech-1',
            status: 'failed',
            path: 'Meetings/Daily Standup.md',
            normalized: false,
            diagnostics: [{ code: 'unsafe-user-notes', message: 'Vault modify failed' }],
          },
        ],
        diagnostics: [],
        stopped: false,
      }),
    })

    await expect(orchestrator.runSync('manual')).rejects.toThrow('Vault modify failed')

    expect(notices).toEqual([
      'Sync started.',
      'Fetching Otter meetings...',
      'Writing meeting notes...',
      'Sync failed: 0 created, 0 updated, 0 skipped, 1 failed. Vault modify failed',
    ])
  })

  it('keeps scheduled successes quiet by default and optionally announces them', async () => {
    const quietNotices: string[] = []
    const quietPlugin = makePlugin()
    const quietOrchestrator = createSyncOrchestrator(quietPlugin, {
      notify: (message) => {
        quietNotices.push(message)
      },
      runBridgeCommand: vi.fn().mockResolvedValue({ payload: buildPayload(), stdout: '{}', stderr: '', exitCode: 0 }),
      synchronizeNotes: vi.fn().mockResolvedValue({ notes: [], diagnostics: [], stopped: false }),
    })

    await quietOrchestrator.runSync('scheduled')
    expect(quietNotices).toEqual([])

    const noisyNotices: string[] = []
    const noisyPlugin = makePlugin({ settings: { showScheduledSuccessNotice: true } })
    const noisyOrchestrator = createSyncOrchestrator(noisyPlugin, {
      notify: (message) => {
        noisyNotices.push(message)
      },
      runBridgeCommand: vi.fn().mockResolvedValue({ payload: buildPayload(), stdout: '{}', stderr: '', exitCode: 0 }),
      synchronizeNotes: vi.fn().mockResolvedValue({ notes: [], diagnostics: [], stopped: false }),
    })

    await noisyOrchestrator.runSync('scheduled')
    expect(noisyNotices).toEqual(['Sync completed: 0 created, 0 updated, 0 skipped, 0 failed.'])
  })

  it('surfaces scheduled failures and records full diagnostics fields', async () => {
    const notices: string[] = []
    const plugin = makePlugin()
    const orchestrator = createSyncOrchestrator(plugin, {
      now: () => 1_800_000_000_000,
      notify: (message) => {
        notices.push(message)
      },
      runBridgeCommand: vi.fn().mockRejectedValue(Object.assign(new Error('Python bridge command exited with code 7'), {
        stderr: 'traceback\nline 2',
        exitCode: 7,
      })),
      synchronizeNotes: vi.fn(),
    })

    await expect(orchestrator.runSync('scheduled')).rejects.toThrow('Python bridge command exited with code 7')

    expect(notices).toEqual(['Scheduled sync failed: Python bridge command exited with code 7'])
    expect(plugin.diagnostics.recentRuns).toHaveLength(1)
    expect(plugin.diagnostics.recentRuns[0]).toMatchObject({
      runMode: 'scheduled',
      fetchWatermarkUsed: 1_799_395_200,
      fetchedUntil: null,
      retryReplay: false,
      counts: { created: 0, updated: 0, skipped: 0, failed: 0 },
      exitCode: 7,
      stderrSnippet: 'traceback\nline 2',
      speechCount: 0,
      errorSummary: 'Python bridge command exited with code 7',
      noteFailures: [],
    })
    expect(plugin.diagnostics.recentRuns[0]?.commandSummary).toBeDefined()
  })

  it('records a fatal note-stage failure summary in diagnostics', async () => {
    const plugin = makePlugin()
    const orchestrator = createSyncOrchestrator(plugin, {
      now: () => 1_800_000_000_000,
      notify: () => undefined,
      runBridgeCommand: vi.fn().mockResolvedValue({ payload: buildPayload(), stdout: '{}', stderr: '', exitCode: 0 }),
      synchronizeNotes: vi.fn().mockResolvedValue({
        notes: [],
        diagnostics: [{ code: 'destination-folder-create-failed', message: 'Failed to create destination folder.', fatal: true }],
        stopped: true,
      }),
    })

    await expect(orchestrator.runSync('manual')).rejects.toThrow('Failed to create destination folder.')

    expect(plugin.diagnostics.recentRuns[0]).toMatchObject({
      counts: { created: 0, updated: 0, skipped: 0, failed: 0 },
      errorSummary: 'Failed to create destination folder.',
      noteFailures: [],
    })
  })

  it('persists non-fatal synchronizer diagnostics on successful note processing', async () => {
    const plugin = makePlugin()
    const orchestrator = createSyncOrchestrator(plugin, {
      now: () => 1_800_000_000_000,
      notify: () => undefined,
      runBridgeCommand: vi.fn().mockResolvedValue({ payload: buildPayload(), stdout: '{}', stderr: '', exitCode: 0 }),
      synchronizeNotes: vi.fn().mockResolvedValue({
        notes: [
          { otid: 'speech-1', status: 'updated', path: 'Meetings/Daily Standup.md', normalized: false, diagnostics: [] },
        ],
        diagnostics: [
          {
            code: 'invalid-legacy-source',
            message: 'Existing note has an unparseable legacy source value.',
            path: 'Meetings/unparseable.md',
          },
        ],
        stopped: false,
      }),
    })

    await orchestrator.runSync('manual')

    expect(plugin.diagnostics.recentRuns[0]).toMatchObject({
      counts: { created: 0, updated: 1, skipped: 0, failed: 0 },
      errorSummary: null,
      noteFailures: [],
      synchronizerDiagnostics: [
        {
          code: 'invalid-legacy-source',
          message: 'Existing note has an unparseable legacy source value.',
          path: 'Meetings/unparseable.md',
        },
      ],
    })
  })

  it('queues fetched speeches for retry when note processing stops fatally before per-note failures', async () => {
    const plugin = makePlugin()
    const orchestrator = createSyncOrchestrator(plugin, {
      now: () => 1_800_000_000_000,
      notify: () => undefined,
      runBridgeCommand: vi.fn().mockResolvedValue({
        payload: buildPayload({
          speeches: [
            buildSpeech({ otid: 'speech-1', modified_time: 200, title: 'Fetched speech one' }),
            buildSpeech({ otid: 'speech-2', modified_time: 300, title: 'Fetched speech two', source_url: 'https://otter.ai/u/speech-2' }),
          ],
        }),
        stdout: '{}',
        stderr: '',
        exitCode: 0,
      }),
      synchronizeNotes: vi.fn().mockResolvedValue({
        notes: [],
        diagnostics: [{ code: 'destination-folder-create-failed', message: 'Failed before note writes.', fatal: true }],
        stopped: true,
      }),
    })

    await expect(orchestrator.runSync('manual')).rejects.toThrow('Failed before note writes.')

    expect(plugin.state.pendingRetries).toEqual([
      expect.objectContaining({ otid: 'speech-1', modified_time: 200, title: 'Fetched speech one', failure_reason: 'Failed before note writes.' }),
      expect.objectContaining({ otid: 'speech-2', modified_time: 300, title: 'Fetched speech two', failure_reason: 'Failed before note writes.' }),
    ])
  })

  it('records diagnostics and preserves retries when synchronizeNotes throws after a successful fetch', async () => {
    const notices: string[] = []
    const plugin = makePlugin()
    const orchestrator = createSyncOrchestrator(plugin, {
      now: () => 1_800_000_000_000,
      notify: (message) => {
        notices.push(message)
      },
      runBridgeCommand: vi.fn().mockResolvedValue({
        payload: buildPayload({
          fetched_until: 1_710_000_999,
          speeches: [
            buildSpeech({ otid: 'speech-1', modified_time: 200, title: 'Fetched speech one' }),
            buildSpeech({ otid: 'speech-2', modified_time: 300, title: 'Fetched speech two', source_url: 'https://otter.ai/u/speech-2' }),
          ],
        }),
        stdout: '{}',
        stderr: '',
        exitCode: 0,
      }),
      synchronizeNotes: vi.fn().mockRejectedValue(new Error('Vault crashed during note sync')),
    })

    await expect(orchestrator.runSync('manual')).rejects.toThrow('Vault crashed during note sync')

    expect(plugin.state.lastFetchWatermark).toBe(1_710_000_999)
    expect(plugin.state.pendingRetries).toEqual([
      expect.objectContaining({ otid: 'speech-1', modified_time: 200, title: 'Fetched speech one', failure_reason: 'Vault crashed during note sync' }),
      expect.objectContaining({ otid: 'speech-2', modified_time: 300, title: 'Fetched speech two', failure_reason: 'Vault crashed during note sync' }),
    ])
    expect(plugin.diagnostics.recentRuns[0]).toMatchObject({
      fetchedUntil: 1_710_000_999,
      counts: { created: 0, updated: 0, skipped: 0, failed: 0 },
      errorSummary: 'Vault crashed during note sync',
      noteFailures: [],
      speechCount: 2,
    })
    expect(notices).toEqual([
      'Sync started.',
      'Fetching Otter meetings...',
      'Writing meeting notes...',
      'Sync failed: 0 created, 0 updated, 0 skipped, 0 failed. Vault crashed during note sync',
    ])
  })

  it('rejects overlapping runs and releases the lock after completion and failure', async () => {
    let resolveNotes: ((value: { notes: never[]; diagnostics: never[]; stopped: false }) => void) | undefined
    const plugin = makePlugin()
    const synchronizeNotes = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNotes = resolve
          }),
      )
      .mockResolvedValue({ notes: [], diagnostics: [], stopped: false })
    const orchestrator = createSyncOrchestrator(plugin, {
      notify: () => undefined,
      runBridgeCommand: vi.fn().mockResolvedValue({ payload: buildPayload(), stdout: '{}', stderr: '', exitCode: 0 }),
      synchronizeNotes,
    })
    
    const firstRun = orchestrator.runSync('manual')
    await expect(orchestrator.runSync('manual')).rejects.toThrow('A sync is already in progress')
    ;(await waitForValue(() => resolveNotes))({ notes: [], diagnostics: [], stopped: false })
    await firstRun

    await expect(orchestrator.runSync('manual')).resolves.toMatchObject({ status: 'success' })

    const failingOrchestrator = createSyncOrchestrator(makePlugin(), {
      notify: () => undefined,
      runBridgeCommand: vi.fn().mockRejectedValue(new Error('timeout failure')),
      synchronizeNotes: vi.fn(),
    })

    await expect(failingOrchestrator.runSync('manual')).rejects.toThrow('timeout failure')
    await expect(failingOrchestrator.runSync('manual')).rejects.toThrow('timeout failure')
  })

  it('advances lastFetchWatermark after bridge fetch even when a note write fails', async () => {
    const plugin = makePlugin()
    const orchestrator = createSyncOrchestrator(plugin, {
      now: () => 1_800_000_000_000,
      runBridgeCommand: vi.fn().mockResolvedValue({
        payload: buildPayload({ fetched_until: 1_710_000_999 }),
        stdout: '{}',
        stderr: '',
        exitCode: 0,
      }),
      synchronizeNotes: vi.fn().mockResolvedValue({
        notes: [
          {
            otid: 'speech-1',
            status: 'failed',
            path: 'Meetings/Daily Standup.md',
            normalized: false,
            diagnostics: [{ code: 'unsafe-user-notes', message: 'Vault modify failed' }],
          },
        ],
        diagnostics: [],
        stopped: false,
      }),
    })

    await expect(orchestrator.runSync('manual')).rejects.toThrow('Vault modify failed')

    expect(plugin.state.lastFetchWatermark).toBe(1_710_000_999)
  })

  it('advances lastCleanSyncTime only on fully clean runs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-12T12:00:00.000Z'))

    const cleanPlugin = makePlugin()
    const cleanOrchestrator = createSyncOrchestrator(cleanPlugin, {
      notify: () => undefined,
      runBridgeCommand: vi.fn().mockResolvedValue({ payload: buildPayload(), stdout: '{}', stderr: '', exitCode: 0 }),
      synchronizeNotes: vi.fn().mockResolvedValue({ notes: [], diagnostics: [], stopped: false }),
    })
    await cleanOrchestrator.runSync('manual')
    expect(cleanPlugin.state.lastCleanSyncTime).toBe(1_773_316_800_000)

    const noteFailurePlugin = makePlugin()
    const noteFailureOrchestrator = createSyncOrchestrator(noteFailurePlugin, {
      notify: () => undefined,
      runBridgeCommand: vi.fn().mockResolvedValue({ payload: buildPayload(), stdout: '{}', stderr: '', exitCode: 0 }),
      synchronizeNotes: vi.fn().mockResolvedValue({
        notes: [{ otid: 'speech-1', status: 'failed', normalized: false, diagnostics: [{ code: 'unsafe-user-notes', message: 'write failed' }] }],
        diagnostics: [],
        stopped: false,
      }),
    })
    await expect(noteFailureOrchestrator.runSync('manual')).rejects.toThrow('write failed')
    expect(noteFailurePlugin.state.lastCleanSyncTime).toBeNull()

    const bridgeFailurePlugin = makePlugin()
    const bridgeFailureOrchestrator = createSyncOrchestrator(bridgeFailurePlugin, {
      notify: () => undefined,
      runBridgeCommand: vi.fn().mockRejectedValue(new Error('bridge failed')),
      synchronizeNotes: vi.fn(),
    })
    await expect(bridgeFailureOrchestrator.runSync('manual')).rejects.toThrow('bridge failed')
    expect(bridgeFailurePlugin.state.lastCleanSyncTime).toBeNull()
  })

  it('replays pending retries and merges by otid with the freshest modified_time', async () => {
    const plugin = makePlugin({
      state: {
        pendingRetries: [buildRetryEntry({ otid: 'speech-1', modified_time: 100, title: 'Stale retry' })],
      },
    })
    const synchronizeNotes = vi.fn().mockResolvedValue({
      notes: [
        { otid: 'speech-1', status: 'updated', path: 'Meetings/Daily Standup.md', normalized: false, diagnostics: [] },
        {
          otid: 'speech-2',
          status: 'failed',
          path: 'Meetings/Planning.md',
          normalized: false,
          diagnostics: [{ code: 'unsafe-user-notes', message: 'new failure' }],
        },
      ],
      diagnostics: [],
      stopped: false,
    })
    const orchestrator = createSyncOrchestrator(plugin, {
      now: () => 1_800_000_000_000,
      runBridgeCommand: vi.fn().mockResolvedValue({
        payload: buildPayload({
          speeches: [
            buildSpeech({ otid: 'speech-1', modified_time: 200, title: 'Fresh fetch wins' }),
            buildSpeech({ otid: 'speech-2', modified_time: 300, title: 'Fresh failure' }),
          ],
        }),
        stdout: '{}',
        stderr: '',
        exitCode: 0,
      }),
      synchronizeNotes,
    })

    await expect(orchestrator.runSync('manual')).rejects.toThrow('new failure')

    expect(synchronizeNotes).toHaveBeenCalledWith(
      expect.objectContaining({
        speeches: [
          expect.objectContaining({ otid: 'speech-1', modified_time: 200, title: 'Fresh fetch wins' }),
          expect.objectContaining({ otid: 'speech-2', modified_time: 300, title: 'Fresh failure' }),
        ],
      }),
    )
    expect(plugin.state.pendingRetries).toEqual([
      expect.objectContaining({ otid: 'speech-2', modified_time: 300, title: 'Fresh failure', failure_reason: 'new failure' }),
    ])
  })

  it('rejects syncs cleanly when local process execution is unavailable', async () => {
    const notices: string[] = []
    const plugin = makePlugin({ available: false })
    const orchestrator = createSyncOrchestrator(plugin, {
      notify: (message) => {
        notices.push(message)
      },
      runBridgeCommand: vi.fn(),
      synchronizeNotes: vi.fn(),
    })

    await expect(orchestrator.runSync('manual')).rejects.toThrow('Sync requires Obsidian desktop with local process execution enabled')
    expect(notices).toEqual([
      'Sync failed: 0 created, 0 updated, 0 skipped, 0 failed. Sync requires Obsidian desktop with local process execution enabled',
    ])
  })

  it.each(['manual', 'forced'] as const)(
    'rejects %s syncs before bridge or note work when required settings are missing',
    async (mode) => {
      const notices: string[] = []
      const plugin = makePlugin({ settings: { destinationFolder: '   ' } })
      const runBridgeCommand = vi.fn()
      const synchronizeNotes = vi.fn()
      const orchestrator = createSyncOrchestrator(plugin, {
        notify: (message) => {
          notices.push(message)
        },
        runBridgeCommand,
        synchronizeNotes,
      })

      await expect(orchestrator.runSync(mode)).rejects.toThrow('Sync requires destination folder to be configured before syncing')

      expect(runBridgeCommand).not.toHaveBeenCalled()
      expect(synchronizeNotes).not.toHaveBeenCalled()
      expect(notices).toEqual([
        'Sync failed: 0 created, 0 updated, 0 skipped, 0 failed. Sync requires destination folder to be configured before syncing',
      ])
    },
  )

  it('includes zero counts in early manual bridge failure notices', async () => {
    const notices: string[] = []
    const plugin = makePlugin()
    const orchestrator = createSyncOrchestrator(plugin, {
      notify: (message) => {
        notices.push(message)
      },
      runBridgeCommand: vi.fn().mockRejectedValue(new Error('bridge failed before writes')),
      synchronizeNotes: vi.fn(),
    })

    await expect(orchestrator.runSync('manual')).rejects.toThrow('bridge failed before writes')

    expect(notices).toEqual([
      'Sync started.',
      'Fetching Otter meetings...',
      'Sync failed: 0 created, 0 updated, 0 skipped, 0 failed. bridge failed before writes',
    ])
  })
})

describe('plugin integration', () => {
  it('registers sync commands on load, runs an immediate scheduled sync, and starts then clears interval scheduling when required settings are configured', async () => {
    await ensureTestObsidianModule()
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest()) as InstanceType<typeof OtterSyncPlugin> & {
      addCommand: ReturnType<typeof vi.fn>
    }
    plugin.addCommand = vi.fn()
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      destinationFolder: 'Meetings',
      commandTemplate: 'python sync.py {since} {mode}',
      syncIntervalMinutes: 15,
    }
    vi.spyOn(plugin, 'loadSettings').mockResolvedValue(plugin.settings)
    vi.spyOn(plugin, 'loadState').mockResolvedValue(plugin.state)
    vi.spyOn(plugin, 'loadDiagnostics').mockResolvedValue(plugin.diagnostics)
    const runSyncSpy = vi.spyOn((plugin as unknown as { orchestrator: { runSync: (mode: string) => Promise<unknown> } }).orchestrator, 'runSync').mockResolvedValue({
      status: 'success',
      counts: { created: 0, updated: 0, skipped: 0, failed: 0 },
      fetchedUntil: 1,
    })

    const intervalHandle = { id: 1 } as unknown as ReturnType<typeof setInterval>
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(intervalHandle)
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined)

    await plugin.onload()

    expect(runSyncSpy).toHaveBeenCalledWith('scheduled')
    expect(plugin.addCommand).toHaveBeenCalledTimes(2)
    expect(plugin.addCommand).toHaveBeenCalledWith(expect.objectContaining({ id: 'sync-now', name: 'Sync now' }))
    expect(plugin.addCommand).toHaveBeenCalledWith(expect.objectContaining({ id: 'force-sync-now', name: 'Force sync now' }))
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 900_000)

    await plugin.onunload()
    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandle)
  })

  it('skips scheduled startup work when required settings are blank', async () => {
    await ensureTestObsidianModule()
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest()) as InstanceType<typeof OtterSyncPlugin> & {
      addCommand: ReturnType<typeof vi.fn>
    }
    plugin.addCommand = vi.fn()
    plugin.settings = { ...DEFAULT_SETTINGS }
    vi.spyOn(plugin, 'loadSettings').mockResolvedValue(plugin.settings)
    vi.spyOn(plugin, 'loadState').mockResolvedValue(plugin.state)
    vi.spyOn(plugin, 'loadDiagnostics').mockResolvedValue(plugin.diagnostics)
    const runSyncSpy = vi.spyOn((plugin as unknown as { orchestrator: { runSync: (mode: string) => Promise<unknown> } }).orchestrator, 'runSync').mockResolvedValue({
      status: 'success',
      counts: { created: 0, updated: 0, skipped: 0, failed: 0 },
      fetchedUntil: 1,
    })

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    await plugin.onload()

    expect(runSyncSpy).not.toHaveBeenCalled()
    expect(plugin.addCommand).toHaveBeenCalledTimes(2)
    expect(setIntervalSpy).not.toHaveBeenCalled()
  })

  it('skips scheduled startup work when local process execution is unavailable', async () => {
    await ensureTestObsidianModule()
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(
      createFakeApp({ isDesktopOnly: false, processExecutionAvailable: false }),
      createFakeManifest(),
    ) as InstanceType<typeof OtterSyncPlugin> & {
      addCommand: ReturnType<typeof vi.fn>
    }
    plugin.addCommand = vi.fn()
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      destinationFolder: 'Meetings',
      commandTemplate: 'python sync.py {since} {mode}',
      syncIntervalMinutes: 15,
    }
    vi.spyOn(plugin, 'loadSettings').mockResolvedValue(plugin.settings)
    vi.spyOn(plugin, 'loadState').mockResolvedValue(plugin.state)
    vi.spyOn(plugin, 'loadDiagnostics').mockResolvedValue(plugin.diagnostics)
    const runSyncSpy = vi.spyOn((plugin as unknown as { orchestrator: { runSync: (mode: string) => Promise<unknown> } }).orchestrator, 'runSync').mockResolvedValue({
      status: 'success',
      counts: { created: 0, updated: 0, skipped: 0, failed: 0 },
      fetchedUntil: 1,
    })

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    await plugin.onload()

    expect(runSyncSpy).not.toHaveBeenCalled()
    expect(plugin.addCommand).toHaveBeenCalledTimes(2)
    expect(setIntervalSpy).not.toHaveBeenCalled()
  })
})
