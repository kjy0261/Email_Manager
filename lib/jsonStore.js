'use strict';

const fs = require('fs');
const path = require('path');

// Small JSON-file store. Writes go to a temp file first and are renamed into
// place, so a crash mid-write can't leave a half-written (unreadable) file.
class JsonStore {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.data = this.load();
  }

  load() {
    try {
      return { ...structuredClone(this.defaults), ...JSON.parse(fs.readFileSync(this.filePath, 'utf8')) };
    } catch (err) {
      return structuredClone(this.defaults);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = { JsonStore };
