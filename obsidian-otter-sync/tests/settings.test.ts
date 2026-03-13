import { describe, expect, it, vi } from 'vitest'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

import { DEFAULT_DIAGNOSTICS } from '../src/diagnostics'
import { DEFAULT_SETTINGS } from '../src/settings'
import { DEFAULT_SYNC_STATE } from '../src/state'
import { createFakeApp, createFakeManifest } from './helpers/fake-app'
import { ensureTestObsidianModule, restoreTestObsidianModule } from './helpers/register-obsidian'

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

  it('loads settings state and diagnostics from the plugin data envelope', async () => {
    await ensureTestObsidianModule()
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest())
    vi.spyOn(plugin, 'loadData').mockResolvedValue({
      settings: {
        destinationFolder: 'Meetings',
        syncIntervalMinutes: 15,
      },
      state: {
        lastFetchWatermark: 101,
      },
      diagnostics: {
        lastErrorSummary: 'sync failed',
      },
    })

    await plugin.loadSettings()
    await plugin.loadState()
    await plugin.loadDiagnostics()

    expect(plugin.settings).toEqual({
      ...DEFAULT_SETTINGS,
      destinationFolder: 'Meetings',
      syncIntervalMinutes: 15,
    })
    expect(plugin.state).toEqual({
      ...DEFAULT_SYNC_STATE,
      lastFetchWatermark: 101,
    })
    expect(plugin.diagnostics).toEqual({
      ...DEFAULT_DIAGNOSTICS,
      lastErrorSummary: 'sync failed',
    })
  })

  it('keeps settings defaults when plugin data is missing or partial', async () => {
    await ensureTestObsidianModule()
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest())
    vi.spyOn(plugin, 'loadData').mockResolvedValue({
      settings: {
        destinationFolder: 'Inbox',
      },
    })

    await plugin.loadSettings()
    await plugin.loadState()
    await plugin.loadDiagnostics()

    expect(plugin.settings).toEqual({
      ...DEFAULT_SETTINGS,
      destinationFolder: 'Inbox',
      showScheduledSuccessNotice: false,
    })
    expect(plugin.state).toEqual(DEFAULT_SYNC_STATE)
    expect(plugin.diagnostics).toEqual(DEFAULT_DIAGNOSTICS)
  })

  it('persists settings updates through the explicit data envelope', async () => {
    await ensureTestObsidianModule()
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest())
    plugin.settings = { ...DEFAULT_SETTINGS }
    plugin.state = {
      ...DEFAULT_SYNC_STATE,
      lastCleanSyncTime: 123,
    }
    plugin.diagnostics = {
      ...DEFAULT_DIAGNOSTICS,
      lastErrorSummary: 'still here',
    }
    const saveData = vi.spyOn(plugin, 'saveData').mockResolvedValue()

    await plugin.updateSettings({ destinationFolder: 'Archive', showScheduledSuccessNotice: true })

    expect(saveData).toHaveBeenCalledWith({
      settings: {
        ...DEFAULT_SETTINGS,
        destinationFolder: 'Archive',
        showScheduledSuccessNotice: true,
      },
      state: {
        ...DEFAULT_SYNC_STATE,
        lastCleanSyncTime: 123,
      },
      diagnostics: {
        ...DEFAULT_DIAGNOSTICS,
        lastErrorSummary: 'still here',
      },
    })
  })

  it('does not start scheduling when required settings become available in unsupported environments', async () => {
    await ensureTestObsidianModule()
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(
      createFakeApp({ isDesktopOnly: false, processExecutionAvailable: false }),
      createFakeManifest(),
    )
    plugin.settings = { ...DEFAULT_SETTINGS }
    plugin.state = { ...DEFAULT_SYNC_STATE }
    plugin.diagnostics = { ...DEFAULT_DIAGNOSTICS }
    vi.spyOn(plugin, 'saveData').mockResolvedValue()

    const orchestrator = (plugin as unknown as {
      orchestrator: {
        startScheduling: () => void
        stopScheduling: () => void
      }
    }).orchestrator
    const stopSchedulingSpy = vi.spyOn(orchestrator, 'stopScheduling')
    const startSchedulingSpy = vi.spyOn(orchestrator, 'startScheduling')

    await plugin.updateSettings({
      destinationFolder: 'Meetings',
      commandTemplate: 'python sync.py {since} {mode}',
    })

    expect(stopSchedulingSpy).not.toHaveBeenCalled()
    expect(startSchedulingSpy).not.toHaveBeenCalled()
  })

  it('persists the latest logical state when overlapping saves finish out of order', async () => {
    await ensureTestObsidianModule()
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest())
    plugin.settings = { ...DEFAULT_SETTINGS }
    plugin.state = { ...DEFAULT_SYNC_STATE }
    plugin.diagnostics = { ...DEFAULT_DIAGNOSTICS }

    let persistedData: unknown = null
    const pendingSaves: Array<{ payload: unknown; resolve: () => void }> = []

    vi.spyOn(plugin, 'saveData').mockImplementation((payload) => {
      return new Promise<void>((resolve) => {
        pendingSaves.push({
          payload,
          resolve: () => {
            persistedData = payload
            resolve()
          },
        })
      })
    })

    const saveSettingsPromise = plugin.updateSettings({ destinationFolder: 'Archive' })
    const saveStatePromise = plugin.updateState({ lastFetchWatermark: 101 })

    expect(pendingSaves).toHaveLength(1)

    pendingSaves[0]?.resolve()
    await Promise.resolve()

    expect(pendingSaves).toHaveLength(2)

    pendingSaves[1]?.resolve()

    await Promise.all([saveSettingsPromise, saveStatePromise])

    expect(persistedData).toEqual({
      settings: {
        ...DEFAULT_SETTINGS,
        destinationFolder: 'Archive',
      },
      state: {
        ...DEFAULT_SYNC_STATE,
        lastFetchWatermark: 101,
      },
      diagnostics: {
        ...DEFAULT_DIAGNOSTICS,
      },
    })
  })

  it('isolates mutable state and diagnostics arrays across fresh loads', async () => {
    await ensureTestObsidianModule()
    const { default: OtterSyncPlugin } = await import('../src/main')
    const firstPlugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest())
    const secondPlugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest())

    vi.spyOn(firstPlugin, 'loadData').mockResolvedValue({})
    vi.spyOn(secondPlugin, 'loadData').mockResolvedValue({})

    await firstPlugin.loadState()
    await firstPlugin.loadDiagnostics()
    await secondPlugin.loadState()
    await secondPlugin.loadDiagnostics()

    firstPlugin.state.pendingRetries.push({
      otid: 'speech-1',
      source_url: 'https://otter.ai/u/speech-1',
      title: 'Retry me',
      created_at: 1,
      modified_time: 2,
      attendees: [],
      summary_markdown: '',
      transcript_segments: [],
      failure_reason: 'retry',
      last_attempted_at: '2026-03-12T10:00:00.000Z',
    })
    firstPlugin.diagnostics.recentRuns.push({
      runMode: 'manual',
      startedAt: '2026-03-12T10:00:00.000Z',
      endedAt: '2026-03-12T10:00:01.000Z',
      fetchWatermarkUsed: null,
      fetchedUntil: null,
      retryReplay: false,
      counts: { created: 0, updated: 0, skipped: 0, failed: 0 },
      commandSummary: {
        configured: false,
        hasQuotedPlaceholders: false,
        hasSincePlaceholder: false,
        hasModePlaceholder: false,
        shell: { command: '/bin/sh', args: ['-lc'] },
      },
      exitCode: null,
      stderrSnippet: null,
      speechCount: 0,
      errorSummary: null,
      noteFailures: [],
    })

    expect(firstPlugin.state.pendingRetries).toEqual([
      expect.objectContaining({ otid: 'speech-1', failure_reason: 'retry' }),
    ])
    expect(firstPlugin.diagnostics.recentRuns).toEqual([
      expect.objectContaining({ runMode: 'manual', speechCount: 0 }),
    ])
    expect(secondPlugin.state.pendingRetries).toEqual([])
    expect(secondPlugin.diagnostics.recentRuns).toEqual([])
    expect(DEFAULT_SYNC_STATE.pendingRetries).toEqual([])
    expect(DEFAULT_DIAGNOSTICS.recentRuns).toEqual([])
  })

  it('restores the obsidian test shim after setup', async () => {
    const packageJsonPath = path.resolve(import.meta.dirname, '../node_modules/obsidian/package.json')
    const entryPath = path.resolve(import.meta.dirname, '../node_modules/obsidian/index.mjs')
    const originalPackageJson = await readFile(packageJsonPath, 'utf8')
    const originalEntry = await readFile(entryPath, 'utf8').catch(() => null)

    await ensureTestObsidianModule()
    await restoreTestObsidianModule()

    expect(await readFile(packageJsonPath, 'utf8')).toBe(originalPackageJson)

    if (originalEntry === null) {
      await expect(access(entryPath)).rejects.toThrow()
    } else {
      expect(await readFile(entryPath, 'utf8')).toBe(originalEntry)
    }
  })
})
