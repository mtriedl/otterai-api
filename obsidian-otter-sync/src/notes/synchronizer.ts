import { buildManagedFrontmatter, mergeManagedFrontmatter, renderFrontmatter } from './frontmatter'
import { renderNewNote, renderSummary, renderTranscript } from './renderer'
import { buildFilename, cleanseTitle } from './title'
import type { BridgeSpeech } from '../sync/schema'

type FrontmatterScalar = string | number | boolean | null
type FrontmatterValue = FrontmatterScalar | FrontmatterScalar[]

interface VaultFileLike {
  path: string
  basename: string
}

interface VaultLike {
  getMarkdownFiles(): VaultFileLike[]
  read(file: VaultFileLike): Promise<string>
  modify(file: VaultFileLike, content: string): Promise<void>
  create(path: string, content: string): Promise<VaultFileLike>
  createFolder(path: string): Promise<unknown>
  getAbstractFileByPath(path: string): VaultFileLike | { path: string } | null
}

interface AppLike {
  vault: VaultLike
}

export interface SynchronizerDiagnostic {
  code:
    | 'unsafe-user-notes'
    | 'normalized-managed-sections'
    | 'invalid-legacy-source'
    | 'duplicate-note-match'
    | 'destination-folder-create-failed'
  message: string
  path?: string
  fatal?: boolean
  conflictingPaths?: string[]
}

export interface SynchronizeNoteResult {
  otid: string
  status: 'created' | 'updated' | 'skipped' | 'failed'
  path?: string
  normalized: boolean
  diagnostics: SynchronizerDiagnostic[]
}

export interface SynchronizeNotesResult {
  notes: SynchronizeNoteResult[]
  diagnostics: SynchronizerDiagnostic[]
  stopped: boolean
}

interface ParsedNote {
  file: VaultFileLike
  frontmatter: Record<string, FrontmatterValue>
  body: string
}

const LEGACY_SOURCE_PATTERN = /^https?:\/\/otter\.ai\/u\/([A-Za-z0-9_-]+)$/
const USER_NOTES_HEADING = /^## User Notes[ \t]*$/gm
const SECTION_HEADING_PATTERN = /^## (User Notes|Summary|Transcript)[ \t]*$/gm

function isDestinationFile(path: string, destinationFolder: string): boolean {
  return path === destinationFolder || path.startsWith(`${destinationFolder}/`)
}

function splitInlineArrayItems(value: string): string[] {
  const items: string[] = []
  let current = ''
  let inQuotes = false
  let escapeNext = false

  for (const character of value) {
    if (escapeNext) {
      current += character
      escapeNext = false
      continue
    }

    if (character === '\\' && inQuotes) {
      current += character
      escapeNext = true
      continue
    }

    if (character === '"') {
      current += character
      inQuotes = !inQuotes
      continue
    }

    if (character === ',' && !inQuotes) {
      items.push(current.trim())
      current = ''
      continue
    }

    current += character
  }

  if (current.trim() !== '') {
    items.push(current.trim())
  }

  return items
}

function parseScalar(value: string): FrontmatterValue {
  const trimmed = value.trim()

  if (trimmed === '[]') {
    return []
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()

    if (inner === '') {
      return []
    }

    return splitInlineArrayItems(inner).map((item) => parseScalar(item) as FrontmatterScalar)
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed)
  }

  if (trimmed === 'true') {
    return true
  }

  if (trimmed === 'false') {
    return false
  }

  if (trimmed === 'null' || trimmed === '~') {
    return null
  }

  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed)
  }

  return trimmed
}

function parseFrontmatter(content: string): { frontmatter: Record<string, FrontmatterValue>; body: string } {
  if (!content.startsWith('---\n')) {
    return { frontmatter: {}, body: content }
  }

  const closingIndex = content.indexOf('\n---\n', 4)

  if (closingIndex === -1) {
    return { frontmatter: {}, body: content }
  }

  const rawFrontmatter = content.slice(4, closingIndex)
  const body = content.slice(closingIndex + 5)
  const frontmatter: Record<string, FrontmatterValue> = {}
  const lines = rawFrontmatter.split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)

    if (!match) {
      continue
    }

    const [, key, remainder] = match

    if (remainder.trim() === '') {
      const items: FrontmatterScalar[] = []
      let arrayIndex = index + 1

      while (arrayIndex < lines.length) {
        const arrayMatch = /^  - (.*)$/.exec(lines[arrayIndex])
        if (!arrayMatch) {
          break
        }

        items.push(parseScalar(arrayMatch[1]) as FrontmatterScalar)
        arrayIndex += 1
      }

      frontmatter[key] = items
      index = arrayIndex - 1
      continue
    }

    frontmatter[key] = parseScalar(remainder)
  }

  return { frontmatter, body }
}

