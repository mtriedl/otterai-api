import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/settings'

describe('DEFAULT_SETTINGS', () => {
  it('defines the initial plugin settings', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      destinationFolder: '',
      commandTemplate: '',
      syncIntervalMinutes: 60,
      firstRunBackfillMode: 'relativeDays',
      firstRunBackfillValue: 7,
      forcedBackfillMode: 'relativeDays',
      forcedBackfillValue: 30,
      showScheduledSuccessNotice: false,
    })
  })
})
