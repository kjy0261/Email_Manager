'use strict';

const fs = require('fs');
const path = require('path');

const ENC_MARKER = 'MCW-ENC1\n';

// Small JSON-file store. Writes go to a temp file first and are renamed into
// place, so a crash mid-write can't leave a half-written (unreadable) file.
//
// With a codec ({ encrypt(string) -> base64, decrypt(base64) -> string }) the
// file is stored encrypted. A plain file from an older version is still read
// and gets encrypted on the next save. A file that can't be decrypted (e.g.
// copied from another Windows account) is set aside, never overwritten.
class JsonStore {
  constructor(filePath, defaults, codec = null) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.codec = codec;
    this.data = this.load();
  }

  fresh() {
    return structuredClone(this.defaults);
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      return this.fresh();
    }
    try {
      let text = raw;
      if (raw.startsWith(ENC_MARKER)) {
        if (!this.codec) throw new Error('encrypted file but no codec');
        text = this.codec.decrypt(raw.slice(ENC_MARKER.length).trim());
      }
      return { ...this.fresh(), ...JSON.parse(text) };
    } catch (err) {
      const aside = `${this.filePath}.unreadable-${Date.now()}`;
      try {
        fs.renameSync(this.filePath, aside);
      } catch (e) {
        // keep going with defaults either way
      }
      this.setAside = aside;
      return this.fresh();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const json = JSON.stringify(this.data, null, 2);
    const body = this.codec ? `${ENC_MARKER}${this.codec.encrypt(json)}\n` : json;
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  reset() {
    this.data = this.fresh();
    this.save();
  }
}

module.exports = { JsonStore, ENC_MARKER };
