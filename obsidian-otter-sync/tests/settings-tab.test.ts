import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginSettingTab, RecordedSetting } from './helpers/obsidian'

import { DEFAULT_DIAGNOSTICS } from '../src/diagnostics'
import { DEFAULT_SETTINGS } from '../src/settings'
import { DEFAULT_SYNC_STATE } from '../src/state'
import { createFakeApp, createFakeManifest } from './helpers/fake-app'
import { ensureTestObsidianModule } from './helpers/register-obsidian'

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
  beforeEach(() => {
  })

  it('renders all Task 2 settings and diagnostics fields', async () => {
    await ensureTestObsidianModule()
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

  it('renders diagnostics as read-only state and diagnostics fields', async () => {
    await ensureTestObsidianModule()
    const { default: OtterSyncPlugin } = await import('../src/main')
    const plugin = new OtterSyncPlugin(createFakeApp(), createFakeManifest())
    plugin.settings = { ...DEFAULT_SETTINGS, destinationFolder: 'notes' }
    plugin.state = {
      ...DEFAULT_SYNC_STATE,
      lastCleanSyncTime: 42,
      lastFetchWatermark: 84,
    }
    plugin.diagnostics = {
      ...DEFAULT_DIAGNOSTICS,
      lastErrorSummary: 'Only from diagnostics',
      recentRuns: [{ attempt: 1 }],
    }

    const { OtterSyncSettingTab } = await import('../src/settings-tab')
    const tab = new OtterSyncSettingTab(plugin.app as never, plugin)

    tab.display()

    expect(plugin.settings).toEqual({
      ...DEFAULT_SETTINGS,
      destinationFolder: 'notes',
    })
    const recordedSettings = getRecordedSettings(tab)
    expect(recordedSettings.find((setting) => setting.name === 'Last clean sync time')?.textInputs).toBe(1)
    expect(recordedSettings.find((setting) => setting.name === 'Last fetch watermark')?.textInputs).toBe(1)
    expect(recordedSettings.find((setting) => setting.name === 'Last sync error summary')?.textAreas).toBe(1)
    expect(recordedSettings.find((setting) => setting.name === 'Recent sync diagnostics')?.textAreas).toBe(1)
    expect(recordedSettings.find((setting) => setting.name === 'Copy last sync debug info')?.buttons).toContain(
      'Copy debug info',
    )
  })

  it('persists editable first-run and forced-sync backfill controls', async () => {
    await ensureTestObsidianModule()
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

  it('copies the last sync debug info summary', async () => {
    await ensureTestObsidianModule()
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
    vi.unstubAllGlobals()
  })

  it('shows a desktop-only process-unavailable message when local execution is unavailable', async () => {
    await ensureTestObsidianModule()
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
