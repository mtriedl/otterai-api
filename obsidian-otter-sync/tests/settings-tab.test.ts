import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginSettingTab, RecordedSetting } from './helpers/obsidian'

import { DEFAULT_DIAGNOSTICS } from '../src/diagnostics'
import { DEFAULT_SETTINGS } from '../src/settings'
import { DEFAULT_SYNC_STATE } from '../src/state'
import { createFakeApp, createFakeManifest } from './helpers/fake-app'
import { ensureTestObsidianModule, restoreTestObsidianModule } from './helpers/register-obsidian'

function getRecordedSettings(tab: PluginSettingTab): RecordedSetting[] {
  return tab.containerEl.children as RecordedSetting[]
}

function getRecordedSetting(tab: PluginSettingTab, name: string): RecordedSetting {
  const setting = getRecordedSettings(tab).find((item) => item.name === name)

  if (!setting) {
    throw new Error(`Missing recorded setting: ${name}`)
  }

  return setting
}

describe('OtterSync settings tab', () => {
  beforeEach(async () => {
    vi.resetModules()
    await ensureTestObsidianModule()
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await restoreTestObsidianModule()
  })

  it('renders all Task 2 settings and diagnostics fields', async () => {
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest())
    plugin.settings = { ...DEFAULT_SETTINGS }
    plugin.state = {
      ...DEFAULT_SYNC_STATE,
      lastCleanSyncTime: 1710000000000,
      lastFetchWatermark: 1710000001000,
    }
    plugin.diagnostics = {
      ...DEFAULT_DIAGNOSTICS,
      lastErrorSummary: 'Latest sync failed',
      recentRuns: [{ status: 'ok' }],
    }

    const { OtterSyncSettingTab } = await import('../src/settings-tab')
    const tab = new OtterSyncSettingTab(plugin.app as never, plugin)

    tab.display()

    expect(getRecordedSettings(tab).map((setting) => setting.name)).toEqual([
      'Destination folder',
      'Sync cadence',
      'Python sync command template',
      'First-run backfill',
      'Forced sync backfill',
      'Show scheduled success notices',
      'Last clean sync time',
      'Last fetch watermark',
      'Last sync error summary',
      'Recent sync diagnostics',
      'Copy last sync debug info',
    ])
  })

  it('renders diagnostics with readable summaries and debug copy guidance', async () => {
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest())
    plugin.settings = { ...DEFAULT_SETTINGS, destinationFolder: 'notes' }
    plugin.state = {
      ...DEFAULT_SYNC_STATE,
      lastCleanSyncTime: 1710000000000,
      lastFetchWatermark: 1710000001,
    }
    plugin.diagnostics = {
      ...DEFAULT_DIAGNOSTICS,
      lastErrorSummary: 'Only from diagnostics',
      recentRuns: [
        {
          runMode: 'forced',
          startedAt: '2026-03-10T12:00:00.000Z',
          endedAt: '2026-03-10T12:00:03.000Z',
          fetchWatermarkUsed: 1710000001,
          fetchedUntil: 1710003601,
          retryReplay: false,
          counts: {
            created: 2,
            updated: 1,
            skipped: 0,
            failed: 1,
          },
          commandSummary: {
            configured: true,
            hasQuotedPlaceholders: false,
            hasSincePlaceholder: true,
            hasModePlaceholder: true,
            shell: {
              command: '/bin/sh',
              args: ['-lc'],
            },
          },
          exitCode: 0,
          stderrSnippet: null,
          speechCount: 4,
          errorSummary: 'One note failed',
          noteFailures: [
            {
              otid: 'otter-1',
              source_url: 'https://otter.ai/u/example',
              notePath: 'Meetings/Example.md',
              reason: 'Vault write failed',
            },
          ],
        },
      ],
    }

    const { OtterSyncSettingTab } = await import('../src/settings-tab')
    const tab = new OtterSyncSettingTab(plugin.app as never, plugin)

    tab.display()

    expect(plugin.settings).toEqual({
      ...DEFAULT_SETTINGS,
      destinationFolder: 'notes',
    })
    expect(getRecordedSetting(tab, 'Last clean sync time').textValues[0]).toBe('2024-03-09T16:00:00.000Z')
    expect(getRecordedSetting(tab, 'Last fetch watermark').textValues[0]).toBe(
      '1710000001 (2024-03-09T16:00:01.000Z UTC)',
    )
    expect(getRecordedSetting(tab, 'Last sync error summary').textAreaValues[0]).toBe('Only from diagnostics')
    expect(getRecordedSetting(tab, 'Recent sync diagnostics').textAreaValues[0]).toContain(
      'Forced run at 2026-03-10T12:00:00.000Z',
    )
    expect(getRecordedSetting(tab, 'Recent sync diagnostics').textAreaValues[0]).toContain(
      'Counts: 2 created, 1 updated, 0 skipped, 1 failed',
    )
    expect(getRecordedSetting(tab, 'Recent sync diagnostics').textAreaValues[0]).toContain(
      'Note failure: otter-1 -> Vault write failed',
    )
    expect(getRecordedSetting(tab, 'Copy last sync debug info').desc).toContain(
      'Copies settings, state, and diagnostics with the command template redacted.',
    )
    expect(getRecordedSetting(tab, 'Copy last sync debug info').buttons).toContain('Copy debug info')
  })

  it('persists editable first-run and forced-sync backfill controls', async () => {
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest())
    plugin.settings = { ...DEFAULT_SETTINGS }
    plugin.state = { ...DEFAULT_SYNC_STATE }
    plugin.diagnostics = { ...DEFAULT_DIAGNOSTICS }

    const { OtterSyncSettingTab } = await import('../src/settings-tab')
    const tab = new OtterSyncSettingTab(plugin.app as never, plugin)

    tab.display()

    await getRecordedSetting(tab, 'First-run backfill').dropdownChangeHandlers[0]?.('absoluteDate')
    await getRecordedSetting(tab, 'First-run backfill').textChangeHandlers[0]?.('2026-03-01')
    await getRecordedSetting(tab, 'Forced sync backfill').dropdownChangeHandlers[0]?.('relativeDays')
    await getRecordedSetting(tab, 'Forced sync backfill').textChangeHandlers[0]?.('14')

    expect(plugin.settings.firstRunBackfillMode).toBe('absoluteDate')
    expect(plugin.settings.firstRunBackfillValue).toBe('2026-03-01')
    expect(plugin.settings.forcedBackfillMode).toBe('relativeDays')
    expect(plugin.settings.forcedBackfillValue).toBe(14)
  })

  it('restarts scheduling when sync cadence changes', async () => {
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest())
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      destinationFolder: 'Meetings',
      commandTemplate: 'python sync.py {since} {mode}',
      syncIntervalMinutes: 15,
    }
    plugin.state = { ...DEFAULT_SYNC_STATE }
    plugin.diagnostics = { ...DEFAULT_DIAGNOSTICS }

    const orchestrator = (plugin as unknown as {
      orchestrator: {
        startScheduling: () => void
        stopScheduling: () => void
      }
    }).orchestrator
    const stopSchedulingSpy = vi.spyOn(orchestrator, 'stopScheduling')
    const startSchedulingSpy = vi.spyOn(orchestrator, 'startScheduling')

    const { OtterSyncSettingTab } = await import('../src/settings-tab')
    const tab = new OtterSyncSettingTab(plugin.app as never, plugin)

    tab.display()

    await getRecordedSetting(tab, 'Sync cadence').dropdownChangeHandlers[0]?.('30')

    expect(plugin.settings.syncIntervalMinutes).toBe(30)
    expect(stopSchedulingSpy).toHaveBeenCalledTimes(1)
    expect(startSchedulingSpy).toHaveBeenCalledTimes(1)
  })

  it('switches absolute-date backfill modes to valid date defaults', async () => {
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest())
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      firstRunBackfillMode: 'relativeDays',
      firstRunBackfillValue: 7,
      forcedBackfillMode: 'relativeDays',
      forcedBackfillValue: 30,
    }
    plugin.state = { ...DEFAULT_SYNC_STATE }
    plugin.diagnostics = { ...DEFAULT_DIAGNOSTICS }

    const { OtterSyncSettingTab } = await import('../src/settings-tab')
    const tab = new OtterSyncSettingTab(plugin.app as never, plugin)

    tab.display()

    await getRecordedSetting(tab, 'First-run backfill').dropdownChangeHandlers[0]?.('absoluteDate')
    await getRecordedSetting(tab, 'Forced sync backfill').dropdownChangeHandlers[0]?.('absoluteDate')

    expect(plugin.settings.firstRunBackfillMode).toBe('absoluteDate')
    expect(plugin.settings.firstRunBackfillValue).toBe('1970-01-01')
    expect(plugin.settings.forcedBackfillMode).toBe('absoluteDate')
    expect(plugin.settings.forcedBackfillValue).toBe('1970-01-01')
    expect(getRecordedSetting(tab, 'First-run backfill').textValues[0]).toBe('1970-01-01')
    expect(getRecordedSetting(tab, 'Forced sync backfill').textValues[0]).toBe('1970-01-01')
  })

  it('ignores invalid relative-day backfill values', async () => {
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest())
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      firstRunBackfillMode: 'relativeDays',
      firstRunBackfillValue: 7,
    }
    plugin.state = { ...DEFAULT_SYNC_STATE }
    plugin.diagnostics = { ...DEFAULT_DIAGNOSTICS }

    const { OtterSyncSettingTab } = await import('../src/settings-tab')
    const tab = new OtterSyncSettingTab(plugin.app as never, plugin)

    tab.display()

    getRecordedSetting(tab, 'First-run backfill').textValues[0] = 'not-a-number'
    await getRecordedSetting(tab, 'First-run backfill').textChangeHandlers[0]?.('not-a-number')

    expect(plugin.settings.firstRunBackfillValue).toBe(7)
    expect(getRecordedSetting(tab, 'First-run backfill').textValues[0]).toBe('7')
  })

  it('ignores invalid absolute-date backfill values', async () => {
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest())
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      firstRunBackfillMode: 'absoluteDate',
      firstRunBackfillValue: '2026-03-01',
    }
    plugin.state = { ...DEFAULT_SYNC_STATE }
    plugin.diagnostics = { ...DEFAULT_DIAGNOSTICS }

    const { OtterSyncSettingTab } = await import('../src/settings-tab')
    const tab = new OtterSyncSettingTab(plugin.app as never, plugin)

    tab.display()

    getRecordedSetting(tab, 'First-run backfill').textValues[0] = 'March 1, 2026'
    await getRecordedSetting(tab, 'First-run backfill').textChangeHandlers[0]?.('March 1, 2026')

    expect(plugin.settings.firstRunBackfillValue).toBe('2026-03-01')
    expect(getRecordedSetting(tab, 'First-run backfill').textValues[0]).toBe('2026-03-01')
  })

  it('copies the last sync debug info summary', async () => {
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest())
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      destinationFolder: 'meetings',
      commandTemplate: 'python sync.py --token super-secret --vault main',
    }
    plugin.state = { ...DEFAULT_SYNC_STATE, lastFetchWatermark: 99 }
    plugin.diagnostics = { ...DEFAULT_DIAGNOSTICS, lastErrorSummary: 'sync failed' }

    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    const { OtterSyncSettingTab } = await import('../src/settings-tab')
    const tab = new OtterSyncSettingTab(plugin.app as never, plugin)

    tab.display()

    await getRecordedSetting(tab, 'Copy last sync debug info').buttonClickHandlers[0]?.()

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0]?.[0]).toContain('"destinationFolder": "meetings"')
    expect(writeText.mock.calls[0]?.[0]).toContain('"commandTemplateSummary": "Configured (redacted)"')
    expect(writeText.mock.calls[0]?.[0]).not.toContain('"commandTemplate":')
    expect(writeText.mock.calls[0]?.[0]).not.toContain('super-secret')
    expect(writeText.mock.calls[0]?.[0]).toContain('"lastFetchWatermark": 99')
    expect(writeText.mock.calls[0]?.[0]).toContain('"lastErrorSummary": "sync failed"')
  })

  it('shows a desktop-only process-unavailable message when local execution is unavailable', async () => {
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(
      createFakeApp({ isDesktopOnly: false, processExecutionAvailable: false }),
      createFakeManifest(),
    )
    plugin.settings = { ...DEFAULT_SETTINGS }
    plugin.state = { ...DEFAULT_SYNC_STATE }
    plugin.diagnostics = { ...DEFAULT_DIAGNOSTICS }

    const { OtterSyncSettingTab } = await import('../src/settings-tab')
    const tab = new OtterSyncSettingTab(plugin.app as never, plugin)

    tab.display()

    expect(getRecordedSettings(tab)[0]?.desc).toContain('Desktop only')
    expect(getRecordedSettings(tab)[0]?.desc).toContain('local process execution is unavailable')
  })
})
