/* Deck format, scoring, and card selection.

   A deck file is a top-level JSON array of cards — exactly what the Flashcards
   textarea shows, so the file is the UI and there is nothing hidden.

     front      the word or phrase in the language being learnt
     back       its meaning
     notes      optional: an example sentence, a usage note, anything
     score      1..5, recomputed from recent[] after every answer
     recent     the last 8 results, oldest first
     last_seen  ISO date of the last answer

   encounters and correct are derived from recent[] on demand and never
   stored: a rolling window of 8 is the only history kept, so a second copy of
   the same numbers could only ever drift out of step with it. */

import { words } from './text.js';

export const WINDOW = 8;
export const SCORE_LABEL = ['', 'Very weak', 'Weak', 'Developing', 'Good', 'Mastered'];

export function stats(card) {
  const recent = Array.isArray(card && card.recent) ? card.recent : [];
  const encounters = recent.length;
  const correct = recent.filter(Boolean).length;
  return { encounters, correct, accuracy: encounters ? correct / encounters : 0 };
}

/* The one implementation of the scoring rules. Both practice modes call it;
   nothing else may reimplement it. */
export function recordResult(card, ok) {
  const before = card.score;
  card.recent = Array.isArray(card.recent) ? card.recent : [];
  card.recent.push(!!ok);
  while (card.recent.length > WINDOW) card.recent.shift();

  const { encounters, correct, accuracy } = stats(card);
  if (accuracy <= 0.20) card.score = 1;
  else if (accuracy <= 0.40) card.score = 2;
  else if (accuracy <= 0.60) card.score = 3;
  else if (accuracy <= 0.80) card.score = 4;
  else card.score = 5;

  /* Probation: a card answered a handful of times cannot be called Good or
     Mastered on the strength of a short streak. It has to survive a full
     window first. */
  if (encounters < WINDOW && card.score > 2) card.score = 2;

  card.last_seen = today();
  return { before, after: card.score, encounters, correct };
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/* Weighted draw, without replacement. A score-1 card is 25x likelier than a
   score-5 one, which is what keeps practice on the weak material. */
export function pickWeighted(pool, n = 1) {
  const rest = pool.slice();
  const out = [];
  while (out.length < n && rest.length) {
    const weights = rest.map((c) => (6 - (c.score || 1)) ** 2);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let idx = rest.length - 1;
    for (let i = 0; i < rest.length; i++) {
      r -= weights[i];
      if (r <= 0) { idx = i; break; }
    }
    out.push(rest.splice(idx, 1)[0]);
  }
  return out;
}

export function inScope(card, scope) {
  if (scope === 'weak') return (card.score || 1) <= 2;
  if (scope === 'developing') return (card.score || 1) <= 3;
  return true;
}

/* Can this card be a dictation target?

   The question is "could this be heard and matched word for word?", which is
   not the same as "could this be typed from a prompt". Grammar notes and usage
   entries are perfectly good dictation targets even though they make poor
   typing cards, and that is where the weak scores tend to live. What is
   excluded is anything with no single matchable string: comparisons, slashed
   alternatives, ellipsed patterns, and placeholder formulas. */
export function isDictatable(card) {
  const t = String((card && card.front) || '');
  if (!t) return false;
  if (/\svs\.?\s/i.test(t)) return false;
  if (t.includes('/') || t.includes('…') || t.includes('...') || t.includes('+')) return false;
  const core = words(t.replace(/\([^)]*\)/g, ' '));
  return core.length >= 1 && core.length <= 6;
}

const KNOWN_KEYS = new Set(['front', 'back', 'notes', 'score', 'recent', 'last_seen']);

/* Fill in what a hand-written card leaves out, so bare front/back pairs pasted
   into the textarea work without ceremony.

   Fields this app does not know about are carried through untouched. The deck
   file is something people edit by hand, and quietly deleting a `type`, a tag
   or a source note because it is not in our schema would be a rotten thing for
   a save to do. */
export function normalizeCard(raw) {
  const card = {
    front: String((raw && raw.front) || '').trim(),
    back: String((raw && raw.back) || '').trim(),
  };
  if (raw && raw.notes) card.notes = String(raw.notes);
  const score = Number(raw && raw.score);
  card.score = Number.isFinite(score) && score >= 1 && score <= 5 ? Math.round(score) : 1;
  card.recent = Array.isArray(raw && raw.recent)
    ? raw.recent.slice(-WINDOW).map(Boolean) : [];
  card.last_seen = (raw && raw.last_seen) || null;

  for (const key of Object.keys(raw || {})) {
    if (KNOWN_KEYS.has(key) || key === '__proto__') continue;
    card[key] = raw[key];
  }
  return card;
}

