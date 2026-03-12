import { PluginSettingTab, Setting } from 'obsidian'

import type OtterSyncPlugin from './main'
import type { BackfillMode } from './settings'

function formatValue(value: number | string | null): string {
  if (value === null || value === '') {
    return 'Not available yet'
  }

  return String(value)
}

function formatRecentDiagnostics(recentRuns: unknown[]): string {
  if (recentRuns.length === 0) {
    return 'No sync diagnostics recorded yet.'
  }

  return JSON.stringify(recentRuns, null, 2)
}

function buildDebugInfo(plugin: OtterSyncPlugin): string {
  return JSON.stringify(
    {
      settings: plugin.settings,
      state: plugin.state,
      diagnostics: plugin.diagnostics,
    },
    null,
    2,
  )
}

function parseBackfillValue(mode: BackfillMode, value: string): number | string {
  return mode === 'relativeDays' ? Number(value) : value
}

async function copyDebugInfo(text: string): Promise<void> {
  const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } })
    .navigator?.clipboard

  if (clipboard?.writeText) {
    await clipboard.writeText(text)
  }
}

export class OtterSyncSettingTab extends PluginSettingTab {
  plugin: OtterSyncPlugin

  constructor(app: OtterSyncPlugin['app'], plugin: OtterSyncPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    this.containerEl.empty()

    if (!this.plugin.isLocalProcessExecutionAvailable()) {
      new Setting(this.containerEl)
        .setName('Desktop only')
        .setDesc('Desktop only: local process execution is unavailable in this Obsidian environment.')
    }

    new Setting(this.containerEl)
      .setName('Destination folder')
      .addText((component) => {
        component.setValue(this.plugin.settings.destinationFolder).onChange(async (value) => {
          await this.plugin.updateSettings({ destinationFolder: value })
        })
      })

    new Setting(this.containerEl)
      .setName('Sync cadence')
      .addDropdown((component) => {
        component
          .addOption('15', 'Every 15 minutes')
          .addOption('30', 'Every 30 minutes')
          .addOption('60', 'Every hour')
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            await this.plugin.updateSettings({ syncIntervalMinutes: Number(value) })
          })
      })

    new Setting(this.containerEl)
      .setName('Python sync command template')
      .addTextArea((component) => {
        component.setValue(this.plugin.settings.commandTemplate).onChange(async (value) => {
          await this.plugin.updateSettings({ commandTemplate: value })
        })
      })

    new Setting(this.containerEl)
      .setName('First-run backfill')
      .addDropdown((component) => {
        component
          .addOption('relativeDays', 'Relative days')
          .addOption('absoluteDate', 'Absolute date')
          .setValue(this.plugin.settings.firstRunBackfillMode)
          .onChange(async (value) => {
            const mode = value as BackfillMode
            await this.plugin.updateSettings({
              firstRunBackfillMode: mode,
              firstRunBackfillValue: parseBackfillValue(mode, String(this.plugin.settings.firstRunBackfillValue)),
            })
          })
      })
      .addText((component) => {
        component
          .setValue(String(this.plugin.settings.firstRunBackfillValue))
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              firstRunBackfillValue: parseBackfillValue(this.plugin.settings.firstRunBackfillMode, value),
            })
          })
      })

    new Setting(this.containerEl)
      .setName('Forced sync backfill')
      .addDropdown((component) => {
        component
          .addOption('relativeDays', 'Relative days')
          .addOption('absoluteDate', 'Absolute date')
          .setValue(this.plugin.settings.forcedBackfillMode)
          .onChange(async (value) => {
            const mode = value as BackfillMode
            await this.plugin.updateSettings({
              forcedBackfillMode: mode,
              forcedBackfillValue: parseBackfillValue(mode, String(this.plugin.settings.forcedBackfillValue)),
            })
          })
      })
      .addText((component) => {
        component
          .setValue(String(this.plugin.settings.forcedBackfillValue))
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              forcedBackfillValue: parseBackfillValue(this.plugin.settings.forcedBackfillMode, value),
            })
          })
      })

    new Setting(this.containerEl)
      .setName('Show scheduled success notices')
      .addToggle((component) => {
        component.setValue(this.plugin.settings.showScheduledSuccessNotice).onChange(async (value) => {
          await this.plugin.updateSettings({ showScheduledSuccessNotice: value })
        })
      })

    new Setting(this.containerEl)
      .setName('Last clean sync time')
      .addText((component) => {
        component.setValue(formatValue(this.plugin.state.lastCleanSyncTime)).onChange(() => undefined)
      })
      .setDisabled(true)

    new Setting(this.containerEl)
      .setName('Last fetch watermark')
      .addText((component) => {
        component.setValue(formatValue(this.plugin.state.lastFetchWatermark)).onChange(() => undefined)
      })
      .setDisabled(true)

    new Setting(this.containerEl)
      .setName('Last sync error summary')
      .addTextArea((component) => {
        component.setValue(formatValue(this.plugin.diagnostics.lastErrorSummary)).onChange(() => undefined)
      })
      .setDisabled(true)

    new Setting(this.containerEl)
      .setName('Recent sync diagnostics')
      .addTextArea((component) => {
        component.setValue(formatRecentDiagnostics(this.plugin.diagnostics.recentRuns)).onChange(() => undefined)
      })
      .setDisabled(true)

    new Setting(this.containerEl)
      .setName('Copy last sync debug info')
      .addButton((component) => {
        component.setButtonText('Copy debug info').onClick(async () => {
          await copyDebugInfo(buildDebugInfo(this.plugin))
        })
      })
  }
}
