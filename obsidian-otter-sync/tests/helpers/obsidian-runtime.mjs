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
  constructor(registerOnChange, setRecordedValue) {
    this.registerOnChange = registerOnChange
    this.setRecordedValue = setRecordedValue
  }

  setPlaceholder() {
    return this
  }

  setValue(value) {
    this.setRecordedValue(value)
    return this
  }

  onChange(callback) {
    this.registerOnChange(callback)
    return this
  }
}

class TextAreaComponent extends TextComponent {}

class DropdownComponent {
  constructor(registerOnChange, setRecordedValue) {
    this.registerOnChange = registerOnChange
    this.setRecordedValue = setRecordedValue
  }

  addOption() {
    return this
  }

  setValue(value) {
    this.setRecordedValue(value)
    return this
  }

  onChange(callback) {
    this.registerOnChange(callback)
    return this
  }
}

class ToggleComponent {
  constructor(registerOnChange, setRecordedValue) {
    this.registerOnChange = registerOnChange
    this.setRecordedValue = setRecordedValue
  }

  setValue(value) {
    this.setRecordedValue(value)
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
    const index = this.record.textValues.push('') - 1
    cb(new TextComponent((callback) => {
      this.record.textChangeHandlers.push(callback)
    }, (value) => {
      this.record.textValues[index] = value
    }))
    return this
  }

  addTextArea(cb) {
    this.record.textAreas += 1
    const index = this.record.textAreaValues.push('') - 1
    cb(new TextAreaComponent((callback) => {
      this.record.textAreaChangeHandlers.push(callback)
    }, (value) => {
      this.record.textAreaValues[index] = value
    }))
    return this
  }

  addDropdown(cb) {
    this.record.dropdowns += 1
    const index = this.record.dropdownValues.push('') - 1
    cb(new DropdownComponent((callback) => {
      this.record.dropdownChangeHandlers.push(callback)
    }, (value) => {
      this.record.dropdownValues[index] = value
    }))
    return this
  }

  addToggle(cb) {
    this.record.toggles += 1
    const index = this.record.toggleValues.push(false) - 1
    cb(new ToggleComponent((callback) => {
      this.record.toggleChangeHandlers.push(callback)
    }, (value) => {
      this.record.toggleValues[index] = value
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
