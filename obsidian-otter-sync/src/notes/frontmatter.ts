import type { BridgeSpeech } from '../sync/schema'
import { parse, stringify } from 'yaml'
import { formatSpeechDate } from './title'

export interface ManagedFrontmatter {
  otid: string
  date: string
  type: 'meeting'
  attendees: string[]
  source: string
  sync_time: number
}

export type FrontmatterValue = unknown

interface ParsedFrontmatter {
  frontmatter: Record<string, FrontmatterValue>
  body: string
}

export function normalizeAttendees(attendees: string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const attendee of attendees) {
    const trimmed = attendee.trim()
    if (trimmed === '' || seen.has(trimmed)) {
      continue
    }

    seen.add(trimmed)
    normalized.push(trimmed)
  }

  return normalized
}

export function buildManagedFrontmatter(speech: BridgeSpeech): ManagedFrontmatter {
  return {
    otid: speech.otid,
    date: formatSpeechDate(speech.created_at),
    type: 'meeting',
    attendees: normalizeAttendees(speech.attendees),
    source: speech.source_url,
    sync_time: speech.modified_time,
  }
}

export function mergeManagedFrontmatter(
  existingFrontmatter: Record<string, unknown>,
  managedFrontmatter: ManagedFrontmatter,
): Record<string, unknown> {
  return {
    ...existingFrontmatter,
    ...managedFrontmatter,
  }
}

function isFrontmatterRecord(value: unknown): value is Record<string, FrontmatterValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content.startsWith('---\n')) {
    return { frontmatter: {}, body: content }
  }

  const closingIndex = content.indexOf('\n---\n', 4)

  if (closingIndex === -1) {
    return { frontmatter: {}, body: content }
  }

  const rawFrontmatter = content.slice(4, closingIndex)
  const body = content.slice(closingIndex + 5)

  try {
    const parsed = parse(rawFrontmatter)

    if (!isFrontmatterRecord(parsed)) {
      return { frontmatter: {}, body }
    }

    return { frontmatter: parsed, body }
  } catch {
    return { frontmatter: {}, body: content }
  }
}

export function renderFrontmatter(frontmatter: Record<string, FrontmatterValue>): string {
  const rendered = stringify(frontmatter, {
    lineWidth: 0,
    defaultStringType: 'PLAIN',
  }).trimEnd()

  return rendered === '' ? '---\n---' : `---\n${rendered}\n---`
}
