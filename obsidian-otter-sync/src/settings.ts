export type BackfillMode = 'relativeDays' | 'absoluteDate'

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
