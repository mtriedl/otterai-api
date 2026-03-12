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
