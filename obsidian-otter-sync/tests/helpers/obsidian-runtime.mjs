export class Plugin {
  constructor(app, manifest) {
    this.app = app
    this.manifest = manifest
    this.savedData = undefined
    this.settingTabs = []
  }

  async loadData() {
    return this.savedData ?? null
  }

  async saveData(data) {
    this.savedData = data
  }

  addSettingTab(settingTab) {
    this.settingTabs.push(settingTab)
  }
}

export class PluginSettingTab {
  constructor(_app, _plugin) {
    this.containerEl = {
      children: [],
      emptied: false,
      replaceChildren: (...children) => {
        this.containerEl.children = [...children]
      },
      empty: () => {
        this.containerEl.emptied = true
        this.containerEl.children = []
      },
    }
  }
}

class TextComponent {
  constructor(registerOnChange) {
    this.registerOnChange = registerOnChange
  }

  setPlaceholder() {
    return this
  }

  setValue() {
    return this
  }

  onChange(callback) {
    this.registerOnChange(callback)
    return this
  }
}

class TextAreaComponent extends TextComponent {}

class DropdownComponent {
  constructor(registerOnChange) {
    this.registerOnChange = registerOnChange
  }

  addOption() {
    return this
  }

  setValue() {
    return this
  }

  onChange(callback) {
    this.registerOnChange(callback)
    return this
  }
}

class ToggleComponent {
  constructor(registerOnChange) {
    this.registerOnChange = registerOnChange
  }

  setValue() {
    return this
  }

  onChange(callback) {
    this.registerOnChange(callback)
    return this
  }
}

class ButtonComponent {
  constructor(setting) {
    this.setting = setting
  }

  setButtonText(text) {
    this.setting.buttons.push(text)
    return this
  }

  onClick(callback) {
    this.setting.buttonClickHandlers.push(callback)
    return this
  }
}

export class Setting {
  constructor(containerEl) {
    this.record = {
      name: '',
      textInputs: 0,
      textAreas: 0,
      dropdowns: 0,
      toggles: 0,
      buttons: [],
      textChangeHandlers: [],
      textAreaChangeHandlers: [],
      dropdownChangeHandlers: [],
      toggleChangeHandlers: [],
      buttonClickHandlers: [],
    }
    containerEl.children.push(this.record)
  }

  setName(name) {
    this.record.name = name
    return this
  }

  setDesc(desc) {
    this.record.desc = desc
    return this
  }

  addText(cb) {
    this.record.textInputs += 1
    cb(new TextComponent((callback) => {
      this.record.textChangeHandlers.push(callback)
    }))
    return this
  }

  addTextArea(cb) {
    this.record.textAreas += 1
    cb(new TextAreaComponent((callback) => {
      this.record.textAreaChangeHandlers.push(callback)
    }))
    return this
  }

  addDropdown(cb) {
    this.record.dropdowns += 1
    cb(new DropdownComponent((callback) => {
      this.record.dropdownChangeHandlers.push(callback)
    }))
    return this
  }

  addToggle(cb) {
    this.record.toggles += 1
    cb(new ToggleComponent((callback) => {
      this.record.toggleChangeHandlers.push(callback)
    }))
    return this
  }

  addButton(cb) {
    cb(new ButtonComponent(this.record))
    return this
  }

  setDisabled() {
    return this
  }
}
