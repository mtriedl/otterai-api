import { Notice } from 'obsidian'

import { recordRunResult, type NoteFailureRecord, type RunCounts, type RunRecord } from '../diagnostics'
import type { OtterSyncSettings } from '../settings'
import type { RetryEntry, SyncState } from '../state'
import { synchronizeNotes, type SynchronizeNoteResult, type SynchronizeNotesResult } from '../notes/synchronizer'
import {
  runBridgeCommand,
  summarizeCommandForDiagnostics,
  type BridgeMode,
  type CommandDiagnosticsSummary,
  type RunBridgeCommandResult,
} from './python-bridge'
import { mergeRetryQueueWithFetches, markRetrySuccess, replaceRetryEntry } from './retry-queue'
import type { BridgeSpeech } from './schema'

const ONE_DAY_SECONDS = 86_400
const STDERR_SNIPPET_LIMIT = 500

interface PluginLike {
  app: unknown
  settings: OtterSyncSettings
  state: SyncState
  diagnostics: {
    recentRuns: RunRecord[]
    lastErrorSummary: string | null
  }
  updateState(update: Partial<SyncState>): Promise<void>
  updateDiagnostics(update: Partial<PluginLike['diagnostics']>): Promise<void>
  isLocalProcessExecutionAvailable(): boolean
  addCommand?(command: { id: string; name: string; callback: () => Promise<unknown> | unknown }): void
}

interface OrchestratorDependencies {
  now: () => number
  notify: (message: string) => void
  runBridgeCommand: (options: {
    commandTemplate: string
    since: string
    mode: BridgeMode
  }) => Promise<RunBridgeCommandResult>
  synchronizeNotes: (options: {
    app: unknown
    destinationFolder: string
    speeches: BridgeSpeech[]
  }) => Promise<SynchronizeNotesResult>
}

interface ComputeSinceOptions {
  mode: BridgeMode
  nowSeconds: number
  settings: OtterSyncSettings
  state: SyncState
}

export interface SyncRunOutcome {
  status: 'success'
  counts: RunCounts
  fetchedUntil: number
}

function computeBackfillTimestamp(
  backfillMode: OtterSyncSettings['firstRunBackfillMode'],
  backfillValue: number | string,
  nowSeconds: number,
): number {
  if (backfillMode === 'absoluteDate') {
    return Math.floor(new Date(`${String(backfillValue)}T00:00:00.000Z`).getTime() / 1000)
  }

  return Math.max(0, nowSeconds - Number(backfillValue) * ONE_DAY_SECONDS)
}

export function computeSince(options: ComputeSinceOptions): number {
  if (options.mode === 'forced') {
    return computeBackfillTimestamp(
      options.settings.forcedBackfillMode,
      options.settings.forcedBackfillValue,
      options.nowSeconds,
    )
  }

  if (options.state.lastFetchWatermark !== null) {
    return Math.max(0, options.state.lastFetchWatermark - ONE_DAY_SECONDS)
  }

  return computeBackfillTimestamp(
    options.settings.firstRunBackfillMode,
    options.settings.firstRunBackfillValue,
    options.nowSeconds,
  )
}

function summarizeCounts(counts: RunCounts): string {
  return `${counts.created} created, ${counts.updated} updated, ${counts.skipped} skipped, ${counts.failed} failed.`
}

function summarizeFailure(counts: RunCounts, message: string): string {
  return `Sync failed: ${summarizeCounts(counts)} ${message}`
}

function buildCounts(notes: SynchronizeNoteResult[]): RunCounts {
  return notes.reduce<RunCounts>(
    (counts, note) => {
      counts[note.status] += 1
      return counts
    },
    { created: 0, updated: 0, skipped: 0, failed: 0 },
  )
}

function extractFailureReason(note: SynchronizeNoteResult): string {
  return note.diagnostics[0]?.message ?? 'Note synchronization failed'
}

function buildNoteFailures(notes: SynchronizeNoteResult[], speechesByOtid: Map<string, BridgeSpeech>): NoteFailureRecord[] {
  return notes
    .filter((note) => note.status === 'failed')
    .map((note) => {
      const speech = speechesByOtid.get(note.otid)

      return {
        otid: note.otid,
        source_url: speech?.source_url ?? '',
        notePath: note.path,
        reason: extractFailureReason(note),
      }
    })
}

