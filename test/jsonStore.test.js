'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonStore, ENC_MARKER } = require('../lib/jsonStore');

// stand-in for Electron safeStorage: reversible, but not plain JSON on disk
const codec = {
  encrypt: (s) => Buffer.from(s).reverse().toString('base64'),
  decrypt: (b) => Buffer.from(b, 'base64').reverse().toString(),
};

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcw-store-'));
  return path.join(dir, 'data.json');
}

test('encrypted store round-trips and does not leave plain text on disk', () => {
  const file = tmpFile();
  const s = new JsonStore(file, { events: [] }, codec);
  s.data.events.push({ title: '비밀 회의' });
  s.save();
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.startsWith(ENC_MARKER));
  assert.ok(!raw.includes('비밀 회의'));
  assert.equal(new JsonStore(file, { events: [] }, codec).data.events[0].title, '비밀 회의');
});

test('plain file from an older version is read, then encrypted on save', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ events: [{ title: 'old' }] }));
  const s = new JsonStore(file, { events: [], candidates: [] }, codec);
  assert.equal(s.data.events[0].title, 'old');
  assert.deepEqual(s.data.candidates, []);
  s.save();
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(ENC_MARKER));
});

test('undecryptable file is set aside instead of overwritten', () => {
  const file = tmpFile();
  fs.writeFileSync(file, `${ENC_MARKER}not-valid\n`);
  const s = new JsonStore(file, { events: [] }, { encrypt: codec.encrypt, decrypt: () => { throw new Error('no key'); } });
  assert.deepEqual(s.data, { events: [] });
  assert.ok(s.setAside && fs.existsSync(s.setAside));
  assert.ok(!fs.existsSync(file));
});
