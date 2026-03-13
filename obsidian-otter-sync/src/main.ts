import { Plugin } from 'obsidian'

import type { DiagnosticsState } from './diagnostics'
import { DEFAULT_DIAGNOSTICS } from './diagnostics'
import {
  buildPersistedPluginData,
  DEFAULT_SETTINGS,
  hasRequiredSyncSettings,
  mergeDiagnostics,
  mergeSettings,
  mergeState,
  type OtterSyncSettings,
  type PersistedPluginData,
} from './settings'
import { OtterSyncSettingTab } from './settings-tab'
import type { SyncState } from './state'
import { DEFAULT_SYNC_STATE } from './state'
import { createSyncOrchestrator } from './sync/orchestrator'

export default class OtterSyncPlugin extends Plugin {
  settings: OtterSyncSettings = { ...DEFAULT_SETTINGS }
  state: SyncState = { ...DEFAULT_SYNC_STATE }
  diagnostics: DiagnosticsState = { ...DEFAULT_DIAGNOSTICS }
  private orchestrator = createSyncOrchestrator(this)
  private persistRequested = false
  private persistInFlight: Promise<void> | null = null

  async onload(): Promise<void> {
    await this.loadSettings()
    await this.loadState()
    await this.loadDiagnostics()
    this.addSettingTab(new OtterSyncSettingTab(this.app, this))
    this.orchestrator.registerCommands()

    if (hasRequiredSyncSettings(this.settings)) {
      this.orchestrator.startScheduling()
      void this.orchestrator.runSync('scheduled').catch(() => undefined)
    }
  }

  async onunload(): Promise<void> {
    this.orchestrator.stopScheduling()
  }

  async loadSettings(): Promise<OtterSyncSettings> {
    this.settings = mergeSettings(await this.loadPluginData())
    return this.settings
  }

  async loadState(): Promise<SyncState> {
    this.state = mergeState(await this.loadPluginData())
    return this.state
  }

  async loadDiagnostics(): Promise<DiagnosticsState> {
    this.diagnostics = mergeDiagnostics(await this.loadPluginData())
    return this.diagnostics
  }

  async saveSettings(settings: OtterSyncSettings): Promise<void> {
    this.settings = settings
    await this.savePluginData()
  }

  async saveState(state: SyncState): Promise<void> {
    this.state = state
    await this.savePluginData()
  }

  async saveDiagnostics(diagnostics: DiagnosticsState): Promise<void> {
    this.diagnostics = diagnostics
    await this.savePluginData()
  }

  async updateSettings(update: Partial<OtterSyncSettings>): Promise<void> {
    const nextSettings = {
      ...this.settings,
      ...update,
    }
    const wasSchedulable = hasRequiredSyncSettings(this.settings)
    const isSchedulable = hasRequiredSyncSettings(nextSettings)
    const syncIntervalChanged = this.settings.syncIntervalMinutes !== nextSettings.syncIntervalMinutes

    await this.saveSettings(nextSettings)

    if (wasSchedulable && (!isSchedulable || syncIntervalChanged)) {
      this.orchestrator.stopScheduling()
    }

    if (isSchedulable && (!wasSchedulable || syncIntervalChanged)) {
      this.orchestrator.startScheduling()
    }
  }

  async updateState(update: Partial<SyncState>): Promise<void> {
    await this.saveState({
      ...this.state,
      ...update,
    })
  }

  async updateDiagnostics(update: Partial<DiagnosticsState>): Promise<void> {
    await this.saveDiagnostics({
      ...this.diagnostics,
      ...update,
    })
  }

  isLocalProcessExecutionAvailable(): boolean {
    const app = this.app as {
      isDesktopOnly?: boolean
      processExecutionAvailable?: boolean
    }

    return app.isDesktopOnly !== false && app.processExecutionAvailable !== false
  }

  private async loadPluginData(): Promise<PersistedPluginData> {
    const data = await this.loadData()
    return (data ?? {}) as PersistedPluginData
  }

  private async savePluginData(): Promise<void> {
    this.persistRequested = true

    if (this.persistInFlight) {
      await this.persistInFlight
      return
    }

    this.persistInFlight = this.flushPluginData()

    try {
      await this.persistInFlight
    } finally {
      this.persistInFlight = null
    }
  }

  private async flushPluginData(): Promise<void> {
    do {
      this.persistRequested = false
      await this.saveData(buildPersistedPluginData(this.settings, this.state, this.diagnostics))
    } while (this.persistRequested)
  }
}
