export interface SyncState {
  lastFetchWatermark: number | null
  lastCleanSyncTime: number | null
  pendingRetries: unknown[]
}

export const DEFAULT_SYNC_STATE: SyncState = {
  lastFetchWatermark: null,
  lastCleanSyncTime: null,
  pendingRetries: [],
}
