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
  failCreateFolderFor: Set<string>
  existingFolders: Set<string>
}

export function createFakeApp(overrides: Partial<FakeApp> = {}): FakeApp & App {
  const fileContents = new Map<string, string>()
  const createdFolders: string[] = []
  const failCreateFolderFor = new Set<string>()
  const existingFolders = new Set<string>()

  const getFile = (path: string): FakeFile | null => {
    if (!fileContents.has(path)) {
      return null
    }

    const basename = path.split('/').pop() ?? path

    return { path, basename }
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
        const content = fileContents.get(file.path)

        if (content === undefined) {
          throw new Error(`File not found: ${file.path}`)
        }

        return content
      },
      async modify(file: FakeFile, content: string): Promise<void> {
        if (!fileContents.has(file.path)) {
          throw new Error(`File not found: ${file.path}`)
        }

        fileContents.set(file.path, content)
      },
      async create(path: string, content: string): Promise<FakeFile> {
        fileContents.set(path, content)
        return { path, basename: path.split('/').pop() ?? path }
      },
      async createFolder(path: string): Promise<FakeFolder> {
        if (failCreateFolderFor.has(path)) {
          throw new Error(`Failed to create folder: ${path}`)
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
    failCreateFolderFor,
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
