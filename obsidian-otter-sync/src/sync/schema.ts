export interface TranscriptSegment {
  speaker_name: string
  timestamp: string
  text: string
}

export interface BridgeSpeech {
  otid: string
  source_url: string
  title: string
  created_at: number
  modified_time: number
  attendees: string[]
  summary_markdown: string
  transcript_segments: TranscriptSegment[]
}

export interface BridgePayload {
  fetched_until: number
  speeches: BridgeSpeech[]
}

export class PythonBridgeSchemaError extends Error {
  stderr?: string
  stdout?: string
  exitCode?: number | null

  constructor(message: string, details?: { stderr?: string; stdout?: string; exitCode?: number | null }) {
    super(message)
    this.name = 'PythonBridgeSchemaError'
    this.stderr = details?.stderr
    this.stdout = details?.stdout
    this.exitCode = details?.exitCode
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PythonBridgeSchemaError(`${path} must be a non-empty string`)
  }

  return value
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new PythonBridgeSchemaError(`${path} must be a string`)
  }

  return value
}

function requireInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value)) {
    throw new PythonBridgeSchemaError(`${path} must be an integer`)
  }

  return value
}

export function validateBridgePayload(payload: unknown): BridgePayload {
  if (!isRecord(payload)) {
    throw new PythonBridgeSchemaError('Bridge payload must be a JSON object')
  }

  if (!Array.isArray(payload.speeches)) {
    throw new PythonBridgeSchemaError('speeches must be an array')
  }

  return {
    fetched_until: requireInteger(payload.fetched_until, 'fetched_until'),
    speeches: payload.speeches.map((speech, speechIndex) => {
      if (!isRecord(speech)) {
        throw new PythonBridgeSchemaError(`speeches[${speechIndex}] must be an object`)
      }

      if (!Array.isArray(speech.attendees)) {
        throw new PythonBridgeSchemaError(`speeches[${speechIndex}].attendees must be an array`)
      }

      if (!Array.isArray(speech.transcript_segments)) {
        throw new PythonBridgeSchemaError(`speeches[${speechIndex}].transcript_segments must be an array`)
      }

      return {
        otid: requireNonEmptyString(speech.otid, `speeches[${speechIndex}].otid`),
        source_url: requireNonEmptyString(speech.source_url, `speeches[${speechIndex}].source_url`),
        title: requireNonEmptyString(speech.title, `speeches[${speechIndex}].title`),
        created_at: requireInteger(speech.created_at, `speeches[${speechIndex}].created_at`),
        modified_time: requireInteger(speech.modified_time, `speeches[${speechIndex}].modified_time`),
        attendees: speech.attendees.map((attendee, attendeeIndex) =>
          requireString(attendee, `speeches[${speechIndex}].attendees[${attendeeIndex}]`),
        ),
        summary_markdown: requireString(speech.summary_markdown, `speeches[${speechIndex}].summary_markdown`),
        transcript_segments: speech.transcript_segments.map((segment, segmentIndex) => {
          if (!isRecord(segment)) {
            throw new PythonBridgeSchemaError(
              `speeches[${speechIndex}].transcript_segments[${segmentIndex}] must be an object`,
            )
          }

          return {
            speaker_name: requireNonEmptyString(
              segment.speaker_name,
              `speeches[${speechIndex}].transcript_segments[${segmentIndex}].speaker_name`,
            ),
            timestamp: requireNonEmptyString(
              segment.timestamp,
              `speeches[${speechIndex}].transcript_segments[${segmentIndex}].timestamp`,
            ),
            text: requireString(
              segment.text,
              `speeches[${speechIndex}].transcript_segments[${segmentIndex}].text`,
            ),
          }
        }),
      }
    }),
  }
}
