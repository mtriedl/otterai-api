import { Notice } from 'obsidian'
import { unlink } from 'node:fs/promises'

import { recordRunResult, type NoteFailureRecord, type RunCounts, type RunRecord } from '../diagnostics'
import { getRequiredSyncSettingsError, type OtterSyncSettings } from '../settings'
import type { RetryEntry, SyncState } from '../state'
import { synchronizeNotes, type SynchronizeNoteResult, type SynchronizeNotesResult } from '../notes/synchronizer'
import {
  getShellSpec,
  renderCommandTemplate,
  runBridgeCommand,
  summarizeCommandForDiagnostics,
  type BridgeMode,
  type CommandDiagnosticsSummary,
  type RunBridgeCommandResult,
} from './python-bridge'
import { mergeRetryQueueWithFetches, markRetrySuccess, replaceRetryEntry } from './retry-queue'
import type { BridgeSpeech } from './schema'

const ONE_DAY_SECONDS = 86_400
const SNIPPET_LIMIT = 2000

type SynchronizerApp = Parameters<typeof synchronizeNotes>[0]['app']

interface PluginLike {
  app: SynchronizerApp
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
  synchronizeNotes: typeof synchronizeNotes
}

interface ComputeSinceOptions {
  mode: BridgeMode
  nowSeconds: number
  settings: OtterSyncSettings
  state: SyncState
}

interface BridgeEnvelopeLike {
  payload_path?: unknown
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

function buildErrorSummary(message: string, stderr: string | undefined): string {
  const trimmed = stderr?.trim()

  if (!trimmed) {
    return message
  }

  return `${message}\n\nstderr:\n${trimmed}`
}

function clipSnippet(value: string | undefined): string | null {
  if (!value) {
    return null
  }

  return value.slice(0, SNIPPET_LIMIT)
}

function getPayloadPath(stdout: string): string | null {
  try {
    const envelope = JSON.parse(stdout) as BridgeEnvelopeLike
    return typeof envelope.payload_path === 'string' && envelope.payload_path.trim() !== '' ? envelope.payload_path : null
  } catch {
    return null
  }
}

async function cleanupPayloadFileIfNeeded(settings: OtterSyncSettings, stdout: string): Promise<void> {
  if (!settings.deletePayloadFilesAfterSync) {
    return
  }

  const payloadPath = getPayloadPath(stdout)

  if (payloadPath === null) {
    return
  }

  try {
    await unlink(payloadPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return
    }
  }
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
    error: Error & { stderr?: string; stdout?: string; exitCode?: number | null },
    counts: RunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 },
    noteFailures: NoteFailureRecord[] = [],
    synchronizerDiagnostics: RunRecord['synchronizerDiagnostics'] = [],
    fetchedUntil: number | null = null,
    retryReplay = false,
    speechCount = 0,
    renderedShell: string | null = null,
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
      stderrSnippet: clipSnippet(error.stderr),
      stdoutSnippet: clipSnippet(error.stdout),
      renderedShell: renderedShell,
      speechCount,
      errorSummary: buildErrorSummary(error.message, error.stderr),
      noteFailures,
      synchronizerDiagnostics,
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
      const requiredSettingsError = getRequiredSyncSettingsError(plugin.settings)

      if (requiredSettingsError !== null) {
        return await failRun(
          mode,
          startedAtIso,
          fetchWatermarkUsed,
          commandSummary,
          buildErrorWithMetadata(requiredSettingsError),
        )
      }

      if (!plugin.isLocalProcessExecutionAvailable()) {
        return await failRun(
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

      let renderedShell: string | null = null
      try {
        const shell = getShellSpec()
        const rendered = renderCommandTemplate(
          plugin.settings.commandTemplate,
          { since: String(fetchWatermarkUsed), mode },
        )
        renderedShell = `${shell.command} ${shell.args.join(' ')} ${rendered}`
      } catch {
        // template validation will fail in runBridgeCommand below
      }

      const bridgeResult = await dependencies.runBridgeCommand({
        commandTemplate: plugin.settings.commandTemplate,
        since: String(fetchWatermarkUsed),
        mode,
      }).catch(async (error: unknown) => {
        const bridgeError = error as Error & { stderr?: string; stdout?: string; exitCode?: number | null }
        return await failRun(
          mode, startedAtIso, fetchWatermarkUsed, commandSummary, bridgeError,
          undefined, undefined, undefined, undefined, undefined, undefined, renderedShell,
        )
      })

      await plugin.updateState({ lastFetchWatermark: bridgeResult.payload.fetched_until })

      const hadPendingRetries = plugin.state.pendingRetries.length > 0
      const mergedSpeeches = mergeRetryQueueWithFetches({
        pendingRetries: plugin.state.pendingRetries,
        fetchedSpeeches: bridgeResult.payload.speeches,
      })

      if (isUserInitiated) {
        dependencies.notify('Writing meeting notes...')
      }

      const speechesByOtid = new Map(mergedSpeeches.map((speech) => [speech.otid, speech]))
      const attemptedAt = new Date(dependencies.now()).toISOString()
      const noteResult = await dependencies.synchronizeNotes({
        app: plugin.app,
        destinationFolder: plugin.settings.destinationFolder,
        speeches: mergedSpeeches,
        forceUpdate: mode !== 'scheduled',
      }).catch(async (error: unknown) => {
        let pendingRetries = plugin.state.pendingRetries
        const noteSyncError = error as Error & { stderr?: string; exitCode?: number | null }

        for (const speech of mergedSpeeches) {
          pendingRetries = replaceRetryEntry(pendingRetries, toRetryEntry(speech, noteSyncError.message, attemptedAt))
        }

        await plugin.updateState({ pendingRetries })
        return await failRun(
          mode,
          startedAtIso,
          fetchWatermarkUsed,
          commandSummary,
          buildErrorWithMetadata(noteSyncError.message, {
            stderr: noteSyncError.stderr ?? bridgeResult.stderr,
            exitCode: noteSyncError.exitCode ?? bridgeResult.exitCode,
          }),
          { created: 0, updated: 0, skipped: 0, failed: 0 },
          [],
          [],
          bridgeResult.payload.fetched_until,
          hadPendingRetries,
          bridgeResult.payload.speeches.length,
          renderedShell,
        )
      })

      const counts = buildCounts(noteResult.notes)
      const noteFailures = buildNoteFailures(noteResult.notes, speechesByOtid)

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

      if (noteResult.stopped && noteFailures.length === 0) {
        const fatalReason = noteResult.diagnostics[0]?.message ?? 'Note synchronization failed'

        for (const speech of mergedSpeeches) {
          pendingRetries = replaceRetryEntry(pendingRetries, toRetryEntry(speech, fatalReason, attemptedAt))
        }
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
        stderrSnippet: clipSnippet(bridgeResult.stderr),
        stdoutSnippet: clipSnippet(bridgeResult.stdout),
        renderedShell: renderedShell,
        speechCount: bridgeResult.payload.speeches.length,
        errorSummary,
        noteFailures,
        synchronizerDiagnostics: noteResult.diagnostics,
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
      await cleanupPayloadFileIfNeeded(plugin.settings, bridgeResult.stdout)

      if (isUserInitiated || plugin.settings.showScheduledSuccessNotice) {
        dependencies.notify(`Sync completed: ${summarizeCounts(counts)}`)
      }

      const outcome: SyncRunOutcome = {
        status: 'success',
        counts,
        fetchedUntil: bridgeResult.payload.fetched_until,
      }

      return outcome
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
