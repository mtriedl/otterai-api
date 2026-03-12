export class Plugin {
  app: unknown
  manifest: unknown
  savedData: unknown
  settingTabs: unknown[] = []

  constructor(app: unknown, manifest: unknown) {
    this.app = app
    this.manifest = manifest
  }

  async loadData(): Promise<unknown> {
    return this.savedData ?? null
  }

  async saveData(data: unknown): Promise<void> {
    this.savedData = data
  }

  addSettingTab(settingTab: unknown): void {
    this.settingTabs.push(settingTab)
  }
}

export class PluginSettingTab {
  containerEl = {
    children: [] as unknown[],
    emptied: false,
    replaceChildren: (...children: unknown[]) => {
      this.containerEl.children = [...children]
    },
    empty: () => {
      this.containerEl.emptied = true
      this.containerEl.children = []
    },
  }

  constructor(_app: unknown, _plugin: unknown) {}
}

export type RecordedSetting = {
  name: string
  desc?: string
  textInputs: number
  textAreas: number
  dropdowns: number
  toggles: number
  buttons: string[]
  textValues: string[]
  textAreaValues: string[]
  dropdownValues: string[]
  toggleValues: boolean[]
  textChangeHandlers: Array<(value: string) => unknown>
  textAreaChangeHandlers: Array<(value: string) => unknown>
  dropdownChangeHandlers: Array<(value: string) => unknown>
  toggleChangeHandlers: Array<(value: boolean) => unknown>
  buttonClickHandlers: Array<() => unknown>
}

class TextComponent {
  private readonly registerOnChange: (callback: (value: string) => unknown) => void
  private readonly setRecordedValue: (value: string) => void

  constructor(
    registerOnChange: (callback: (value: string) => unknown) => void,
    setRecordedValue: (value: string) => void,
  ) {
    this.registerOnChange = registerOnChange
    this.setRecordedValue = setRecordedValue
  }

  setPlaceholder(): this {
    return this
  }

  setValue(value: string): this {
    this.setRecordedValue(value)
    return this
  }

  onChange(callback: (value: string) => unknown): this {
    this.registerOnChange(callback)
    return this
  }
}

class TextAreaComponent extends TextComponent {}

class DropdownComponent {
  private readonly registerOnChange: (callback: (value: string) => unknown) => void
  private readonly setRecordedValue: (value: string) => void

  constructor(
    registerOnChange: (callback: (value: string) => unknown) => void,
    setRecordedValue: (value: string) => void,
  ) {
    this.registerOnChange = registerOnChange
    this.setRecordedValue = setRecordedValue
  }

  addOption(): this {
    return this
  }

  setValue(value: string): this {
    this.setRecordedValue(value)
    return this
  }

  onChange(callback: (value: string) => unknown): this {
    this.registerOnChange(callback)
    return this
  }
}

class ToggleComponent {
  private readonly registerOnChange: (callback: (value: boolean) => unknown) => void
  private readonly setRecordedValue: (value: boolean) => void

  constructor(
    registerOnChange: (callback: (value: boolean) => unknown) => void,
    setRecordedValue: (value: boolean) => void,
  ) {
    this.registerOnChange = registerOnChange
    this.setRecordedValue = setRecordedValue
  }

  setValue(value: boolean): this {
    this.setRecordedValue(value)
    return this
  }

  onChange(callback: (value: boolean) => unknown): this {
    this.registerOnChange(callback)
    return this
  }
}

class ButtonComponent {
  private readonly setting: RecordedSetting

  constructor(setting: RecordedSetting) {
    this.setting = setting
  }

  setButtonText(text: string): this {
    this.setting.buttons.push(text)
    return this
  }

  onClick(callback: () => unknown): this {
    this.setting.buttonClickHandlers.push(callback)
    return this
  }
}

export class Setting {
  record: RecordedSetting

  constructor(containerEl: { children: unknown[] }) {
    this.record = {
      name: '',
      textInputs: 0,
      textAreas: 0,
      dropdowns: 0,
      toggles: 0,
      buttons: [],
      textValues: [],
      textAreaValues: [],
      dropdownValues: [],
      toggleValues: [],
      textChangeHandlers: [],
      textAreaChangeHandlers: [],
      dropdownChangeHandlers: [],
      toggleChangeHandlers: [],
      buttonClickHandlers: [],
    }
    containerEl.children.push(this.record)
  }

  setName(name: string): this {
    this.record.name = name
    return this
  }

  setDesc(desc: string): this {
    this.record.desc = desc
    return this
  }

  addText(cb: (component: TextComponent) => void): this {
    this.record.textInputs += 1
    const index = this.record.textValues.push('') - 1
    cb(new TextComponent(
      (callback) => {
        this.record.textChangeHandlers.push(callback)
      },
      (value) => {
        this.record.textValues[index] = value
      },
    ))
    return this
  }

  addTextArea(cb: (component: TextAreaComponent) => void): this {
    this.record.textAreas += 1
    const index = this.record.textAreaValues.push('') - 1
    cb(new TextAreaComponent(
      (callback) => {
        this.record.textAreaChangeHandlers.push(callback)
      },
      (value) => {
        this.record.textAreaValues[index] = value
      },
    ))
    return this
  }

  addDropdown(cb: (component: DropdownComponent) => void): this {
    this.record.dropdowns += 1
    const index = this.record.dropdownValues.push('') - 1
    cb(new DropdownComponent(
      (callback) => {
        this.record.dropdownChangeHandlers.push(callback)
      },
      (value) => {
        this.record.dropdownValues[index] = value
      },
    ))
    return this
  }

  addToggle(cb: (component: ToggleComponent) => void): this {
    this.record.toggles += 1
    const index = this.record.toggleValues.push(false) - 1
    cb(new ToggleComponent(
      (callback) => {
        this.record.toggleChangeHandlers.push(callback)
      },
      (value) => {
        this.record.toggleValues[index] = value
      },
    ))
    return this
  }

  addButton(cb: (component: ButtonComponent) => void): this {
    cb(new ButtonComponent(this.record))
    return this
  }

  setDisabled(): this {
    return this
  }
}

export type PluginManifest = {
  id: string
  name: string
  version: string
  minAppVersion: string
  author: string
  description: string
}
