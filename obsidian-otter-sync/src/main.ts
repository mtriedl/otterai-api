import { Plugin } from 'obsidian'

import type { DiagnosticsState } from './diagnostics'
import { DEFAULT_DIAGNOSTICS } from './diagnostics'
import {
  buildPersistedPluginData,
  DEFAULT_SETTINGS,
  mergeDiagnostics,
  mergeSettings,
  mergeState,
  type OtterSyncSettings,
  type PersistedPluginData,
} from './settings'
import { OtterSyncSettingTab } from './settings-tab'
import type { SyncState } from './state'
import { DEFAULT_SYNC_STATE } from './state'

export default class OtterSyncPlugin extends Plugin {
  settings: OtterSyncSettings = { ...DEFAULT_SETTINGS }
  state: SyncState = { ...DEFAULT_SYNC_STATE }
  diagnostics: DiagnosticsState = { ...DEFAULT_DIAGNOSTICS }

  async onload(): Promise<void> {
    await this.loadSettings()
    await this.loadState()
    await this.loadDiagnostics()
    this.addSettingTab(new OtterSyncSettingTab(this.app, this))
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
    await this.saveSettings({
      ...this.settings,
      ...update,
    })
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
    await this.saveData(buildPersistedPluginData(this.settings, this.state, this.diagnostics))
  }
}
