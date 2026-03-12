import { spawn } from 'node:child_process'

import { type BridgePayload, PythonBridgeSchemaError, validateBridgePayload } from './schema'

export interface ShellSpec {
  command: string
  args: string[]
}

export interface RunBridgeCommandOptions {
  commandTemplate: string
  since: string
  mode: string
  timeoutMs?: number
  platform?: NodeJS.Platform
}

export interface RunBridgeCommandResult {
  payload: BridgePayload
  stdout: string
  stderr: string
  exitCode: number
}

export interface CommandDiagnosticsSummary {
  configured: boolean
  hasQuotedPlaceholders: boolean
  hasSincePlaceholder: boolean
  hasModePlaceholder: boolean
  shell: ShellSpec
}

export class PythonBridgeConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PythonBridgeConfigurationError'
  }
}

class PythonBridgeExecutionError extends Error {
  stderr: string
  stdout: string
  exitCode: number | null

  constructor(name: string, message: string, details: { stderr: string; stdout: string; exitCode: number | null }) {
    super(message)
    this.name = name
    this.stderr = details.stderr
    this.stdout = details.stdout
    this.exitCode = details.exitCode
  }
}

export class PythonBridgeInvalidJsonError extends PythonBridgeExecutionError {
  constructor(message: string, details: { stderr: string; stdout: string; exitCode: number | null }) {
    super('PythonBridgeInvalidJsonError', message, details)
  }
}

export class PythonBridgeExitError extends PythonBridgeExecutionError {
  constructor(message: string, details: { stderr: string; stdout: string; exitCode: number | null }) {
    super('PythonBridgeExitError', message, details)
  }
}

export class PythonBridgeTimeoutError extends PythonBridgeExecutionError {
  constructor(message: string, details: { stderr: string; stdout: string; exitCode: number | null }) {
    super('PythonBridgeTimeoutError', message, details)
  }
}

const DEFAULT_TIMEOUT_MS = 60_000
const QUOTED_PLACEHOLDER_PATTERN = /(['"])\{(since|mode)\}\1/

function quoteForPosixShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function quoteForWindowsShell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function getShellSpec(platform: NodeJS.Platform = process.platform): ShellSpec {
  if (platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c'] }
  }

  return { command: '/bin/sh', args: ['-lc'] }
}

export function summarizeCommandForDiagnostics(
  commandTemplate: string,
  platform: NodeJS.Platform = process.platform,
): CommandDiagnosticsSummary {
  return {
    configured: commandTemplate.trim() !== '',
    hasQuotedPlaceholders: QUOTED_PLACEHOLDER_PATTERN.test(commandTemplate),
    hasSincePlaceholder: commandTemplate.includes('{since}'),
    hasModePlaceholder: commandTemplate.includes('{mode}'),
    shell: getShellSpec(platform),
  }
}

export function validateCommandTemplate(commandTemplate: string): void {
  if (commandTemplate.trim() === '') {
    throw new PythonBridgeConfigurationError('Python command template must not be empty')
  }

  if (QUOTED_PLACEHOLDER_PATTERN.test(commandTemplate)) {
    throw new PythonBridgeConfigurationError('Python command template placeholders must not be quoted')
  }

  if (!commandTemplate.includes('{since}')) {
    throw new PythonBridgeConfigurationError('Python command template must include {since}')
  }

  if (!commandTemplate.includes('{mode}')) {
    throw new PythonBridgeConfigurationError('Python command template must include {mode}')
  }
}

export function renderCommandTemplate(
  commandTemplate: string,
  values: { since: string; mode: string },
  platform: NodeJS.Platform = process.platform,
): string {
  validateCommandTemplate(commandTemplate)

  const quote = platform === 'win32' ? quoteForWindowsShell : quoteForPosixShell

  return commandTemplate
    .replaceAll('{since}', quote(values.since))
    .replaceAll('{mode}', quote(values.mode))
}

export async function runBridgeCommand(options: RunBridgeCommandOptions): Promise<RunBridgeCommandResult> {
  validateCommandTemplate(options.commandTemplate)

  const platform = options.platform ?? process.platform
  const shell = getShellSpec(platform)
  const command = renderCommandTemplate(
    options.commandTemplate,
    { since: options.since, mode: options.mode },
    platform,
  )

  const child = spawn(shell.command, [...shell.args, command], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stdout = ''
  let stderr = ''
  let timedOut = false

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return await new Promise<RunBridgeCommandResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL')
        }
      }, 100).unref()
    }, timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(
        new PythonBridgeExitError(`Failed to launch Python bridge command: ${error.message}`, {
          stderr,
          stdout,
          exitCode: null,
        }),
      )
    })

    child.once('close', (exitCode) => {
      clearTimeout(timeout)

      if (timedOut) {
        reject(
          new PythonBridgeTimeoutError(`Python bridge command timed out after ${timeoutMs}ms`, {
            stderr,
            stdout,
            exitCode: null,
          }),
        )
        return
      }

      if (exitCode !== 0) {
        reject(
          new PythonBridgeExitError(`Python bridge command exited with code ${exitCode}`, {
            stderr,
            stdout,
            exitCode,
          }),
        )
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(stdout)
      } catch (error) {
        reject(
          new PythonBridgeInvalidJsonError(`Python bridge command emitted invalid JSON: ${(error as Error).message}`, {
            stderr,
            stdout,
            exitCode,
          }),
        )
        return
      }

      try {
        const payload = validateBridgePayload(parsed)
        resolve({
          payload,
          stdout,
          stderr,
          exitCode,
        })
      } catch (error) {
        if (error instanceof PythonBridgeSchemaError) {
          error.stderr = stderr
          error.stdout = stdout
          error.exitCode = exitCode
        }

        reject(error)
      }
    })
  })
}
