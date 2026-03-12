import type { BridgeSpeech } from '../sync/schema'
import { formatSpeechDate } from './title'

export interface ManagedFrontmatter {
  otid: string
  date: string
  type: 'meeting'
  attendees: string[]
  source: string
  sync_time: number
}

export type FrontmatterScalar = string | number | boolean | null
export type FrontmatterValue = FrontmatterScalar | FrontmatterScalar[]

const YAML_SENSITIVE_PATTERN = /(^$)|(^\s)|(\s$)|(:\s)|(^[#\-?]|^[\[\]{}!,&*|>'"%@`])|(\n)/
const YAML_COERCIBLE_PATTERN = /^(?:true|false|null|~|[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?)$/i

function quoteYamlString(value: string): string {
  return JSON.stringify(value)
}

function renderYamlString(value: string): string {
  return YAML_SENSITIVE_PATTERN.test(value) || YAML_COERCIBLE_PATTERN.test(value) ? quoteYamlString(value) : value
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

function renderFrontmatterValue(value: FrontmatterValue): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return ['[]']
    }

    return ['', ...value.map((item) => `  - ${renderYamlString(item)}`)]
  }

  if (typeof value === 'string') {
    return [renderYamlString(value)]
  }

  if (typeof value === 'boolean') {
    return [String(value)]
  }

  if (value === null) {
    return ['null']
  }

  return [String(value)]
}

export function renderFrontmatter(frontmatter: Record<string, FrontmatterValue>): string {
  const lines = ['---']

  for (const [key, value] of Object.entries(frontmatter)) {
    const renderedValue = renderFrontmatterValue(value)

    if (renderedValue.length === 1) {
      lines.push(`${key}: ${renderedValue[0]}`)
      continue
    }

    lines.push(`${key}:${renderedValue[0]}`)
    lines.push(...renderedValue.slice(1))
  }

  lines.push('---')

  return lines.join('\n')
}
