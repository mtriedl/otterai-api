import type { BridgeSpeech, TranscriptSegment } from '../sync/schema'
import { buildManagedFrontmatter, renderFrontmatter } from './frontmatter'
import { cleanseTitle } from './title'

export function renderSummary(summaryMarkdown: string): string {
  return summaryMarkdown
}

export function renderTranscript(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => `${segment.speaker_name.trim()} ${segment.timestamp}\n${segment.text}`)
    .join('\n\n')
}

export function renderNewNote(speech: BridgeSpeech): string {
  const managedFrontmatter = buildManagedFrontmatter(speech)
  const frontmatter = renderFrontmatter({
    otid: managedFrontmatter.otid,
    date: managedFrontmatter.date,
    type: managedFrontmatter.type,
    attendees: managedFrontmatter.attendees,
    tags: [],
    source: managedFrontmatter.source,
    sync_time: managedFrontmatter.sync_time,
  })

  return `${frontmatter}

# ${cleanseTitle(speech.title)}

## User Notes

## Summary

${renderSummary(speech.summary_markdown)}

## Transcript

${renderTranscript(speech.transcript_segments)}
`
}
