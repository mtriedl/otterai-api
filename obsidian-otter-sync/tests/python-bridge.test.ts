import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { validateBridgePayload } from '../src/sync/schema'
import {
  getShellSpec,
  renderCommandTemplate,
  runBridgeCommand,
  summarizeCommandForDiagnostics,
  validateCommandTemplate,
} from '../src/sync/python-bridge'

const fixturePath = path.resolve(import.meta.dirname, './fixtures/bridge-success.json')

function getError(thunk: () => unknown): Error {
  try {
    thunk()
  } catch (error) {
    return error as Error
  }

  throw new Error('Expected function to throw')
}

describe('validateBridgePayload', () => {
  it('accepts the normalized bridge payload contract', async () => {
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))

    expect(validateBridgePayload(fixture)).toEqual(fixture)
  })

  it('rejects missing required normalized speech fields', () => {
    const error = getError(() =>
      validateBridgePayload({
        fetched_until: 1773246769,
        speeches: [
          {
            otid: 'speech-1',
            source_url: 'https://otter.ai/u/speech-1',
            title: '',
            created_at: 1773246700,
            modified_time: 1773246769,
            attendees: ['Alice'],
            summary_markdown: 'Summary',
            transcript_segments: [
              {
                speaker_name: 'Alice',
                timestamp: '0:05',
                text: 'Hello',
              },
            ],
          },
        ],
      }),
    )

    expect(error).toMatchObject({
      name: 'PythonBridgeSchemaError',
      message: expect.stringContaining('title'),
    })
  })
})

describe('command template helpers', () => {
  it('rejects quoted placeholders and missing required placeholders', () => {
    const quotedError = getError(() => validateCommandTemplate("python sync.py '{since}' {mode}"))
    const missingError = getError(() => validateCommandTemplate('python sync.py {since}'))

    expect(quotedError).toMatchObject({
      name: 'PythonBridgeConfigurationError',
      message: expect.stringContaining('quoted'),
    })
    expect(missingError).toMatchObject({
      name: 'PythonBridgeConfigurationError',
      message: expect.stringContaining('{mode}'),
    })
  })

  it('renders safe substituted command output exactly', () => {
    expect(
      renderCommandTemplate(
        'python sync.py --since {since} --mode {mode}',
        {
          since: '2026-03-11 08:30:00',
          mode: "man's sync",
        },
        'darwin',
      ),
    ).toBe("python sync.py --since '2026-03-11 08:30:00' --mode 'man'\"'\"'s sync'")
    expect(
      renderCommandTemplate(
        'python sync.py --since {since} --mode {mode}',
        {
          since: '2026-03-11 08:30:00',
          mode: 'manual sync',
        },
        'win32',
      ),
    ).toBe('python sync.py --since "2026-03-11 08:30:00" --mode "manual sync"')
  })

  it('returns the expected shell specification', () => {
    expect(getShellSpec('darwin')).toEqual({ command: '/bin/sh', args: ['-lc'] })
    expect(getShellSpec('linux')).toEqual({ command: '/bin/sh', args: ['-lc'] })
    expect(getShellSpec('win32')).toEqual({ command: 'cmd.exe', args: ['/d', '/s', '/c'] })
  })

  it('builds a safe structured diagnostics summary without raw command text', () => {
    const summary = summarizeCommandForDiagnostics('python sync.py --token super-secret {since} {mode}', 'darwin')

    expect(summary).toEqual({
      configured: true,
      hasQuotedPlaceholders: false,
      hasSincePlaceholder: true,
      hasModePlaceholder: true,
      shell: {
        command: '/bin/sh',
        args: ['-lc'],
      },
    })
    expect(JSON.stringify(summary)).not.toContain('super-secret')
    expect(JSON.stringify(summary)).not.toContain('python sync.py')
  })
})

