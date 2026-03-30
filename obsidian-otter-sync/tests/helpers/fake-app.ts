import type { App, PluginManifest } from 'obsidian'

export interface FakeFile {
  path: string
  basename: string
}

export interface FakeFolder {
  path: string
}

export interface FakeApp {
  isDesktopOnly: boolean
  processExecutionAvailable: boolean
  vault: {
    getMarkdownFiles(): FakeFile[]
    read(file: FakeFile): Promise<string>
    modify(file: FakeFile, content: string): Promise<void>
    create(path: string, content: string): Promise<FakeFile>
    createFolder(path: string): Promise<FakeFolder>
    getAbstractFileByPath(path: string): FakeFile | FakeFolder | null
  }
  workspace: {
    getFileByPath(path: string): FakeFile | null
  }
  fileContents: Map<string, string>
  createdFolders: string[]
  failCreateFor: Set<string>
  failCreateFolderFor: Set<string>
  failModifyFor: Set<string>
  failReadFor: Set<string>
  existingFolders: Set<string>
}

export function createFakeApp(overrides: Partial<FakeApp> = {}): FakeApp & App {
  const fileContents = new Map<string, string>()
  const createdFolders: string[] = []
  const failCreateFor = new Set<string>()
  const failCreateFolderFor = new Set<string>()
  const failModifyFor = new Set<string>()
  const failReadFor = new Set<string>()
  const existingFolders = new Set<string>()

  const getFile = (path: string): FakeFile | null => {
    if (!fileContents.has(path)) {
      return null
    }

    const basename = path.split('/').pop() ?? path

    return { path, basename }
  }

  const getParentFolder = (targetPath: string): string | null => {
    const segments = targetPath.split('/').filter((segment) => segment.length > 0)

    if (segments.length <= 1) {
      return null
    }

    return segments.slice(0, -1).join('/')
  }

  return {
    isDesktopOnly: true,
    processExecutionAvailable: true,
    vault: {
      getMarkdownFiles(): FakeFile[] {
        return [...fileContents.keys()]
          .filter((path) => path.endsWith('.md'))
          .sort()
          .map((path) => ({ path, basename: path.split('/').pop() ?? path }))
      },
      async read(file: FakeFile): Promise<string> {
        if (failReadFor.has(file.path)) {
          throw new Error(`Failed to read file: ${file.path}`)
        }

        const content = fileContents.get(file.path)

        if (content === undefined) {
          throw new Error(`File not found: ${file.path}`)
        }

        return content
      },
      async modify(file: FakeFile, content: string): Promise<void> {
        if (failModifyFor.has(file.path)) {
          throw new Error(`Failed to modify file: ${file.path}`)
        }

        if (!fileContents.has(file.path)) {
          throw new Error(`File not found: ${file.path}`)
        }

        fileContents.set(file.path, content)
      },
      async create(path: string, content: string): Promise<FakeFile> {
        if (failCreateFor.has(path)) {
          throw new Error(`Failed to create file: ${path}`)
        }

        fileContents.set(path, content)
        return { path, basename: path.split('/').pop() ?? path }
      },
      async createFolder(path: string): Promise<FakeFolder> {
        if (failCreateFolderFor.has(path)) {
          throw new Error(`Failed to create folder: ${path}`)
        }

        const parentFolder = getParentFolder(path)

        if (parentFolder !== null && !existingFolders.has(parentFolder)) {
          throw new Error(`Parent folder does not exist: ${parentFolder}`)
        }

        existingFolders.add(path)
        createdFolders.push(path)
        return { path }
      },
      getAbstractFileByPath(path: string): FakeFile | FakeFolder | null {
        const file = getFile(path)

        if (file) {
          return file
        }

        if (existingFolders.has(path)) {
          return { path }
        }

        return null
      },
    },
    workspace: {
      getFileByPath(path: string): FakeFile | null {
        return getFile(path)
      },
    },
    fileContents,
    createdFolders,
    failCreateFor,
    failCreateFolderFor,
    failModifyFor,
    failReadFor,
    existingFolders,
    ...overrides,
  } as FakeApp & App
}

export function createFakeManifest(): PluginManifest {
  return {
    id: 'obsidian-otter-sync',
    name: 'Obsidian Otter Sync',
    version: '0.0.1',
    minAppVersion: '1.0.0',
    author: 'Test',
    description: 'Test manifest',
  }
}
