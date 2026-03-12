import type { BridgeSpeech } from '../sync/schema'

const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*]+/g
const COLLAPSED_WHITESPACE = /\s+/g
const UNTITLED_MEETING = 'Untitled Meeting'
const SHORT_OTID_LENGTH = 8

function normalizeTimestamp(timestamp: number): number {
  return timestamp >= 1_000_000_000_000 ? timestamp : timestamp * 1_000
}

export function formatSpeechDate(timestamp: number): string {
  return new Date(normalizeTimestamp(timestamp)).toISOString().slice(0, 10)
}

export function cleanseTitle(title: string): string {
  const cleansed = title.replace(INVALID_FILENAME_CHARACTERS, ' ').replace(COLLAPSED_WHITESPACE, ' ').trim()

  return cleansed === '' ? UNTITLED_MEETING : cleansed
}

export function buildFilename(speech: BridgeSpeech, hasCollision: boolean): string {
  const baseName = `${formatSpeechDate(speech.created_at)} - ${cleanseTitle(speech.title)}`

  if (!hasCollision) {
    return `${baseName}.md`
  }

  return `${baseName} - ${speech.otid.slice(0, SHORT_OTID_LENGTH)}.md`
}