function buildErrorWithMetadata(message: string, metadata: { stderr?: string; exitCode?: number | null } = {}): Error {
  const error = new Error(message) as Error & { stderr?: string; exitCode?: number | null }
  error.stderr = metadata.stderr
  error.exitCode = metadata.exitCode ?? null
  return error
}

function toRetryEntry(speech: BridgeSpeech, reason: string, attemptedAt: string): RetryEntry {
  return {
    ...speech,
    failure_reason: reason,
    last_attempted_at: attemptedAt,
  }
}

function clipStderr(stderr: string | undefined): string | null {
  if (!stderr) {
    return null
  }

  return stderr.slice(0, STDERR_SNIPPET_LIMIT)
}

export function createSyncOrchestrator(plugin: PluginLike, providedDependencies: Partial<OrchestratorDependencies> = {}) {
  const dependencies: OrchestratorDependencies = {
    now: () => Date.now(),
    notify: (message) => {
      if (typeof Notice === 'function') {
        new Notice(message)
      }
    },
    runBridgeCommand,
    synchronizeNotes,
    ...providedDependencies,
  }

  let intervalHandle: ReturnType<typeof setInterval> | null = null
  let activeRun: Promise<SyncRunOutcome> | null = null

  async function persistRun(runRecord: RunRecord): Promise<void> {
    await plugin.updateDiagnostics(recordRunResult(plugin.diagnostics, runRecord))
  }

  async function failRun(
    mode: BridgeMode,
    startedAtIso: string,
    fetchWatermarkUsed: number,
    commandSummary: CommandDiagnosticsSummary,
    error: Error & { stderr?: string; exitCode?: number | null },
    counts: RunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 },
    noteFailures: NoteFailureRecord[] = [],
    fetchedUntil: number | null = null,
    retryReplay = false,
    speechCount = 0,
  ): Promise<never> {
    const endedAtIso = new Date(dependencies.now()).toISOString()
    const isUserInitiated = mode !== 'scheduled'

    await persistRun({
      runMode: mode,
      startedAt: startedAtIso,
      endedAt: endedAtIso,
      fetchWatermarkUsed: fetchWatermarkUsed,
      fetchedUntil,
      retryReplay,
      counts,
      commandSummary,
      exitCode: error.exitCode ?? null,
      stderrSnippet: clipStderr(error.stderr),
      speechCount,
      errorSummary: error.message,
      noteFailures,
    })

    if (isUserInitiated) {
      dependencies.notify(summarizeFailure(counts, error.message))
    } else {
      dependencies.notify(`Scheduled sync failed: ${error.message}`)
    }

    throw error
  }

  async function runSync(mode: BridgeMode): Promise<SyncRunOutcome> {
    if (activeRun) {
      throw new Error('A sync is already in progress')
    }

    const runPromise = (async () => {
      const nowValue = dependencies.now()
      const nowSeconds = Math.floor(nowValue / 1000)
      const startedAtIso = new Date(nowValue).toISOString()
      const isUserInitiated = mode !== 'scheduled'
      const commandSummary = summarizeCommandForDiagnostics(plugin.settings.commandTemplate)
      const fetchWatermarkUsed = computeSince({
        mode,
        nowSeconds,
        settings: plugin.settings,
        state: plugin.state,
      })

      if (!plugin.isLocalProcessExecutionAvailable()) {
        await failRun(
          mode,
          startedAtIso,
          fetchWatermarkUsed,
          commandSummary,
          buildErrorWithMetadata('Sync requires Obsidian desktop with local process execution enabled'),
        )
      }

      if (isUserInitiated) {
        dependencies.notify('Sync started.')
        dependencies.notify('Fetching Otter meetings...')
      }

      let bridgeResult: RunBridgeCommandResult
      try {
        bridgeResult = await dependencies.runBridgeCommand({
          commandTemplate: plugin.settings.commandTemplate,
          since: String(fetchWatermarkUsed),
          mode,
        })
      } catch (error) {
        const bridgeError = error as Error & { stderr?: string; exitCode?: number | null }
        await failRun(mode, startedAtIso, fetchWatermarkUsed, commandSummary, bridgeError)
      }

      await plugin.updateState({ lastFetchWatermark: bridgeResult.payload.fetched_until })

      const hadPendingRetries = plugin.state.pendingRetries.length > 0
      const mergedSpeeches = mergeRetryQueueWithFetches({
        pendingRetries: plugin.state.pendingRetries,
        fetchedSpeeches: bridgeResult.payload.speeches,
      })

      if (isUserInitiated) {
        dependencies.notify('Writing meeting notes...')
      }

      const noteResult = await dependencies.synchronizeNotes({
        app: plugin.app,
        destinationFolder: plugin.settings.destinationFolder,
        speeches: mergedSpeeches,
      })
      const counts = buildCounts(noteResult.notes)
      const speechesByOtid = new Map(mergedSpeeches.map((speech) => [speech.otid, speech]))
      const noteFailures = buildNoteFailures(noteResult.notes, speechesByOtid)
      const attemptedAt = new Date(dependencies.now()).toISOString()

      let pendingRetries = plugin.state.pendingRetries
      for (const note of noteResult.notes) {
        if (note.status === 'failed') {
          const speech = speechesByOtid.get(note.otid)
          if (speech) {
            pendingRetries = replaceRetryEntry(pendingRetries, toRetryEntry(speech, extractFailureReason(note), attemptedAt))
          }
          continue
        }

        pendingRetries = markRetrySuccess(pendingRetries, note.otid)
      }

      await plugin.updateState({ pendingRetries })

      const endedAtIso = new Date(dependencies.now()).toISOString()
      const retryReplay = hadPendingRetries
      const fatalNoteStageMessage = noteResult.diagnostics[0]?.message ?? 'Note synchronization failed'
      const errorSummary = noteFailures[0]?.reason ?? (noteResult.stopped ? fatalNoteStageMessage : null)

      await persistRun({
        runMode: mode,
        startedAt: startedAtIso,
        endedAt: endedAtIso,
        fetchWatermarkUsed,
        fetchedUntil: bridgeResult.payload.fetched_until,
        retryReplay,
        counts,
        commandSummary,
        exitCode: bridgeResult.exitCode,
        stderrSnippet: clipStderr(bridgeResult.stderr),
        speechCount: bridgeResult.payload.speeches.length,
        errorSummary,
        noteFailures,
      })

      if (noteFailures.length > 0 || noteResult.stopped) {
        const failureMessage = noteFailures[0]?.reason ?? noteResult.diagnostics[0]?.message ?? 'Note synchronization failed'
        const failureError = buildErrorWithMetadata(failureMessage, {
          stderr: bridgeResult.stderr,
          exitCode: bridgeResult.exitCode,
        })

        if (isUserInitiated) {
          dependencies.notify(summarizeFailure(counts, failureMessage))
        } else {
          dependencies.notify(`Scheduled sync failed: ${failureMessage}`)
        }

        throw failureError
      }

      await plugin.updateState({ lastCleanSyncTime: dependencies.now() })

      if (isUserInitiated || plugin.settings.showScheduledSuccessNotice) {
        dependencies.notify(`Sync completed: ${summarizeCounts(counts)}`)
      }

      return {
        status: 'success',
        counts,
        fetchedUntil: bridgeResult.payload.fetched_until,
      }
    })()

    activeRun = runPromise

    try {
      return await runPromise
    } finally {
      activeRun = null
    }
  }

  function startScheduling(): void {
    stopScheduling()
    intervalHandle = setInterval(() => {
      void runSync('scheduled').catch(() => undefined)
    }, plugin.settings.syncIntervalMinutes * 60_000)
  }

  function stopScheduling(): void {
    if (intervalHandle !== null) {
      clearInterval(intervalHandle)
      intervalHandle = null
    }
  }

  function registerCommands(): void {
    plugin.addCommand?.({
      id: 'sync-now',
      name: 'Sync now',
      callback: async () => {
        await runSync('manual')
      },
    })

    plugin.addCommand?.({
      id: 'force-sync-now',
      name: 'Force sync now',
      callback: async () => {
        await runSync('forced')
      },
    })
  }

  return {
    registerCommands,
    runSync,
    startScheduling,
    stopScheduling,
  }
}