describe('runBridgeCommand', () => {
  let tempDir = ''
  let harnessPath = ''

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'python-bridge-test-'))
    harnessPath = path.join(tempDir, 'bridge-harness.mjs')

    await writeFile(
      harnessPath,
      `import { readFile } from 'node:fs/promises'

const [, , scenario, fixtureFile, since, mode] = process.argv

if (scenario === 'success') {
  const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'))
  process.stderr.write(\`stderr for \${since} in \${mode}\`)
  process.stdout.write(JSON.stringify(fixture))
  process.exit(0)
}

if (scenario === 'invalid-json') {
  process.stderr.write('not json stderr')
  process.stdout.write('not valid json')
  process.exit(0)
}

if (scenario === 'malformed-schema') {
  process.stderr.write('schema stderr')
  process.stdout.write(JSON.stringify({ fetched_until: 1773246769, speeches: [{ otid: '', source_url: 'https://otter.ai/u/1', title: '', created_at: 1, modified_time: 2, attendees: [], summary_markdown: '', transcript_segments: [] }] }))
  process.exit(0)
}

if (scenario === 'non-zero') {
  process.stderr.write('bridge failed')
  process.stdout.write(JSON.stringify({ fetched_until: 1773246769, speeches: [] }))
  process.exit(7)
}

if (scenario === 'timeout') {
  process.stderr.write('starting long run', () => {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ fetched_until: 1773246769, speeches: [] }))
      process.exit(0)
    }, 10_000)
  })
}
`,
      'utf8',
    )
  })

  afterAll(async () => {
    if (tempDir !== '') {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  function makeTemplate(scenario: string): string {
    return `"${process.execPath}" "${harnessPath}" ${scenario} "${fixturePath}" {since} {mode}`
  }

  it('captures stdout, stderr, exit code, and the validated payload', async () => {
    const result = await runBridgeCommand({
      commandTemplate: makeTemplate('success'),
      since: '1773246700',
      mode: 'manual',
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('stderr for 1773246700 in manual')
    expect(result.stdout).toContain('fetched_until')
    expect(result.payload).toMatchObject({
      fetched_until: 1773246769,
    })
  })

  it('rejects invalid JSON distinctly from schema validation failures', async () => {
    await expect(
      runBridgeCommand({
        commandTemplate: makeTemplate('invalid-json'),
        since: '1773246700',
        mode: 'manual',
      }),
    ).rejects.toMatchObject({
      name: 'PythonBridgeInvalidJsonError',
      stderr: 'not json stderr',
      exitCode: 0,
    })

    await expect(
      runBridgeCommand({
        commandTemplate: makeTemplate('malformed-schema'),
        since: '1773246700',
        mode: 'manual',
      }),
    ).rejects.toMatchObject({
      name: 'PythonBridgeSchemaError',
      stderr: 'schema stderr',
      exitCode: 0,
    })
  })

  it('rejects non-zero bridge exits', async () => {
    await expect(
      runBridgeCommand({
        commandTemplate: makeTemplate('non-zero'),
        since: '1773246700',
        mode: 'manual',
      }),
    ).rejects.toMatchObject({
      name: 'PythonBridgeExitError',
      stderr: 'bridge failed',
      exitCode: 7,
    })
  })

  it('kills the child process when the timeout elapses', async () => {
    await expect(
      runBridgeCommand({
        commandTemplate: makeTemplate('timeout'),
        since: '1773246700',
        mode: 'manual',
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({
      name: 'PythonBridgeTimeoutError',
      exitCode: null,
    })
  })

  it('treats command-template validation failures as configuration errors', async () => {
    await expect(
      runBridgeCommand({
        commandTemplate: `"${process.execPath}" "${harnessPath}" success "${fixturePath}" '{since}' {mode}`,
        since: '1773246700',
        mode: 'manual',
      }),
    ).rejects.toMatchObject({
      name: 'PythonBridgeConfigurationError',
      message: expect.stringContaining('quoted'),
    })
  })
})
