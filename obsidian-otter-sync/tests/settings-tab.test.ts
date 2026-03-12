import { beforeEach, describe, expect, it } from 'vitest'
import type { PluginSettingTab, RecordedSetting } from './helpers/obsidian'

import { DEFAULT_DIAGNOSTICS } from '../src/diagnostics'
import { DEFAULT_SETTINGS } from '../src/settings'
import { DEFAULT_SYNC_STATE } from '../src/state'
import { createFakeApp, createFakeManifest } from './helpers/fake-app'
import { ensureTestObsidianModule } from './helpers/register-obsidian'

function getRecordedSettings(tab: PluginSettingTab): RecordedSetting[] {
  return tab.containerEl.children as RecordedSetting[]
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
