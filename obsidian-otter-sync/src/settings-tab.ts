import { PluginSettingTab, Setting } from 'obsidian'

import type { RunRecord } from './diagnostics'
import type OtterSyncPlugin from './main'
import { DEFAULT_SETTINGS, type BackfillMode } from './settings'

function formatValue(value: string | null): string {
  if (value === null || value === '') {
    return 'Not available yet'
  }

  return String(value)
}

function formatIsoTimestamp(value: number | null, multiplier = 1): string {
  if (value === null) {
    return 'Not available yet'
  }

  const date = new Date(value * multiplier)

  if (Number.isNaN(date.valueOf())) {
    return String(value)
  }

  return date.toISOString()
}

function formatFetchWatermark(value: number | null): string {
  if (value === null) {
    return 'Not available yet'
  }

  const isoTimestamp = formatIsoTimestamp(value, 1000)
  return isoTimestamp === String(value) ? String(value) : `${value} (${isoTimestamp} UTC)`
}

function formatRecentDiagnostics(recentRuns: RunRecord[]): string {
  if (recentRuns.length === 0) {
    return 'No sync diagnostics recorded yet.'
  }

  return recentRuns
    .map((run) => {
      if (!('runMode' in run) || !('startedAt' in run) || !('counts' in run)) {
        return JSON.stringify(run, null, 2)
      }

      const lines = [
        `${run.runMode[0].toUpperCase()}${run.runMode.slice(1)} run at ${run.startedAt}`,
        `Completed: ${run.endedAt}`,
        `Counts: ${run.counts.created} created, ${run.counts.updated} updated, ${run.counts.skipped} skipped, ${run.counts.failed} failed`,
        `Speech count: ${run.speechCount}`,
        `Fetch watermark used: ${run.fetchWatermarkUsed ?? 'Not available yet'}`,
        `Fetched until: ${run.fetchedUntil ?? 'Not available yet'}`,
      ]

      if (run.errorSummary) {
        lines.push(`Error summary: ${run.errorSummary}`)
      }

      if (run.stderrSnippet) {
        lines.push(`stderr: ${run.stderrSnippet}`)
      }

      for (const failure of run.noteFailures) {
        lines.push(`Note failure: ${failure.otid} -> ${failure.reason}`)
      }

      for (const diagnostic of run.synchronizerDiagnostics ?? []) {
        lines.push(`Synchronizer diagnostic: ${diagnostic.code} -> ${diagnostic.message}`)
      }

      return lines.join('\n')
    })
    .join('\n\n')
}

function buildDebugInfo(plugin: OtterSyncPlugin): string {
  const { commandTemplate: _commandTemplate, ...safeSettings } = plugin.settings

  return JSON.stringify(
    {
      settings: {
        ...safeSettings,
        commandTemplateSummary: plugin.settings.commandTemplate.trim() === '' ? 'Not configured' : 'Configured (redacted)',
      },
      state: plugin.state,
      diagnostics: plugin.diagnostics,
    },
    null,
    2,
  )
}

function parseRelativeDays(value: string): number | null {
  const trimmedValue = value.trim()

  if (!/^\d+$/.test(trimmedValue)) {
    return null
  }

  return Number(trimmedValue)
}

function isValidAbsoluteDate(value: string): boolean {
  const trimmedValue = value.trim()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmedValue)) {
    return false
  }

  const [year, month, day] = trimmedValue.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function parseAbsoluteDate(value: string): string | null {
  const trimmedValue = value.trim()
  return isValidAbsoluteDate(trimmedValue) ? trimmedValue : null
}

function parseBackfillValue(mode: BackfillMode, value: string): number | string | null {
  return mode === 'relativeDays' ? parseRelativeDays(value) : parseAbsoluteDate(value)
}

function resolveBackfillValue(mode: BackfillMode, value: string, fallback: number | string): number | string {
  const parsedValue = parseBackfillValue(mode, value)
  return parsedValue === null ? fallback : parsedValue
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

  private async updateBackfillSettings(update: Partial<OtterSyncPlugin['settings']>): Promise<void> {
    await this.plugin.updateSettings(update)
    this.display()
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
            await this.updateBackfillSettings({
              firstRunBackfillMode: mode,
              firstRunBackfillValue: resolveBackfillValue(
                mode,
                String(this.plugin.settings.firstRunBackfillValue),
                mode === 'relativeDays' ? DEFAULT_SETTINGS.firstRunBackfillValue : '1970-01-01',
              ),
            })
          })
      })
      .addText((component) => {
        component
          .setValue(String(this.plugin.settings.firstRunBackfillValue))
          .onChange(async (value) => {
            const parsedValue = parseBackfillValue(this.plugin.settings.firstRunBackfillMode, value)

            if (parsedValue === null) {
              this.display()
              return
            }

            await this.updateBackfillSettings({
              firstRunBackfillValue: parsedValue,
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
            await this.updateBackfillSettings({
              forcedBackfillMode: mode,
              forcedBackfillValue: resolveBackfillValue(
                mode,
                String(this.plugin.settings.forcedBackfillValue),
                mode === 'relativeDays' ? DEFAULT_SETTINGS.forcedBackfillValue : '1970-01-01',
              ),
            })
          })
      })
      .addText((component) => {
        component
          .setValue(String(this.plugin.settings.forcedBackfillValue))
          .onChange(async (value) => {
            const parsedValue = parseBackfillValue(this.plugin.settings.forcedBackfillMode, value)

            if (parsedValue === null) {
              this.display()
              return
            }

            await this.updateBackfillSettings({
              forcedBackfillValue: parsedValue,
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
        component.setValue(formatIsoTimestamp(this.plugin.state.lastCleanSyncTime)).onChange(() => undefined)
      })
      .setDisabled(true)

    new Setting(this.containerEl)
      .setName('Last fetch watermark')
      .addText((component) => {
        component.setValue(formatFetchWatermark(this.plugin.state.lastFetchWatermark)).onChange(() => undefined)
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
      .setDesc('Copies settings, state, and diagnostics with the command template redacted.')
      .addButton((component) => {
        component.setButtonText('Copy debug info').onClick(async () => {
          await copyDebugInfo(buildDebugInfo(this.plugin))
        })
      })
  }
}
