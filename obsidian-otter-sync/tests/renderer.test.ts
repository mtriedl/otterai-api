import { describe, expect, it } from 'vitest'

import { mergeManagedFrontmatter, normalizeAttendees, renderFrontmatter } from '../src/notes/frontmatter'
import { buildFilename, cleanseTitle } from '../src/notes/title'
import { renderNewNote, renderSummary, renderTranscript } from '../src/notes/renderer'
import type { BridgeSpeech } from '../src/sync/schema'

function makeSpeech(overrides: Partial<BridgeSpeech> = {}): BridgeSpeech {
  return {
    otid: 'jqb7OHo6mrHtCuMkyLN0nUS8mxY',
    source_url: 'https://otter.ai/u/4ypoVqo4Z4ZUagOc-VfM7mugJIA',
    title: '  Quarterly   Planning: Review / Kickoff?  ',
    created_at: 1773246700,
    modified_time: 1773246769,
    attendees: [' Alice ', 'Bob', 'Alice', '  Bob  ', 'Carol'],
    summary_markdown: '- First bullet\n- Second bullet',
    transcript_segments: [
      {
        speaker_name: 'Alice',
        timestamp: '0:00',
        text: 'Welcome to the meeting.',
      },
      {
        speaker_name: 'Bob',
        timestamp: '0:05',
        text: 'Thanks everyone.',
      },
    ],
    ...overrides,
  }
}

describe('renderNewNote', () => {
  it('renders a canonical meeting note with managed frontmatter and sections', () => {
    const rendered = renderNewNote(makeSpeech())

    expect(rendered).toBe(`---
otid: jqb7OHo6mrHtCuMkyLN0nUS8mxY
date: 2026-03-11
type: meeting
attendees:
  - Alice
  - Bob
  - Carol
tags: []
source: https://otter.ai/u/4ypoVqo4Z4ZUagOc-VfM7mugJIA
sync_time: 1773246769
---

# Quarterly Planning Review Kickoff

## User Notes

## Summary

- First bullet
- Second bullet

## Transcript

Alice 0:00
Welcome to the meeting.

Bob 0:05
Thanks everyone.
`)
  })
})

describe('frontmatter helpers', () => {
  it('trims and deduplicates attendees while preserving first-seen order', () => {
    expect(normalizeAttendees([' Alice ', 'Bob', 'Alice', '  ', 'Bob  ', 'Carol'])).toEqual([
      'Alice',
      'Bob',
      'Carol',
    ])
  })

  it('preserves user-managed and unknown keys while overwriting managed ones', () => {
    expect(
      mergeManagedFrontmatter(
        {
          otid: 'old-otid',
          type: 'note',
          tags: ['existing'],
          project: 'Apollo',
          sync_time: 1,
        },
        {
          otid: 'new-otid',
          date: '2026-03-11',
          type: 'meeting',
          attendees: ['Alice'],
          source: 'https://otter.ai/u/new-otid',
          sync_time: 1773246769,
        },
      ),
    ).toEqual({
      otid: 'new-otid',
      type: 'meeting',
      tags: ['existing'],
      project: 'Apollo',
      sync_time: 1773246769,
      date: '2026-03-11',
      attendees: ['Alice'],
      source: 'https://otter.ai/u/new-otid',
    })
  })

  it('quotes yaml-sensitive scalar values safely', () => {
    expect(
      renderFrontmatter({
        owner: 'Bob: CEO',
        tag: '#tag',
        metadata: '{x}',
        status: '- blocked',
        attendees: ['Bob: CEO', '#tag', '{x}', '- blocked'],
      }),
    ).toBe(`---
owner: "Bob: CEO"
tag: "#tag"
metadata: "{x}"
status: "- blocked"
attendees:
  - "Bob: CEO"
  - "#tag"
  - "{x}"
  - "- blocked"
---`)
  })

  it('quotes string scalars that yaml would otherwise coerce', () => {
    expect(
      renderFrontmatter({
        boolTrue: 'true',
        boolFalse: 'false',
        nullLike: 'null',
        numeric: '123',
        attendees: ['true', 'false', 'null', '123'],
      }),
    ).toBe(`---
boolTrue: "true"
boolFalse: "false"
nullLike: "null"
numeric: "123"
attendees:
  - "true"
  - "false"
  - "null"
  - "123"
---`)
  })
})

describe('managed section renderers', () => {
  it('passes summary markdown through unchanged', () => {
    const summary = 'Paragraph one\n\n- bullet\n\n```md\n# fenced\n```'

    expect(renderSummary(summary)).toBe(summary)
  })

  it('renders transcript blocks with heading line then text, separated by blank lines', () => {
    expect(renderTranscript(makeSpeech().transcript_segments)).toBe(
      'Alice 0:00\nWelcome to the meeting.\n\nBob 0:05\nThanks everyone.',
    )
  })
})

describe('title helpers', () => {
  it('cleanses invalid filename characters, collapses spacing, and falls back when empty', () => {
    expect(cleanseTitle('  Quarterly   Planning: Review / Kickoff?  ')).toBe('Quarterly Planning Review Kickoff')
    expect(cleanseTitle('  <>:"/\\|?*  ')).toBe('Untitled Meeting')
  })

  it('builds the base filename and appends a short otid only when collision is flagged', () => {
    const speech = makeSpeech()

    expect(buildFilename(speech, false)).toBe('2026-03-11 - Quarterly Planning Review Kickoff.md')
    expect(buildFilename(speech, true)).toBe('2026-03-11 - Quarterly Planning Review Kickoff - jqb7OHo6.md')
  })
})
