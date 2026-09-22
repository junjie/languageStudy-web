import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, words, base, contains, diff, compareAnswer, accentMarks } from '../js/text.js';

test('normalize keeps diacritics but drops case and punctuation', () => {
  assert.equal(normalize('  Tôi KHÔNG rành, đường!  '), 'tôi không rành đường');
  assert.equal(normalize('“quoted” — dashed'), 'quoted dashed');
  assert.deepEqual(words(''), []);
});

test('base strips diacritics across languages', () => {
  assert.equal(base('rành'), 'ranh');
  assert.equal(base('đường'), 'duong');
  assert.equal(base('Corazón'), 'corazon');
  assert.equal(base('Grüße'), 'grüße'.normalize('NFD').replace(/[̀-ͯ]/g, ''));
  assert.equal(base('für'), 'fur');
});

test('contains matches a whole phrase verbatim and ignores parentheticals', () => {
  const w = words('Tôi phải đóng học phí trước ngày mai.');
  assert.equal(contains(w, 'đóng (học phí)'), true);
  assert.equal(contains(w, 'đóng học phí'), true);
  assert.equal(contains(w, 'dong hoc phi'), false, 'accents must match');
  assert.equal(contains(w, 'học đóng'), false, 'order matters');
  assert.equal(contains(w, ''), false);
});

test('an accent slip is one wrong-accent word, not a missing plus an extra', () => {
  const d = diff(words('tôi không rành đường'), words('tôi khong rành đường'));
  assert.equal(d.accent, 1);
  assert.equal(d.missing, 0);
  assert.equal(d.extra, 0);
  assert.equal(d.ok, 3);
  assert.deepEqual(d.tokens.map((t) => t.kind), ['ok', 'accent', 'ok', 'ok']);
});

test('a dropped word is exactly one missing', () => {
  const d = diff(words('một hai ba bốn'), words('một hai bốn'));
  assert.equal(d.missing, 1);
  assert.equal(d.extra, 0);
  assert.equal(d.tokens.find((t) => t.kind === 'missing').text, 'ba');
});

test('an invented word is exactly one extra', () => {
  const d = diff(words('một hai ba'), words('một hai xyz ba'));
  assert.equal(d.extra, 1);
  assert.equal(d.missing, 0);
  assert.equal(d.ok, 3);
});

test('diff of identical input is all ok', () => {
  const d = diff(words('một hai ba'), words('Một, hai ba!'));
  assert.equal(d.ok, 3);
  assert.equal(d.accent + d.missing + d.extra, 0);
});

test('empty transcription marks every word missing', () => {
  const d = diff(words('một hai ba'), words(''));
  assert.equal(d.missing, 3);
  assert.equal(d.ok, 0);
});

test('compareAnswer separates a wrong word from wrong accents', () => {
  assert.equal(compareAnswer('cải tiến', 'Cải Tiến'), 'exact');
  assert.equal(compareAnswer('cai tien', 'cải tiến'), 'accent');
  assert.equal(compareAnswer('tận hưởng', 'cải tiến'), 'wrong');
  assert.equal(compareAnswer('', 'cải tiến'), 'wrong');
});

test('accentMarks flags only the characters that differ', () => {
  const marks = accentMarks('cai tien', 'cải tiến');
  assert.equal(marks.length, 8);
  assert.deepEqual(marks.filter((m) => m.bad).map((m) => m.ch), ['a', 'e']);
});
