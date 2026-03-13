import { spawn } from 'node:child_process'

import { type BridgePayload, PythonBridgeSchemaError, validateBridgePayload } from './schema'

export interface ShellSpec {
  command: string
  args: string[]
}

export interface RunBridgeCommandOptions {
  commandTemplate: string
  since: string
  mode: BridgeMode
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

export type BridgeMode = 'scheduled' | 'manual' | 'forced'

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
  childPid: number | null

  constructor(
    name: string,
    message: string,
    details: { stderr: string; stdout: string; exitCode: number | null; childPid: number | null },
  ) {
    super(message)
    this.name = name
    this.stderr = details.stderr
    this.stdout = details.stdout
    this.exitCode = details.exitCode
    this.childPid = details.childPid
  }
}

interface PythonBridgeExecutionDetails {
  stderr: string
  stdout: string
  exitCode: number | null
  childPid: number | null
}

export class PythonBridgeInvalidJsonError extends PythonBridgeExecutionError {
  constructor(message: string, details: PythonBridgeExecutionDetails) {
    super('PythonBridgeInvalidJsonError', message, details)
  }
}

export class PythonBridgeExitError extends PythonBridgeExecutionError {
  constructor(message: string, details: PythonBridgeExecutionDetails) {
    super('PythonBridgeExitError', message, details)
  }
}

export class PythonBridgeTimeoutError extends PythonBridgeExecutionError {
  constructor(message: string, details: PythonBridgeExecutionDetails) {
    super('PythonBridgeTimeoutError', message, details)
  }
}

const DEFAULT_TIMEOUT_MS = 60_000
const FORCE_KILL_GRACE_MS = 100
const QUOTED_PLACEHOLDER_PATTERN = /(['"])\{(since|mode)\}\1/
const VALID_BRIDGE_MODES = new Set<BridgeMode>(['scheduled', 'manual', 'forced'])

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
  values: { since: string; mode: BridgeMode },
  platform: NodeJS.Platform = process.platform,
): string {
  validateCommandTemplate(commandTemplate)
  validateBridgeMode(values.mode)

  const quote = platform === 'win32' ? quoteForWindowsShell : quoteForPosixShell

  return commandTemplate
    .replaceAll('{since}', quote(values.since))
    .replaceAll('{mode}', quote(values.mode))
}

export function validateBridgeMode(mode: string): asserts mode is BridgeMode {
  if (!VALID_BRIDGE_MODES.has(mode as BridgeMode)) {
    throw new PythonBridgeConfigurationError(
      'Python bridge mode must be one of: scheduled, manual, forced',
    )
  }
}

function sendSignalToChildProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return
  }

  if (process.platform === 'win32') {
    child.kill(signal)
    return
  }

  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

export async function runBridgeCommand(options: RunBridgeCommandOptions): Promise<RunBridgeCommandResult> {
  validateCommandTemplate(options.commandTemplate)
  validateBridgeMode(options.mode)

  const platform = options.platform ?? process.platform
  const shell = getShellSpec(platform)
  const command = renderCommandTemplate(
    options.commandTemplate,
    { since: options.since, mode: options.mode },
    platform,
  )

  const child = spawn(shell.command, [...shell.args, command], {
    detached: platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let exited = false

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
      sendSignalToChildProcessTree(child, 'SIGTERM')
      setTimeout(() => {
        if (!exited) {
          sendSignalToChildProcessTree(child, 'SIGKILL')
        }
      }, FORCE_KILL_GRACE_MS).unref()
    }, timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(
        new PythonBridgeExitError(`Failed to launch Python bridge command: ${error.message}`, {
          stderr,
          stdout,
          exitCode: null,
          childPid: child.pid ?? null,
        }),
      )
    })

    child.once('close', (exitCode) => {
      exited = true
      clearTimeout(timeout)

      if (timedOut) {
        reject(
          new PythonBridgeTimeoutError(`Python bridge command timed out after ${timeoutMs}ms`, {
            stderr,
            stdout,
            exitCode: null,
            childPid: child.pid ?? null,
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
            childPid: child.pid ?? null,
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
            childPid: child.pid ?? null,
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
