import { buildManagedFrontmatter, mergeManagedFrontmatter, parseFrontmatter, renderFrontmatter } from './frontmatter'
import { renderNewNote, renderSummary, renderTranscript } from './renderer'
import { buildFilename, cleanseTitle } from './title'
import type { BridgeSpeech } from '../sync/schema'
import type { FrontmatterValue } from './frontmatter'

interface VaultFileLike {
  path: string
  basename: string
}

interface VaultFolderLike {
  path: string
}

interface VaultLike {
  getMarkdownFiles(): VaultFileLike[]
  read(file: VaultFileLike): Promise<string>
  modify(file: VaultFileLike, content: string): Promise<void>
  create(path: string, content: string): Promise<VaultFileLike>
  createFolder(path: string): Promise<unknown>
  getAbstractFileByPath(path: string): VaultFileLike | VaultFolderLike | null
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
    | 'vault-operation-failed'
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

function isVaultFile(entry: VaultFileLike | VaultFolderLike): entry is VaultFileLike {
  return 'basename' in entry
}

const LEGACY_SOURCE_PATTERN = /^https?:\/\/otter\.ai\/u\/([A-Za-z0-9_-]+)$/
const USER_NOTES_HEADING = /^## User Notes[ \t]*$/gm
const SECTION_HEADING_PATTERN = /^## (User Notes|Summary|Transcript)[ \t]*$/gm
const MANAGED_BOUNDARY_HEADING_PATTERN = /^#{2,6}[ \t]+.*(?:summary|transcript).*$/gim

function normalizeDestinationFolderPath(destinationFolder: string): string {
  return destinationFolder
    .trim()
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/')
}

async function ensureDestinationFolderExists(app: AppLike, destinationFolder: string): Promise<void> {
  const segments = destinationFolder.split('/').filter((segment) => segment.length > 0)

  for (let index = 0; index < segments.length; index += 1) {
    const folderPath = segments.slice(0, index + 1).join('/')
    const entry = app.vault.getAbstractFileByPath(folderPath)

    if (entry === null) {
      await app.vault.createFolder(folderPath)
      continue
    }

    if (isVaultFile(entry)) {
      throw new Error(`Destination folder path points to a file: ${folderPath}`)
    }
  }
}

function isDestinationFile(path: string, destinationFolder: string): boolean {
  return path === destinationFolder || path.startsWith(`${destinationFolder}/`)
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

function findNextManagedBoundaryIndex(body: string, startIndex: number): number | null {
  const pattern = new RegExp(MANAGED_BOUNDARY_HEADING_PATTERN.source, MANAGED_BOUNDARY_HEADING_PATTERN.flags)
  pattern.lastIndex = startIndex
  const match = pattern.exec(body)

  return match?.index ?? null
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

  const nextManagedHeading = headings.find((heading) => heading.index > userHeading.index)
  const nextManagedBoundaryIndex = findNextManagedBoundaryIndex(body, userHeading.end)
  const endIndex = isCanonical
    ? (nextManagedHeading?.index ?? body.length)
    : (nextManagedBoundaryIndex ?? body.length)
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
  const userNotesWithBoundary = userNotes.endsWith('\n\n') ? userNotes : userNotes.endsWith('\n') ? `${userNotes}\n` : `${userNotes}\n\n`

  return `${frontmatter}

# ${cleanseTitle(speech.title)}

## User Notes${userNotesWithBoundary}## Summary

${renderSummary(speech.summary_markdown)}

## Transcript

${renderTranscript(speech.transcript_segments)}
`
}

async function loadDestinationNotes(
  app: AppLike,
  destinationFolder: string,
): Promise<{ notes: ParsedNote[]; diagnostics: SynchronizerDiagnostic[]; unreadablePaths: string[] }> {
  const files = app.vault.getMarkdownFiles().filter((file) => isDestinationFile(file.path, destinationFolder))
  const diagnostics: SynchronizerDiagnostic[] = []
  const unreadablePaths: string[] = []
  const loadedNotes = await Promise.all(
    files.map(async (file) => {
      try {
        const content = await app.vault.read(file)
        return parseNote(file, content)
      } catch (error) {
        unreadablePaths.push(file.path)
        diagnostics.push({
          code: 'vault-operation-failed',
          message: toErrorMessage(error),
          path: file.path,
        })
        return null
      }
    }),
  )
  const notes = loadedNotes.filter((note): note is ParsedNote => note !== null)

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

  return { notes, diagnostics, unreadablePaths }
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Vault operation failed'
}

function buildVaultFailureResult(otid: string, path: string, error: unknown): SynchronizeNoteResult {
  return {
    otid,
    status: 'failed',
    path,
    normalized: false,
    diagnostics: [
      {
        code: 'vault-operation-failed',
        message: toErrorMessage(error),
        path,
      },
    ],
  }
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
  const normalizedDestinationFolder = normalizeDestinationFolderPath(destinationFolder)

  if (normalizedDestinationFolder === '') {
    diagnostics.push({
      code: 'destination-folder-create-failed',
      message: 'Destination folder setting must not be empty.',
      fatal: true,
    })

    return {
      notes: [],
      diagnostics,
      stopped: true,
    }
  }

  const destinationEntry = app.vault.getAbstractFileByPath(normalizedDestinationFolder)

  if (destinationEntry !== null && isVaultFile(destinationEntry)) {
    diagnostics.push({
      code: 'destination-folder-create-failed',
      message: 'Destination folder path points to a file instead of a folder.',
      path: normalizedDestinationFolder,
      fatal: true,
    })

    return {
      notes: [],
      diagnostics,
      stopped: true,
    }
  }

  if (destinationEntry === null) {
    try {
      await ensureDestinationFolderExists(app, normalizedDestinationFolder)
    } catch {
      diagnostics.push({
        code: 'destination-folder-create-failed',
        message: 'Failed to create destination folder.',
        path: normalizedDestinationFolder,
        fatal: true,
      })

      return {
        notes: [],
        diagnostics,
        stopped: true,
      }
    }
  }

  const loaded = await loadDestinationNotes(app, normalizedDestinationFolder)
  diagnostics.push(...loaded.diagnostics)
  const notes = loaded.notes
  const unreadablePaths = [...loaded.unreadablePaths].sort()
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
      if (unreadablePaths.length > 0) {
        results.push({
          otid: speech.otid,
          status: 'failed',
          normalized: false,
          diagnostics: [
            {
              code: 'vault-operation-failed',
              message: 'Failed to safely match existing destination notes because some notes could not be read.',
              conflictingPaths: unreadablePaths,
            },
          ],
        })
        continue
      }

      const path = resolveCreatePath(notes, normalizedDestinationFolder, speech)
      try {
        const file = await app.vault.create(path, renderNewNote(speech))
        notes.push(parseNote(file, await app.vault.read(file)))
        results.push({
          otid: speech.otid,
          status: 'created',
          path,
          normalized: false,
          diagnostics: [],
        })
      } catch (error) {
        results.push(buildVaultFailureResult(speech.otid, path, error))
      }
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
    try {
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
    } catch (error) {
      results.push(buildVaultFailureResult(speech.otid, match.file.path, error))
    }
  }

  return {
    notes: results,
    diagnostics,
    stopped: false,
  }
}