function parseNote(file: VaultFileLike, content: string): ParsedNote {
  const parsed = parseFrontmatter(content)

  return {
    file,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
  }
}

function parseLegacySourceOtterId(source: FrontmatterValue | undefined): string | null {
  if (typeof source !== 'string') {
    return null
  }

  const match = LEGACY_SOURCE_PATTERN.exec(source.trim())

  return match?.[1] ?? null
}

function collectSectionHeadings(body: string): Array<{ name: string; index: number; end: number }> {
  const headings: Array<{ name: string; index: number; end: number }> = []

  for (const match of body.matchAll(SECTION_HEADING_PATTERN)) {
    headings.push({
      name: match[1],
      index: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    })
  }

  return headings
}

function extractUserNotes(body: string): { userNotes: string; normalized: boolean } | null {
  const userNoteMatches = [...body.matchAll(USER_NOTES_HEADING)]

  if (userNoteMatches.length !== 1) {
    return null
  }

  const headings = collectSectionHeadings(body)
  const userHeading = headings.find((heading) => heading.name === 'User Notes')

  if (!userHeading) {
    return null
  }

  const summaryHeadings = headings.filter((heading) => heading.name === 'Summary')
  const transcriptHeadings = headings.filter((heading) => heading.name === 'Transcript')
  const isCanonical =
    headings.length === 3 &&
    summaryHeadings.length === 1 &&
    transcriptHeadings.length === 1 &&
    headings[0]?.name === 'User Notes' &&
    headings[1]?.name === 'Summary' &&
    headings[2]?.name === 'Transcript'

  const nextHeading = headings.find((heading) => heading.index > userHeading.index)
  const endIndex = nextHeading?.index ?? body.length
  const rawUserNotes = body.slice(userHeading.end, endIndex)

  return {
    userNotes: rawUserNotes,
    normalized: !isCanonical,
  }
}

function buildUpdatedNoteContent(
  speech: BridgeSpeech,
  existingFrontmatter: Record<string, FrontmatterValue>,
  userNotes: string,
): string {
  const mergedFrontmatter = mergeManagedFrontmatter(existingFrontmatter, buildManagedFrontmatter(speech))
  const frontmatter = renderFrontmatter(mergedFrontmatter as Record<string, FrontmatterValue>)

  return `${frontmatter}

# ${cleanseTitle(speech.title)}

## User Notes${userNotes}## Summary

${renderSummary(speech.summary_markdown)}

## Transcript

${renderTranscript(speech.transcript_segments)}
`
}

async function loadDestinationNotes(
  app: AppLike,
  destinationFolder: string,
): Promise<{ notes: ParsedNote[]; diagnostics: SynchronizerDiagnostic[] }> {
  const files = app.vault.getMarkdownFiles().filter((file) => isDestinationFile(file.path, destinationFolder))
  const notes = await Promise.all(
    files.map(async (file) => {
      const content = await app.vault.read(file)
      return parseNote(file, content)
    }),
  )

  const diagnostics: SynchronizerDiagnostic[] = []

  for (const note of notes) {
    if (typeof note.frontmatter.otid === 'string') {
      continue
    }

    if (note.frontmatter.source === undefined) {
      continue
    }

    if (parseLegacySourceOtterId(note.frontmatter.source) !== null) {
      continue
    }

    diagnostics.push({
      code: 'invalid-legacy-source',
      message: 'Existing note has an unparseable legacy source value.',
      path: note.file.path,
    })
  }

  return { notes, diagnostics }
}

