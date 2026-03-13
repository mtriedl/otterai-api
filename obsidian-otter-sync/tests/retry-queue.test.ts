import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DIAGNOSTICS,
  appendRunHistory,
  recordRunResult,
} from '../src/diagnostics'
import type { BridgeSpeech } from '../src/sync/schema'
import {
  markRetrySuccess,
  mergeRetryQueueWithFetches,
  replaceRetryEntry,
} from '../src/sync/retry-queue'
import type { RetryEntry } from '../src/state'
import { summarizeCommandForDiagnostics } from '../src/sync/python-bridge'

function buildSpeech(overrides: Partial<BridgeSpeech> = {}): BridgeSpeech {
  return {
    otid: 'speech-1',
    source_url: 'https://otter.ai/u/speech-1',
    title: 'Daily Standup',
    created_at: 1_710_000_000,
    modified_time: 1_710_000_100,
    attendees: ['Alice', 'Bob'],
    summary_markdown: 'Summary',
    transcript_segments: [
      {
        speaker_name: 'Alice',
        timestamp: '0:00',
        text: 'Hello',
      },
    ],
    ...overrides,
  }
}

function buildRetryEntry(overrides: Partial<RetryEntry> = {}): RetryEntry {
  return {
    ...buildSpeech(),
    failure_reason: 'note write failed',
    last_attempted_at: '2026-03-12T10:00:00.000Z',
    ...overrides,
  }
}

describe('retry queue helpers', () => {
  it('merges retry entries with fresh fetches by otid and prefers the freshest modified_time', () => {
    const staleRetry = buildRetryEntry({ modified_time: 100, title: 'Stale retry' })
    const freshRetry = buildRetryEntry({ otid: 'speech-2', modified_time: 250, title: 'Fresh retry' })
    const fetchedReplacement = buildSpeech({ modified_time: 200, title: 'Fetched latest' })
    const fetchedOlder = buildSpeech({ otid: 'speech-2', modified_time: 200, title: 'Older fetched' })

    expect(
      mergeRetryQueueWithFetches({
        pendingRetries: [staleRetry, freshRetry],
        fetchedSpeeches: [fetchedReplacement, fetchedOlder],
      }),
    ).toEqual([
      buildSpeech({ modified_time: 200, title: 'Fetched latest' }),
      buildSpeech({ otid: 'speech-2', modified_time: 250, title: 'Fresh retry' }),
    ])
  })

  it('returns canonical speech payloads without retry-only metadata', () => {
    const merged = mergeRetryQueueWithFetches({
      pendingRetries: [buildRetryEntry()],
      fetchedSpeeches: [],
    })

    expect(merged).toEqual([buildSpeech()])
    expect(merged[0]).not.toHaveProperty('failure_reason')
    expect(merged[0]).not.toHaveProperty('last_attempted_at')
  })

  it('prefers the freshest modified_time when pending retries already contain duplicate otids', () => {
    expect(
      mergeRetryQueueWithFetches({
        pendingRetries: [
          buildRetryEntry({ otid: 'speech-3', modified_time: 400, title: 'Fresh duplicate retry' }),
          buildRetryEntry({ otid: 'speech-3', modified_time: 100, title: 'Stale duplicate retry' }),
        ],
        fetchedSpeeches: [buildSpeech({ otid: 'speech-3', modified_time: 250, title: 'Fetched middle version' })],
      }),
    ).toEqual([buildSpeech({ otid: 'speech-3', modified_time: 400, title: 'Fresh duplicate retry' })])
  })

  it('removes a retry entry immediately after success', () => {
    expect(
      markRetrySuccess(
        [buildRetryEntry(), buildRetryEntry({ otid: 'speech-2' })],
        'speech-1',
      ),
    ).toEqual([buildRetryEntry({ otid: 'speech-2' })])
  })

  it('replaces an existing retry entry after repeated failure for the same otid', () => {
    expect(
      replaceRetryEntry(
        [buildRetryEntry({ modified_time: 100, failure_reason: 'old reason' })],
        buildRetryEntry({ modified_time: 300, failure_reason: 'new reason' }),
      ),
    ).toEqual([buildRetryEntry({ modified_time: 300, failure_reason: 'new reason' })])
  })

  it('keeps the newest normalized payload when a stale retry failure arrives for the same otid', () => {
    expect(
      replaceRetryEntry(
        [buildRetryEntry({ otid: 'speech-4', modified_time: 500, title: 'Newest payload', failure_reason: 'old failure' })],
        buildRetryEntry({ otid: 'speech-4', modified_time: 200, title: 'Stale payload', failure_reason: 'latest failure' }),
      ),
    ).toEqual([
      buildRetryEntry({ otid: 'speech-4', modified_time: 500, title: 'Newest payload', failure_reason: 'latest failure' }),
    ])
  })

  it('collapses duplicate queued retry entries to a single freshest entry for the otid', () => {
    expect(
      replaceRetryEntry(
        [
          buildRetryEntry({ otid: 'speech-5', modified_time: 100, title: 'Stale duplicate' }),
          buildRetryEntry({ otid: 'speech-5', modified_time: 600, title: 'Freshest duplicate', failure_reason: 'previous failure' }),
          buildRetryEntry({ otid: 'speech-6', modified_time: 300, title: 'Other otid' }),
        ],
        buildRetryEntry({ otid: 'speech-5', modified_time: 400, title: 'Incoming failure', failure_reason: 'latest failure' }),
      ),
    ).toEqual([
      buildRetryEntry({ otid: 'speech-5', modified_time: 600, title: 'Freshest duplicate', failure_reason: 'latest failure' }),
      buildRetryEntry({ otid: 'speech-6', modified_time: 300, title: 'Other otid' }),
    ])
  })
})

