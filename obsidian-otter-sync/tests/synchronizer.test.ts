import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { synchronizeNotes } from '../src/notes/synchronizer'
import type { BridgeSpeech } from '../src/sync/schema'
import { createFakeApp } from './helpers/fake-app'

async function readFixture(name: string): Promise<string> {
  return readFile(path.join(import.meta.dirname, 'fixtures', name), 'utf8')
}

function makeSpeech(overrides: Partial<BridgeSpeech> = {}): BridgeSpeech {
  return {
    otid: 'jqb7OHo6mrHtCuMkyLN0nUS8mxY',
    source_url: 'https://otter.ai/u/4ypoVqo4Z4ZUagOc-VfM7mugJIA',
    title: 'Quarterly Planning Review Kickoff',
    created_at: 1773246700,
    modified_time: 1773246769,
    attendees: ['Alice', 'Bob'],
    summary_markdown: '- New summary bullet',
    transcript_segments: [
      {
        speaker_name: 'Alice',
        timestamp: '0:00',
        text: 'Welcome to the meeting.',
      },
    ],
    ...overrides,
  }
}

describe('synchronizeNotes', () => {
  it('matches existing notes by otid within the destination folder and updates without renaming', async () => {
    const app = createFakeApp()
    app.fileContents.set('Meetings/2026-03-11 - Old Title.md', await readFixture('existing-note.md'))

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech({ title: 'Refreshed Meeting Title' })],
    })

    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toMatchObject({
      otid: 'jqb7OHo6mrHtCuMkyLN0nUS8mxY',
      status: 'updated',
      path: 'Meetings/2026-03-11 - Old Title.md',
      normalized: false,
    })
    expect(app.workspace.getFileByPath('Meetings/2026-03-11 - Old Title.md')).not.toBeNull()
    expect(app.workspace.getFileByPath('Meetings/2026-03-11 - Refreshed Meeting Title.md')).toBeNull()

    const content = app.fileContents.get('Meetings/2026-03-11 - Old Title.md')
    expect(content).toContain('# Refreshed Meeting Title')
    expect(content).toContain('## User Notes\n\nKeep this paragraph exactly.')
    expect(content).toContain('tags:\n  - inbox')
    expect(content).toContain('project: Apollo')
    expect(content).toContain('source: https://otter.ai/u/4ypoVqo4Z4ZUagOc-VfM7mugJIA')
    expect(content).toContain('sync_time: 1773246769')
  })

  it('creates a new note in the destination folder and uses a short otid suffix on filename collision', async () => {
    const app = createFakeApp()
    app.fileContents.set('Meetings/2026-03-11 - Quarterly Planning Review Kickoff.md', '# unrelated')

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech()],
    })

    expect(result.notes[0]).toMatchObject({
      status: 'created',
      path: 'Meetings/2026-03-11 - Quarterly Planning Review Kickoff - jqb7OHo6.md',
      normalized: false,
    })
    expect(app.createdFolders).toContain('Meetings')
    expect(app.fileContents.get('Meetings/2026-03-11 - Quarterly Planning Review Kickoff - jqb7OHo6.md')).toContain(
      '## User Notes',
    )
  })

  it('scans only the configured destination folder for matches and duplicates', async () => {
    const app = createFakeApp()
    app.fileContents.set('Archive/2026-03-11 - Quarterly Planning Review Kickoff.md', await readFixture('existing-note.md'))

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech()],
    })

    expect(result.notes[0]).toMatchObject({
      status: 'created',
      path: 'Meetings/2026-03-11 - Quarterly Planning Review Kickoff.md',
    })
  })

  it('fails a note update when user notes cannot be identified exactly once', async () => {
    const app = createFakeApp()
    app.fileContents.set(
      'Meetings/unsafe.md',
      `---
otid: jqb7OHo6mrHtCuMkyLN0nUS8mxY
source: https://otter.ai/u/4ypoVqo4Z4ZUagOc-VfM7mugJIA
sync_time: 1773246700
---

# Unsafe Title

## User Notes

one

## User Notes

two
`,
    )

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech()],
    })

    expect(result.notes[0]).toMatchObject({ status: 'failed', path: 'Meetings/unsafe.md' })
    expect(result.notes[0].diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'unsafe-user-notes' })]),
    )
  })

  it('normalizes malformed managed sections when user notes appear exactly once', async () => {
    const app = createFakeApp()
    app.fileContents.set('Meetings/malformed.md', await readFixture('malformed-user-note.md'))

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech()],
    })

    expect(result.notes[0]).toMatchObject({ status: 'updated', normalized: true, path: 'Meetings/malformed.md' })
    expect(result.notes[0].diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'normalized-managed-sections' })]),
    )
    const content = app.fileContents.get('Meetings/malformed.md')
    expect(content).toContain('## User Notes\n\nThis needs to survive.')
    expect(content).toContain('## Summary\n\n- New summary bullet')
    expect(content).toContain('## Transcript\n\nAlice 0:00\nWelcome to the meeting.')
    expect(content).not.toContain('Broken summary position')
    expect(content).not.toContain('Broken transcript')
  })

  it('treats misleveled managed headings as malformed managed sections during normalization', async () => {
    const app = createFakeApp()
    app.fileContents.set(
      'Meetings/misleveled-managed.md',
      `---
otid: jqb7OHo6mrHtCuMkyLN0nUS8mxY
date: 2026-03-11
type: meeting
attendees:
  - Legacy Person
source: https://otter.ai/u/old-value
sync_time: 1773246700
---

# Old Title

## User Notes

Keep this note.

### Summary

This stale summary should be removed.

### Transcript

This stale transcript should be removed.
`,
    )

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech()],
    })

    expect(result.notes[0]).toMatchObject({ status: 'updated', normalized: true, path: 'Meetings/misleveled-managed.md' })
    const content = app.fileContents.get('Meetings/misleveled-managed.md')
    expect(content).toContain('## User Notes\n\nKeep this note.\n\n## Summary')
    expect(content).toContain('## Summary\n\n- New summary bullet')
    expect(content).toContain('## Transcript\n\nAlice 0:00\nWelcome to the meeting.')
    expect(content).not.toContain('This stale summary should be removed.')
    expect(content).not.toContain('This stale transcript should be removed.')
  })

  it('keeps a section break when normalized user notes run to eof without a trailing newline', async () => {
    const app = createFakeApp()
    app.fileContents.set(
      'Meetings/eof-user-notes.md',
      `---
otid: jqb7OHo6mrHtCuMkyLN0nUS8mxY
date: 2026-03-11
type: meeting
attendees:
  - Legacy Person
source: https://otter.ai/u/old-value
sync_time: 1773246700
---

# Old Title

## User Notes

Last user note line without trailing newline
### Summary

stale summary`,
    )

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech()],
    })

    expect(result.notes[0]).toMatchObject({ status: 'updated', normalized: true, path: 'Meetings/eof-user-notes.md' })
    const content = app.fileContents.get('Meetings/eof-user-notes.md')
    expect(content).toContain('Last user note line without trailing newline\n\n## Summary')
    expect(content).not.toContain('Last user note line without trailing newline## Summary')
  })

  it('normalization preserves only user notes when later managed headings are renamed or missing', async () => {
    const app = createFakeApp()
    app.fileContents.set(
      'Meetings/renamed-sections.md',
      `---
otid: jqb7OHo6mrHtCuMkyLN0nUS8mxY
date: 2026-03-11
type: meeting
attendees:
  - Legacy Person
source: https://otter.ai/u/old-value
sync_time: 1773246700
---

# Old Title

## User Notes

Keep only this note body.

# My Heading

Preserve this top-level user heading.

## Decisions

Preserve this H2 user heading too.

### Decisions

- Preserve this nested heading.

## Meeting Summary

Stale managed summary that must not survive.

## Raw Transcript

Stale managed transcript that must not survive.
`,
    )

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech()],
    })

    expect(result.notes[0]).toMatchObject({ status: 'updated', normalized: true, path: 'Meetings/renamed-sections.md' })
    const content = app.fileContents.get('Meetings/renamed-sections.md')
    expect(content).toContain(
      '## User Notes\n\nKeep only this note body.\n\n# My Heading\n\nPreserve this top-level user heading.\n\n## Decisions\n\nPreserve this H2 user heading too.\n\n### Decisions\n\n- Preserve this nested heading.\n\n## Summary',
    )
    expect(content).toContain('## Summary\n\n- New summary bullet')
    expect(content).toContain('## Transcript\n\nAlice 0:00\nWelcome to the meeting.')
    expect(content).not.toContain('Stale managed summary that must not survive.')
    expect(content).not.toContain('Stale managed transcript that must not survive.')
  })

  it('preserves user-owned h2 content when managed sections are missing entirely', async () => {
    const app = createFakeApp()
    app.fileContents.set(
      'Meetings/missing-managed.md',
      `---
otid: jqb7OHo6mrHtCuMkyLN0nUS8mxY
date: 2026-03-11
type: meeting
attendees:
  - Legacy Person
source: https://otter.ai/u/old-value
sync_time: 1773246700
---

# Old Title

## User Notes

Keep this note body.

## Decisions

- Preserve this user-owned h2 content.
`,
    )

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech()],
    })

    expect(result.notes[0]).toMatchObject({ status: 'updated', normalized: true, path: 'Meetings/missing-managed.md' })
    const content = app.fileContents.get('Meetings/missing-managed.md')
    expect(content).toContain('## User Notes\n\nKeep this note body.\n\n## Decisions\n\n- Preserve this user-owned h2 content.\n\n## Summary')
    expect(content).toContain('## Summary\n\n- New summary bullet')
    expect(content).toContain('## Transcript\n\nAlice 0:00\nWelcome to the meeting.')
  })

  it('migrates legacy source matches, but records invalid legacy source diagnostics without blocking create flow', async () => {
    const app = createFakeApp()
    app.fileContents.set(
      'Meetings/legacy.md',
      `---
date: 2026-03-11
type: meeting
source: https://otter.ai/u/jqb7OHo6mrHtCuMkyLN0nUS8mxY
sync_time: 1773246700
---

# Legacy Match

## User Notes

legacy notes

## Summary

Old summary

## Transcript

Old transcript
`,
    )
    app.fileContents.set(
      'Meetings/unparseable.md',
      `---
source: not-an-otter-url
---

# Bad legacy source
`,
    )

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech(), makeSpeech({ otid: 'second-otid-1234567890', title: 'New Meeting Title' })],
    })

    expect(result.notes[0]).toMatchObject({ status: 'updated', path: 'Meetings/legacy.md' })
    expect(app.fileContents.get('Meetings/legacy.md')).toContain('otid: jqb7OHo6mrHtCuMkyLN0nUS8mxY')
    expect(result.notes[1]).toMatchObject({ status: 'created', path: 'Meetings/2026-03-11 - New Meeting Title.md' })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-legacy-source', path: 'Meetings/unparseable.md' }),
      ]),
    )
  })

  it('fails duplicate matches and reports the conflicting note paths', async () => {
    const app = createFakeApp()
    const existing = await readFixture('existing-note.md')
    app.fileContents.set('Meetings/one.md', existing)
    app.fileContents.set('Meetings/two.md', existing)

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech()],
    })

    expect(result.notes[0]).toMatchObject({ status: 'failed' })
    expect(result.notes[0].diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'duplicate-note-match',
          conflictingPaths: ['Meetings/one.md', 'Meetings/two.md'],
        }),
      ]),
    )
  })

  it('skips notes that are not newer than sync_time and updates managed content when they are newer', async () => {
    const app = createFakeApp()
    const existing = await readFixture('existing-note.md')
    app.fileContents.set('Meetings/skipped.md', existing)
    app.fileContents.set(
      'Meetings/updated.md',
      existing
        .replace('jqb7OHo6mrHtCuMkyLN0nUS8mxY', 'updated-otid-1234567890')
        .replace('https://otter.ai/u/old-value', 'https://otter.ai/u/updated-otid-1234567890')
        .replace('Old Title', 'Another Old Title'),
    )

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [
        makeSpeech({ modified_time: 1773246700 }),
        makeSpeech({ otid: 'updated-otid-1234567890', title: 'Updated Title', source_url: 'https://otter.ai/u/updated-otid-1234567890' }),
      ],
    })

    expect(result.notes[0]).toMatchObject({ status: 'skipped', path: 'Meetings/skipped.md' })
    expect(result.notes[1]).toMatchObject({ status: 'updated', path: 'Meetings/updated.md' })
    expect(app.fileContents.get('Meetings/updated.md')).toContain('# Updated Title')
  })

  it('creates the destination folder before writing and stops the batch on folder creation failure', async () => {
    const app = createFakeApp()
    app.failCreateFolderFor.add('Meetings')

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech(), makeSpeech({ otid: 'second-otid-1234567890', title: 'Second Title' })],
    })

    expect(result.stopped).toBe(true)
    expect(result.notes).toEqual([])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'destination-folder-create-failed', fatal: true, path: 'Meetings' }),
      ]),
    )
  })

  it('does not try to create the destination folder when it already exists', async () => {
    const app = createFakeApp()
    app.existingFolders.add('Meetings')
    app.failCreateFolderFor.add('Meetings')

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech()],
    })

    expect(result.stopped).toBe(false)
    expect(result.notes[0]).toMatchObject({
      status: 'created',
      path: 'Meetings/2026-03-11 - Quarterly Planning Review Kickoff.md',
    })
    expect(app.createdFolders).toEqual([])
  })

  it('fails fatally when the destination folder path already exists as a file', async () => {
    const app = createFakeApp()
    app.fileContents.set('Meetings', 'not a folder')

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech()],
    })

    expect(result.stopped).toBe(true)
    expect(result.notes).toEqual([])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'destination-folder-create-failed', fatal: true, path: 'Meetings' }),
      ]),
    )
  })

  it('preserves canonical user notes verbatim during a standard managed update without normalization', async () => {
    const app = createFakeApp()
    app.fileContents.set(
      'Meetings/standard.md',
      `---
otid: jqb7OHo6mrHtCuMkyLN0nUS8mxY
date: 2026-03-11
type: meeting
attendees:
  - Legacy Person
tags: []
source: https://otter.ai/u/old-value
sync_time: 1773246700
---

# Old Title

## User Notes


Keep this paragraph exactly.

And keep this trailing gap.


## Summary

Old summary

## Transcript

Old transcript
`,
    )

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech({ summary_markdown: 'Fresh summary' })],
    })

    expect(result.notes[0]).toMatchObject({ status: 'updated', normalized: false })
    const content = app.fileContents.get('Meetings/standard.md')
    expect(content).toContain('## User Notes\n\n\nKeep this paragraph exactly.\n\nAnd keep this trailing gap.\n\n\n## Summary')
    expect(content).toContain('tags: []')
    expect(content).toContain('## Summary\n\nFresh summary')
  })

  it('preserves booleans nulls inline arrays and quoted strings in unknown frontmatter keys', async () => {
    const app = createFakeApp()
    app.fileContents.set(
      'Meetings/typed-frontmatter.md',
      `---
otid: jqb7OHo6mrHtCuMkyLN0nUS8mxY
date: 2026-03-11
type: meeting
attendees:
  - Legacy Person
tags:
  - inbox
project:
metadata:
  owner: Alice
  topic: Research
published: true
archived: false
reviewed_at: null
aliases: [alpha, "beta gamma"]
score: 7
ratio: 3.14
scientific: 6.02e23
negative_ratio: -0.5
owner: '123'
source: https://otter.ai/u/old-value
sync_time: 1773246700
---

# Old Title

## User Notes

typed metadata

## Summary

Old summary

## Transcript

Old transcript
`,
    )

    const result = await synchronizeNotes({
      app,
      destinationFolder: 'Meetings',
      speeches: [makeSpeech({ summary_markdown: 'Fresh summary' })],
    })

    expect(result.notes[0]).toMatchObject({ status: 'updated', path: 'Meetings/typed-frontmatter.md' })
    const content = app.fileContents.get('Meetings/typed-frontmatter.md')
    expect(content).toContain('published: true')
    expect(content).toContain('archived: false')
    expect(content).toContain('reviewed_at: null')
    expect(content).toContain('project: null')
    expect(content).not.toContain('project: []')
    expect(content).toContain('metadata:\n  owner: Alice\n  topic: Research')
    expect(content).toContain('aliases:\n  - alpha\n  - beta gamma')
    expect(content).toContain('score: 7')
    expect(content).toContain('ratio: 3.14')
    expect(content).toContain('scientific: 6.02e+23')
    expect(content).toContain('negative_ratio: -0.5')
    expect(content).toContain('owner: "123"')
    expect(content).not.toContain(`owner: "'123'"`)
  })
})
