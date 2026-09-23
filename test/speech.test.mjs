import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageCode, clampRate, rateLabel } from '../js/speech.js';

test('language names and codes both give a code', () => {
  assert.equal(languageCode('Vietnamese'), 'vi');
  assert.equal(languageCode('  spanish '), 'es');
  assert.equal(languageCode('pt-BR'), 'pt-BR');
  assert.equal(languageCode('vi'), 'vi');
  assert.equal(languageCode('Old English'), '');
  assert.equal(languageCode(''), '');
});

test('speaking speed is kept in range, on its step, and labelled plainly', () => {
  assert.equal(clampRate(0.8), 0.8);
  assert.equal(clampRate(0.1), 0.5);
  assert.equal(clampRate(9), 1.5);
  assert.equal(clampRate('0.83'), 0.85);
  assert.equal(clampRate(undefined), 1);
  assert.equal(rateLabel(1), '1×');
  assert.equal(rateLabel(0.85), '0.85×');
});