/* Parse the textarea. Returns {cards} or {error} with a line number, never
   throws — the Flashcards tab shows the error and keeps the text as typed. */
export function parseDeck(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: jsonErrorAt(e, text) };
  }
  if (!Array.isArray(data)) {
    return { error: 'The deck must be a JSON array of cards, starting with [ and ending with ].' };
  }
  const bad = data.findIndex((c) => !c || typeof c !== 'object' || Array.isArray(c));
  if (bad >= 0) return { error: `Card ${bad + 1} is not an object.` };
  const missing = data.findIndex((c) => !String(c.front || '').trim() || !String(c.back || '').trim());
  if (missing >= 0) return { error: `Card ${missing + 1} needs both a front and a back.` };
  return { cards: data.map(normalizeCard) };
}

/* Turn whatever the engine says into "what went wrong, and where".

   V8 has two message shapes and neither is usable as it stands: one carries a
   character offset, the other quotes the offending source instead. Both are
   handled, because a deck of three hundred cards is unfixable without a line
   number. */
function jsonErrorAt(err, text) {
  const msg = String((err && err.message) || 'Invalid JSON');

  const lineCol = /line (\d+) column (\d+)/.exec(msg);
  if (lineCol) return `${tidy(msg)} — line ${lineCol[1]}, column ${lineCol[2]}`;

  const position = /position (\d+)/.exec(msg);
  if (position) return `${tidy(msg)} — ${at(text, Number(position[1]))}`;

  const quoted = /\.\.\.?"([\s\S]*)" is not valid JSON/.exec(msg);
  if (quoted) {
    const found = text.indexOf(quoted[1].slice(0, 24));
    if (found >= 0) return `${tidy(msg)} — ${at(text, found)}`;
  }
  return tidy(msg);
}

function at(text, pos) {
  const upto = text.slice(0, pos);
  return `line ${upto.split('\n').length}, column ${pos - upto.lastIndexOf('\n')}`;
}

/* Strip the engine's own location and source quoting; we are about to add
   better versions of both. */
function tidy(msg) {
  return msg
    .replace(/\s+in JSON at position[\s\S]*$/, '')
    .replace(/,?\s*\.\.\.?"[\s\S]*" is not valid JSON$/, '')
    .replace(/\s+is not valid JSON$/, '')
    .trim();
}

/* Written back exactly as the textarea shows it. Keys go out in a fixed order
   so saving a deck does not reshuffle a file the user is reading. */
export function serializeDeck(cards) {
  const out = cards.map((c) => {
    const o = { front: c.front, back: c.back };
    if (c.notes) o.notes = c.notes;
    o.score = c.score;
    o.recent = c.recent;
    if (c.last_seen) o.last_seen = c.last_seen;
    /* Anything the user added themselves goes out last, so the keys this app
       writes stay in a predictable order above it. */
    for (const key of Object.keys(c)) {
      if (!KNOWN_KEYS.has(key)) o[key] = c[key];
    }
    return o;
  });
  /* JSON.stringify puts every array element on its own line, which would give
     each card eight lines of true/false and bury the words. The history is
     booleans only, so it can be safely folded back onto one line — and a deck
     of three hundred cards stays something a person can scroll. */
  return JSON.stringify(out, null, 2)
    .replace(/"recent": \[[^\]]*\]/g, (m) => m.replace(/\s+/g, ' ').replace('[ ', '[').replace(' ]', ']'))
    + '\n';
}

/* Convert a watchlist.json from the CLI study system into a deck. Purely a
   client-side transform on pasted text. */
export function importWatchlist(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: jsonErrorAt(e, text) };
  }
  const items = Array.isArray(data) ? data : (data && data.items);
  if (!Array.isArray(items)) return { error: 'Expected a watchlist with an items array.' };
  const cards = items
    .filter((it) => it && it.term)
    .map((it) => normalizeCard({
      front: it.term,
      back: it.english || '',
      notes: it.notes || '',
      score: it.score,
      recent: it.recent_results,
      last_seen: it.last_seen,
    }))
    .filter((c) => c.front && c.back);
  if (!cards.length) return { error: 'No items with both a term and an English meaning.' };
  return { cards };
}

/* A file someone opened: a deck, or failing that a watchlist. The deck's own
   error is the one reported, since a deck is what most files will be. */
export function readDeckFile(text) {
  const deck = parseDeck(text);
  if (!deck.error) return { cards: deck.cards, format: 'deck' };
  const watchlist = importWatchlist(text);
  if (!watchlist.error) return { cards: watchlist.cards, format: 'watchlist' };
  return { error: deck.error };
}

export function slugify(name) {
  const s = String(name || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'deck';
}
