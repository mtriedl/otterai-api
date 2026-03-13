export type BackfillMode = 'relativeDays' | 'absoluteDate'

import type { DiagnosticsState } from './diagnostics'
import { DEFAULT_DIAGNOSTICS } from './diagnostics'
import type { SyncState } from './state'
import { DEFAULT_SYNC_STATE } from './state'

export interface OtterSyncSettings {
  destinationFolder: string
  commandTemplate: string
  syncIntervalMinutes: number
  firstRunBackfillMode: BackfillMode
  firstRunBackfillValue: number | string
  forcedBackfillMode: BackfillMode
  forcedBackfillValue: number | string
  showScheduledSuccessNotice: boolean
}

export const DEFAULT_SETTINGS: OtterSyncSettings = {
  destinationFolder: '',
  commandTemplate: '',
  syncIntervalMinutes: 60,
  firstRunBackfillMode: 'relativeDays',
  firstRunBackfillValue: 7,
  forcedBackfillMode: 'relativeDays',
  forcedBackfillValue: 30,
  showScheduledSuccessNotice: false,
}

export interface PersistedPluginData {
  settings?: Partial<OtterSyncSettings>
  state?: Partial<SyncState>
  diagnostics?: Partial<DiagnosticsState>
}

export function mergeSettings(data?: PersistedPluginData): OtterSyncSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...data?.settings,
  }
}

export function hasRequiredSyncSettings(settings: OtterSyncSettings): boolean {
  return getRequiredSyncSettingsError(settings) === null
}

export function getRequiredSyncSettingsError(settings: OtterSyncSettings): string | null {
  const missingSettings: string[] = []

  if (settings.destinationFolder.trim() === '') {
    missingSettings.push('destination folder')
  }

  if (settings.commandTemplate.trim() === '') {
    missingSettings.push('Python command template')
  }

  if (missingSettings.length === 0) {
    return null
  }

  if (missingSettings.length === 1) {
    return `Sync requires ${missingSettings[0]} to be configured before syncing`
  }

  return `Sync requires ${missingSettings[0]} and ${missingSettings[1]} settings to be configured before syncing`
}

export function mergeState(data?: PersistedPluginData): SyncState {
  return {
    ...DEFAULT_SYNC_STATE,
    ...data?.state,
    pendingRetries: [...(data?.state?.pendingRetries ?? DEFAULT_SYNC_STATE.pendingRetries)],
  }
}

export function mergeDiagnostics(data?: PersistedPluginData): DiagnosticsState {
  return {
    ...DEFAULT_DIAGNOSTICS,
    ...data?.diagnostics,
    recentRuns: [...(data?.diagnostics?.recentRuns ?? DEFAULT_DIAGNOSTICS.recentRuns)],
  }
}

export function buildPersistedPluginData(
  settings: OtterSyncSettings,
  state: SyncState,
  diagnostics: DiagnosticsState,
): PersistedPluginData {
  return {
    settings,
    state,
    diagnostics,
  }
}
