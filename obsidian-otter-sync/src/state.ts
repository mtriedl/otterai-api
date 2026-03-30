import type { BridgeSpeech } from './sync/schema'

export interface RetryEntry extends BridgeSpeech {
  failure_reason: string
  last_attempted_at: string
}

export interface SyncState {
  lastFetchWatermark: number | null
  lastCleanSyncTime: number | null
  pendingRetries: RetryEntry[]
}

export const DEFAULT_SYNC_STATE: SyncState = {
  lastFetchWatermark: null,
  lastCleanSyncTime: null,
  pendingRetries: [],
}
