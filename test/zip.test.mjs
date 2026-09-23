import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { crc32, makeZip, readZip } from '../js/zip.js';
import { dataPath } from '../js/storage.js';

const text = (bytes) => new TextDecoder().decode(bytes);

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('a zip it writes reads back byte for byte', async () => {
  const wav = new Uint8Array(1000).map((_, i) => i % 256);
  const zip = await makeZip([
    { path: 'settings.json', data: '{"a":1}\n' },
    { path: 'decks/lời đề nghị.json', data: '[]\n' },
    { path: 'audio/d_1.wav', data: new Blob([wav]) },
  ]);
  const back = await readZip(zip);
  assert.deepEqual(back.map((e) => e.path), ['settings.json', 'decks/lời đề nghị.json', 'audio/d_1.wav']);
  assert.equal(text(back[0].bytes), '{"a":1}\n');
  assert.deepEqual(back[2].bytes, wav);
});

/* What an OS re-zip looks like: deflated, nested in a folder, with a
   directory entry. */
function deflatedZip(path, content) {
  const name = Buffer.from(path);
  const raw = Buffer.from(content);
  const comp = deflateRawSync(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(raw), 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const dirName = Buffer.from('backup/');
  const dirLocal = Buffer.alloc(30);
  dirLocal.writeUInt32LE(0x04034b50, 0);
  dirLocal.writeUInt16LE(dirName.length, 26);

  const central = (n, method, crc, c, u, off) => {
    const e = Buffer.alloc(46);
    e.writeUInt32LE(0x02014b50, 0);
    e.writeUInt16LE(method, 10);
    e.writeUInt32LE(crc, 16);
    e.writeUInt32LE(c, 20);
    e.writeUInt32LE(u, 24);
    e.writeUInt16LE(n.length, 28);
    e.writeUInt32LE(off, 42);
    return Buffer.concat([e, n]);
  };
  const body = Buffer.concat([dirLocal, dirName, local, name, comp]);
  const cd = Buffer.concat([
    central(dirName, 0, 0, 0, 0, 0),
    central(name, 8, crc32(raw), comp.length, raw.length, 30 + dirName.length),
  ]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(body.length, 16);
  return new Uint8Array(Buffer.concat([body, cd, end]));
}

test('reads deflated entries and skips directories', async () => {
  const content = '[{"front":"rành","back":"to know well"}]\n'.repeat(20);
  const back = await readZip(deflatedZip('backup/decks/default.json', content));
  assert.equal(back.length, 1);
  assert.equal(back[0].path, 'backup/decks/default.json');
  assert.equal(text(back[0].bytes), content);
});

test('refuses something that is not a zip', async () => {
  await assert.rejects(readZip(new Uint8Array(100)), /Not a zip/);
});

test('dataPath maps backups onto the folder layout and nothing else', () => {
  assert.equal(dataPath('settings.json'), 'settings.json');
  assert.equal(dataPath('backup/decks/default.json'), 'decks/default.json');
  assert.equal(dataPath('a/b/audio/d_20260923_0001.wav'), 'audio/d_20260923_0001.wav');
  assert.equal(dataPath('audio/manifest.json'), 'audio/manifest.json');
  assert.equal(dataPath('__MACOSX/decks/._default.json'), null);
  assert.equal(dataPath('.git/config'), null);
  assert.equal(dataPath('ux/decks/._lời.json'), null);
  assert.equal(dataPath('ux/._settings.json'), null);
  assert.equal(dataPath('README.md'), null);
  assert.equal(dataPath('decks/nested/x.json'), null);
  assert.equal(dataPath('audio/clip.mp3'), null);
});
