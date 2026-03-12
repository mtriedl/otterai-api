import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const projectRoot = path.resolve(import.meta.dirname, '../..')
const packageJsonPath = path.join(projectRoot, 'node_modules', 'obsidian', 'package.json')
const entryPath = path.join(projectRoot, 'node_modules', 'obsidian', 'index.mjs')

let initialized = false

export async function ensureTestObsidianModule(): Promise<void> {
  if (initialized) {
    return
  }

  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    main?: string
  }

  if (packageJson.main !== 'index.mjs') {
    packageJson.main = 'index.mjs'
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 4)}\n`)
  }

  await writeFile(entryPath, "export * from '../../tests/helpers/obsidian-runtime.mjs'\n")

  initialized = true
}
