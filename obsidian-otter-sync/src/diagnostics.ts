export interface DiagnosticsState {
  recentRuns: unknown[]
  lastErrorSummary: string | null
}

export const DEFAULT_DIAGNOSTICS: DiagnosticsState = {
  recentRuns: [],
  lastErrorSummary: null,
}