describe('diagnostics helpers', () => {
  it('caps run history to the most recent 20 runs', () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      runMode: 'scheduled' as const,
      startedAt: `2026-03-12T10:${String(index).padStart(2, '0')}:00.000Z`,
      endedAt: `2026-03-12T10:${String(index).padStart(2, '0')}:30.000Z`,
      fetchWatermarkUsed: index,
      fetchedUntil: index,
      retryReplay: false,
      counts: { created: index, updated: 0, skipped: 0, failed: 0 },
      commandSummary: summarizeCommandForDiagnostics('python sync.py {since} {mode}', 'darwin'),
      exitCode: 0,
      stderrSnippet: null,
      speechCount: index,
      errorSummary: null,
      noteFailures: [],
    }))

    const nextRun = {
      runMode: 'manual' as const,
      startedAt: '2026-03-12T11:00:00.000Z',
      endedAt: '2026-03-12T11:00:30.000Z',
      fetchWatermarkUsed: 999,
      fetchedUntil: 1_000,
      retryReplay: true,
      counts: { created: 1, updated: 2, skipped: 3, failed: 4 },
      commandSummary: summarizeCommandForDiagnostics('python sync.py {since} {mode}', 'darwin'),
      exitCode: 1,
      stderrSnippet: 'traceback snippet',
      speechCount: 7,
      errorSummary: 'sync failed',
      noteFailures: [],
    }

    const appended = appendRunHistory(history, nextRun)

    expect(appended).toHaveLength(20)
    expect(appended[0]?.fetchWatermarkUsed).toBe(1)
    expect(appended[19]).toEqual(nextRun)
  })

  it('persists a run record with required fields and safe command summary data', () => {
    const commandSummary = summarizeCommandForDiagnostics(
      'python sync.py --token super-secret {since} {mode}',
      'darwin',
    )

    const diagnostics = recordRunResult(DEFAULT_DIAGNOSTICS, {
      runMode: 'forced',
      startedAt: '2026-03-12T11:00:00.000Z',
      endedAt: '2026-03-12T11:00:30.000Z',
      fetchWatermarkUsed: 123,
      fetchedUntil: 456,
      retryReplay: true,
      counts: { created: 1, updated: 2, skipped: 3, failed: 1 },
      commandSummary,
      exitCode: 17,
      stderrSnippet: 'ValueError: boom',
      speechCount: 4,
      errorSummary: 'sync run failed',
      noteFailures: [
        {
          otid: 'speech-9',
          source_url: 'https://otter.ai/u/speech-9',
          notePath: 'Meetings/Daily Standup.md',
          reason: 'Vault modify failed',
        },
      ],
    })

    expect(diagnostics.lastErrorSummary).toBe('sync run failed')
    expect(diagnostics.recentRuns).toEqual([
      {
        runMode: 'forced',
        startedAt: '2026-03-12T11:00:00.000Z',
        endedAt: '2026-03-12T11:00:30.000Z',
        fetchWatermarkUsed: 123,
        fetchedUntil: 456,
        retryReplay: true,
        counts: { created: 1, updated: 2, skipped: 3, failed: 1 },
        commandSummary,
        exitCode: 17,
        stderrSnippet: 'ValueError: boom',
        speechCount: 4,
        errorSummary: 'sync run failed',
        noteFailures: [
          {
            otid: 'speech-9',
            source_url: 'https://otter.ai/u/speech-9',
            notePath: 'Meetings/Daily Standup.md',
            reason: 'Vault modify failed',
          },
        ],
      },
    ])
    expect(JSON.stringify(diagnostics.recentRuns[0])).not.toContain('super-secret')
    expect(JSON.stringify(diagnostics.recentRuns[0])).not.toContain('python sync.py --token')
  })

  it('keeps the most recent failure summary when a later run succeeds', () => {
    const failedDiagnostics = recordRunResult(DEFAULT_DIAGNOSTICS, {
      runMode: 'scheduled',
      startedAt: '2026-03-12T10:00:00.000Z',
      endedAt: '2026-03-12T10:00:30.000Z',
      fetchWatermarkUsed: 100,
      fetchedUntil: 200,
      retryReplay: false,
      counts: { created: 0, updated: 0, skipped: 0, failed: 1 },
      commandSummary: summarizeCommandForDiagnostics('python sync.py {since} {mode}', 'darwin'),
      exitCode: 1,
      stderrSnippet: 'boom',
      speechCount: 1,
      errorSummary: 'latest failure summary',
      noteFailures: [],
    })

    const succeededDiagnostics = recordRunResult(failedDiagnostics, {
      runMode: 'scheduled',
      startedAt: '2026-03-12T11:00:00.000Z',
      endedAt: '2026-03-12T11:00:30.000Z',
      fetchWatermarkUsed: 200,
      fetchedUntil: 300,
      retryReplay: false,
      counts: { created: 1, updated: 0, skipped: 0, failed: 0 },
      commandSummary: summarizeCommandForDiagnostics('python sync.py {since} {mode}', 'darwin'),
      exitCode: 0,
      stderrSnippet: null,
      speechCount: 1,
      errorSummary: null,
      noteFailures: [],
    })

    expect(succeededDiagnostics.lastErrorSummary).toBe('latest failure summary')
    expect(succeededDiagnostics.recentRuns).toHaveLength(2)
    expect(succeededDiagnostics.recentRuns[1]?.errorSummary).toBeNull()
  })
})
