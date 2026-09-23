import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageCode } from '../js/speech.js';

test('language names and codes both give a code', () => {
  assert.equal(languageCode('Vietnamese'), 'vi');
  assert.equal(languageCode('  spanish '), 'es');
  assert.equal(languageCode('pt-BR'), 'pt-BR');
  assert.equal(languageCode('vi'), 'vi');
  assert.equal(languageCode('Old English'), '');
  assert.equal(languageCode(''), '');
});
