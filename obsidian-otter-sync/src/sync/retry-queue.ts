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

export function mergeRetryQueueWithFetches(options: MergeRetryQueueWithFetchesOptions): BridgeSpeech[] {
  const merged = new Map<string, BridgeSpeech>()

  for (const retryEntry of options.pendingRetries) {
    merged.set(retryEntry.otid, toCanonicalSpeech(retryEntry))
  }

  for (const fetchedSpeech of options.fetchedSpeeches) {
    const existing = merged.get(fetchedSpeech.otid)

    if (!existing || fetchedSpeech.modified_time >= existing.modified_time) {
      merged.set(fetchedSpeech.otid, toCanonicalSpeech(fetchedSpeech))
    }
  }

  return [...merged.values()]
}

export function markRetrySuccess(pendingRetries: RetryEntry[], otid: string): RetryEntry[] {
  return pendingRetries.filter((entry) => entry.otid !== otid)
}

export function replaceRetryEntry(pendingRetries: RetryEntry[], nextEntry: RetryEntry): RetryEntry[] {
  const existingIndex = pendingRetries.findIndex((entry) => entry.otid === nextEntry.otid)

  if (existingIndex === -1) {
    return [...pendingRetries, nextEntry]
  }

  return pendingRetries.map((entry, index) => (index === existingIndex ? nextEntry : entry))
}
