import { vi } from 'vitest'

export function createFakePluginHost() {
  return {
    app: {},
    plugin: {},
    containerEl: {
      empty() {},
    },
    saveData: vi.fn(),
  }
}
