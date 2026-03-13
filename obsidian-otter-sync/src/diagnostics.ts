import type { CommandDiagnosticsSummary } from './sync/python-bridge'
import type { BridgeMode } from './sync/python-bridge'

export interface RunCounts {
  created: number
  updated: number
  skipped: number
  failed: number
}

export interface NoteFailureRecord {
  otid: string
  source_url: string
  notePath: string
  reason: string
}

export interface RunRecord {
  runMode: BridgeMode
  startedAt: string
  endedAt: string
  fetchWatermarkUsed: number | null
  fetchedUntil: number | null
  retryReplay: boolean
  counts: RunCounts
  commandSummary: CommandDiagnosticsSummary
  exitCode: number | null
  stderrSnippet: string | null
  speechCount: number
  errorSummary: string | null
  noteFailures: NoteFailureRecord[]
}

export interface DiagnosticsState {
  recentRuns: RunRecord[]
  lastErrorSummary: string | null
}

export const DEFAULT_DIAGNOSTICS: DiagnosticsState = {
  recentRuns: [],
  lastErrorSummary: null,
}

const MAX_RUN_HISTORY = 20

export function appendRunHistory(recentRuns: RunRecord[], runRecord: RunRecord): RunRecord[] {
  return [...recentRuns, runRecord].slice(-MAX_RUN_HISTORY)
}

export function recordRunResult(diagnostics: DiagnosticsState, runRecord: RunRecord): DiagnosticsState {
  return {
    recentRuns: appendRunHistory(diagnostics.recentRuns, runRecord),
    lastErrorSummary: runRecord.errorSummary ?? diagnostics.lastErrorSummary,
  }
}
