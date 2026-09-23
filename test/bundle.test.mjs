import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeBundle, serializeBundle, parseBundle, describeBundle, bundleFilename, BUNDLE_VERSION,
} from '../js/bundle.js';
import { normalizeCard, serializeDeck } from '../js/deck.js';

const cards = (...fronts) => fronts.map((front) => normalizeCard({ front, back: 'en ' + front }));

const sample = () => makeBundle({
  settings: { targetLanguage: 'Vietnamese', practiceDecks: ['verbs'] },
  decks: [['default', cards('một', 'hai')], ['verbs', cards('đi')]],
  now: new Date('2026-09-23T09:15:00.000Z'),
});

test('a bundle survives the round trip with its decks in order', () => {
  const { bundle, error } = parseBundle(serializeBundle(sample()));
  assert.equal(error, undefined);
  assert.equal(bundle.version, BUNDLE_VERSION);
  assert.equal(bundle.exported, '2026-09-23T09:15:00.000Z');
  assert.deepEqual(bundle.decks.map(([name]) => name), ['default', 'verbs']);
  assert.deepEqual(bundle.decks[0][1].map((c) => c.front), ['một', 'hai']);
  assert.equal(bundle.settings.targetLanguage, 'Vietnamese');
});

test('cards come back exactly as their own deck file would hold them', () => {
  const deck = cards('một', 'hai');
  deck[0].score = 4;
  deck[0].recent = [true, false, true];
  deck[0].last_seen = '2026-09-01';
  deck[0].mnemonic = 'mine to keep';
  const { bundle } = parseBundle(serializeBundle(makeBundle({ decks: [['d', deck]] })));
  assert.equal(serializeDeck(bundle.decks[0][1]), serializeDeck(deck));
  assert.equal(bundle.decks[0][1][0].mnemonic, 'mine to keep');
});

test('the API key is not in a bundle, whatever the settings hold', () => {
  const text = serializeBundle(makeBundle({
    settings: { targetLanguage: 'Vietnamese' },
    decks: [['d', cards('một')]],
  }));
  assert.equal(text.includes('apiKey'), false);
  assert.equal(text.includes('AIza'), false);
});

test('a card history stays on one line, as in a deck file', () => {
  const deck = cards('một');
  deck[0].recent = [true, false, true, true];
  const text = serializeBundle(makeBundle({ decks: [['d', deck]] }));
  assert.match(text, /"recent": \[true, false, true, true\]/);
});

test('a single deck file is refused by name, not by a generic complaint', () => {
  const { error } = parseBundle(serializeDeck(cards('một')));
  assert.match(error, /single deck/);
  assert.match(error, /Flashcards/);
});

test('junk, and the wrong shapes, are refused', () => {
  assert.match(parseBundle('not json at all').error, /not valid JSON/);
  assert.match(parseBundle('"a string"').error, /JSON object/);
  assert.match(parseBundle('{"decks": []}').error, /not a set of named decks/);
  assert.match(parseBundle('{"decks": {"d": {}}}').error, /not a list of cards/);
  assert.match(parseBundle('{"decks": {}, "settings": []}').error, /not an object/);
  assert.match(parseBundle('{}').error, /no decks and no settings/);
});

test('a malformed card is refused with its deck and its position named', () => {
  const { error } = parseBundle(JSON.stringify({
    decks: { verbs: [{ front: 'đi', back: 'to go' }, { front: 'no back' }] },
  }));
  assert.match(error, /"verbs"/);
  assert.match(error, /card 2/i);
});

test('a bundle from a newer format is refused rather than half read', () => {
  const { error } = parseBundle(JSON.stringify({
    bundle: BUNDLE_VERSION + 1,
    decks: { d: [{ front: 'a', back: 'b' }] },
  }));
  assert.match(error, /newer version/);
});

test('a settings-only bundle is legitimate', () => {
  const { bundle, error } = parseBundle(JSON.stringify({ settings: { targetLanguage: 'Thai' } }));
  assert.equal(error, undefined);
  assert.deepEqual(bundle.decks, []);
  assert.equal(bundle.settings.targetLanguage, 'Thai');
});

test('a version-less bundle is still read, so hand-written ones work', () => {
  const { bundle, error } = parseBundle(JSON.stringify({ decks: { d: [{ front: 'a', back: 'b' }] } }));
  assert.equal(error, undefined);
  assert.equal(bundle.version, null);
  assert.equal(bundle.decks[0][1][0].score, 1);
});

test('describeBundle says what is about to be imported', () => {
  const { bundle } = parseBundle(serializeBundle(sample()));
  assert.equal(describeBundle(bundle), '2 decks (3 cards), settings for Vietnamese, exported 2026-09-23');
});

test('describeBundle keeps its grammar for one of each', () => {
  const { bundle } = parseBundle(serializeBundle(makeBundle({ decks: [['d', cards('một')]] })));
  assert.equal(describeBundle(bundle).startsWith('1 deck (1 card)'), true);
});

test('the filename carries the day it was made', () => {
  assert.equal(bundleFilename(new Date('2026-09-23T23:59:00.000Z')), 'language-study-2026-09-23.json');
});

/* Written as text rather than through an object literal on purpose: in a
   literal, __proto__ sets the prototype and never becomes a key, so the danger
   only exists in JSON that arrived as JSON. */
test('decks named constructor and __proto__ are read as names, not as plumbing', () => {
  const text = '{"decks": {"constructor": [{"front": "a", "back": "b"}],'
    + ' "__proto__": [{"front": "c", "back": "d"}]}}';
  const { bundle, error } = parseBundle(text);
  assert.equal(error, undefined);
  assert.deepEqual(bundle.decks.map(([name]) => name).sort(), ['__proto__', 'constructor']);
  assert.equal(bundle.decks.length, 2);
  /* The pair list is why: nothing was ever keyed by a name a bundle chose. */
  assert.equal(Object.getPrototypeOf(bundle), Object.prototype);
  assert.equal(({}).c, undefined);
});
