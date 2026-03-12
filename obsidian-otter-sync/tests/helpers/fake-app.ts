import type { PluginManifest } from 'obsidian'

export interface FakeApp {
  isDesktopOnly: boolean
  processExecutionAvailable: boolean
}

export function createFakeApp(overrides: Partial<FakeApp> = {}): FakeApp {
  return {
    isDesktopOnly: true,
    processExecutionAvailable: true,
    ...overrides,
  }
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