function matchExistingNote(notes: ParsedNote[], speech: BridgeSpeech): ParsedNote[] {
  return notes.filter((note) => {
    if (note.frontmatter.otid === speech.otid) {
      return true
    }

    if (note.frontmatter.otid !== undefined) {
      return false
    }

    return parseLegacySourceOtterId(note.frontmatter.source) === speech.otid
  })
}

function resolveCreatePath(notes: ParsedNote[], destinationFolder: string, speech: BridgeSpeech): string {
  const baseFilename = buildFilename(speech, false)
  const basePath = `${destinationFolder}/${baseFilename}`
  const hasCollision = notes.some((note) => note.file.path === basePath)

  return `${destinationFolder}/${buildFilename(speech, hasCollision)}`
}

export async function synchronizeNotes({
  app,
  destinationFolder,
  speeches,
}: {
  app: AppLike
  destinationFolder: string
  speeches: BridgeSpeech[]
}): Promise<SynchronizeNotesResult> {
  const diagnostics: SynchronizerDiagnostic[] = []

  if (app.vault.getAbstractFileByPath(destinationFolder) === null) {
    try {
      await app.vault.createFolder(destinationFolder)
    } catch {
      diagnostics.push({
        code: 'destination-folder-create-failed',
        message: 'Failed to create destination folder.',
        path: destinationFolder,
        fatal: true,
      })

      return {
        notes: [],
        diagnostics,
        stopped: true,
      }
    }
  }

  const loaded = await loadDestinationNotes(app, destinationFolder)
  diagnostics.push(...loaded.diagnostics)
  const notes = loaded.notes
  const results: SynchronizeNoteResult[] = []

  for (const speech of speeches) {
    const matches = matchExistingNote(notes, speech)

    if (matches.length > 1) {
      const resultDiagnostics: SynchronizerDiagnostic[] = [
        {
          code: 'duplicate-note-match',
          message: 'Multiple existing notes matched the same Otter speech.',
          conflictingPaths: matches.map((match) => match.file.path).sort(),
        },
      ]

      results.push({
        otid: speech.otid,
        status: 'failed',
        normalized: false,
        diagnostics: resultDiagnostics,
      })
      continue
    }

    const match = matches[0]

    if (!match) {
      const path = resolveCreatePath(notes, destinationFolder, speech)
      const file = await app.vault.create(path, renderNewNote(speech))
      notes.push(parseNote(file, await app.vault.read(file)))
      results.push({
        otid: speech.otid,
        status: 'created',
        path,
        normalized: false,
        diagnostics: [],
      })
      continue
    }

    const existingSyncTime = typeof match.frontmatter.sync_time === 'number' ? match.frontmatter.sync_time : 0
    if (speech.modified_time <= existingSyncTime) {
      results.push({
        otid: speech.otid,
        status: 'skipped',
        path: match.file.path,
        normalized: false,
        diagnostics: [],
      })
      continue
    }

    const extracted = extractUserNotes(match.body)
    if (!extracted) {
      const resultDiagnostics: SynchronizerDiagnostic[] = [
        {
          code: 'unsafe-user-notes',
          message: 'User notes heading could not be identified exactly once.',
          path: match.file.path,
        },
      ]

      results.push({
        otid: speech.otid,
        status: 'failed',
        path: match.file.path,
        normalized: false,
        diagnostics: resultDiagnostics,
      })
      continue
    }

    const noteDiagnostics: SynchronizerDiagnostic[] = []
    if (extracted.normalized) {
      noteDiagnostics.push({
        code: 'normalized-managed-sections',
        message: 'Managed sections were normalized while preserving user notes.',
        path: match.file.path,
      })
    }

    const updatedContent = buildUpdatedNoteContent(speech, match.frontmatter, extracted.userNotes)
    await app.vault.modify(match.file, updatedContent)

    const reparsed = parseNote(match.file, updatedContent)
    const noteIndex = notes.findIndex((note) => note.file.path === match.file.path)
    if (noteIndex !== -1) {
      notes[noteIndex] = reparsed
    }

    results.push({
      otid: speech.otid,
      status: 'updated',
      path: match.file.path,
      normalized: extracted.normalized,
      diagnostics: noteDiagnostics,
    })
  }

  return {
    notes: results,
    diagnostics,
    stopped: false,
  }
}
