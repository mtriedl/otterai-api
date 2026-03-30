import type { RetryEntry } from '../state'
import type { BridgeSpeech } from './schema'

export interface MergeRetryQueueWithFetchesOptions {
  pendingRetries: RetryEntry[]
  fetchedSpeeches: BridgeSpeech[]
}

function toCanonicalSpeech(speech: BridgeSpeech | RetryEntry): BridgeSpeech {
  return {
    otid: speech.otid,
    source_url: speech.source_url,
    title: speech.title,
    created_at: speech.created_at,
    modified_time: speech.modified_time,
    attendees: [...speech.attendees],
    summary_markdown: speech.summary_markdown,
    transcript_segments: speech.transcript_segments.map((segment) => ({ ...segment })),
  }
}

function preferFreshestByModifiedTime(
  merged: Map<string, BridgeSpeech>,
  speech: BridgeSpeech | RetryEntry,
): void {
  const existing = merged.get(speech.otid)

  if (!existing || speech.modified_time >= existing.modified_time) {
    merged.set(speech.otid, toCanonicalSpeech(speech))
  }
}

export function mergeRetryQueueWithFetches(options: MergeRetryQueueWithFetchesOptions): BridgeSpeech[] {
  const merged = new Map<string, BridgeSpeech>()

  for (const retryEntry of options.pendingRetries) {
    preferFreshestByModifiedTime(merged, retryEntry)
  }

  for (const fetchedSpeech of options.fetchedSpeeches) {
    preferFreshestByModifiedTime(merged, fetchedSpeech)
  }

  return [...merged.values()]
}

export function markRetrySuccess(pendingRetries: RetryEntry[], otid: string): RetryEntry[] {
  return pendingRetries.filter((entry) => entry.otid !== otid)
}

export function replaceRetryEntry(pendingRetries: RetryEntry[], nextEntry: RetryEntry): RetryEntry[] {
  const matchingEntries = pendingRetries.filter((entry) => entry.otid === nextEntry.otid)
  const firstMatchingIndex = pendingRetries.findIndex((entry) => entry.otid === nextEntry.otid)

  if (matchingEntries.length === 0) {
    return [...pendingRetries, nextEntry]
  }

  const freshestPayload = matchingEntries.reduce((freshest, entry) =>
    entry.modified_time > freshest.modified_time ? entry : freshest,
  nextEntry)

  const collapsedEntry: RetryEntry = {
    ...freshestPayload,
    failure_reason: nextEntry.failure_reason,
    last_attempted_at: nextEntry.last_attempted_at,
  }

  const dedupedEntries = pendingRetries.filter((entry) => entry.otid !== nextEntry.otid)

  return [
    ...dedupedEntries.slice(0, firstMatchingIndex),
    collapsedEntry,
    ...dedupedEntries.slice(firstMatchingIndex),
  ]
}
